/**
 * Depot worker: job handlers on queue ``depot`` plus a scheduler tick that, once
 * per IST business day, snapshots FX, runs settlements and then reconciles.
 */
import { type Clock, type Db, enqueue, istDate, JobRegistry, log, type Settings, systemClock } from "@mintrail/shared";
import { DEPOT_QUEUE, JOB_DEPOT_BANK_CREDIT, JOB_DEPOT_FX, JOB_DEPOT_RECONCILE, JOB_DEPOT_RUN } from "@mintrail/api";

import { SettlementEngine } from "./engine.js";
import { type FxFeed, snapshotFor } from "./fx.js";
import { reconcile } from "./reconcile.js";
import { runSettlements } from "./run.js";

export function buildRegistry(db: Db, settings: Settings, fx: FxFeed, clock: Clock = systemClock): JobRegistry {
  return new JobRegistry()
    .register(JOB_DEPOT_FX, async (tx, job) => {
      await snapshotFor(tx, fx, "USD", "INR", String(job.payload.date ?? istDate(clock.now())), clock);
    })
    .register(JOB_DEPOT_RUN, async (tx, job) => {
      // The run commits per batch on its own connections; this job only records that it ran.
      const date = String(job.payload.date ?? istDate(clock.now()));
      await runSettlements(db, settings, fx, date, clock);
      await enqueue(tx, JOB_DEPOT_RECONCILE, { after_run: date }, { queue: DEPOT_QUEUE, dedupeKey: `depot:reconcile:${date}` });
    })
    .register(JOB_DEPOT_BANK_CREDIT, async (tx, job) => {
      await new SettlementEngine(tx, settings, fx, clock).bankCredit(String(job.payload.settlement_id));
    })
    .register(JOB_DEPOT_RECONCILE, async (tx) => {
      const [report, mismatches] = await reconcile(tx, clock);
      if (mismatches.length)
        log.error(
          { derailment: "reconciliation_mismatch", report_id: report.id, mismatches: mismatches.length },
          "DERAILMENT: reconciliation found mismatches",
        );
      else log.info({ report_id: report.id }, "reconciliation ok");
    });
}

/** Enqueue today's FX snapshot and settlement run (deduplicated per date). */
export async function scheduleDaily(db: Db, clock: Clock = systemClock): Promise<string> {
  const date = istDate(clock.now());
  await db.transaction(async (tx) => {
    await enqueue(tx, JOB_DEPOT_FX, { date }, { queue: DEPOT_QUEUE, dedupeKey: `depot:fx:${date}` });
    await enqueue(tx, JOB_DEPOT_RUN, { date }, { queue: DEPOT_QUEUE, dedupeKey: `depot:run:${date}` });
  });
  return date;
}
