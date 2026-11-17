/** A settlement run for one business date: every (station, mode, currency), each in its own transaction. */
import { type Clock, type Currency, type Db, log, type Settings, systemClock } from "@mintrail/shared";
import type { Settlement } from "@mintrail/api";

import { SettlementEngine } from "./engine.js";
import type { FxFeed } from "./fx.js";

export interface RunSummary {
  date: string;
  created: number;
  skipped: number;
  failed: number;
  settlements: Settlement[];
}

export async function runSettlements(
  db: Db,
  settings: Settings,
  fx: FxFeed,
  date: string,
  clock: Clock = systemClock,
): Promise<RunSummary> {
  const accounts = await new SettlementEngine(db, settings, fx, clock).accounts();
  const summary: RunSummary = { date, created: 0, skipped: 0, failed: 0, settlements: [] };
  for (const a of accounts) {
    try {
      const r = await db.transaction((tx) =>
        new SettlementEngine(tx, settings, fx, clock).settle(a.stationId, a.livemode, a.currency as Currency, date),
      );
      if (r.created && r.settlement) {
        summary.created += 1;
        summary.settlements.push(r.settlement);
      } else summary.skipped += 1;
    } catch (e) {
      summary.failed += 1;
      log.error(
        { err: (e as Error).message, station_id: a.stationId, livemode: a.livemode, currency: a.currency, date },
        "settlement batch failed",
      );
    }
  }
  log.info({ date, created: summary.created, skipped: summary.skipped, failed: summary.failed }, "settlement run finished");
  return summary;
}
