/** Depot end to end over real Platform flows: batches, cutoffs, reserves, chargebacks, FX, bank credit, reconciliation. */
import { eq, sql } from "drizzle-orm";
import fc from "fast-check";
import request from "supertest";
import { describe, expect, test } from "vitest";

import { DEPOT_QUEUE, settlementEntries, settlements } from "@mintrail/api";
import type { Merchant } from "@mintrail/api/testing";
import { addDays, FrozenClock, istDate, Worker } from "@mintrail/shared";

import { createDepotApp } from "../src/app.js";
import { SettlementEngine, totals, type Entry } from "../src/engine.js";
import type { FxFeed } from "../src/fx.js";
import { reconcile } from "../src/reconcile.js";
import { runSettlements } from "../src/run.js";
import { buildRegistry, scheduleDaily } from "../src/worker.js";
import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();
const fx: FxFeed = { rate: async () => ({ rate: "83.2500", source: "test" }) };
const today = () => istDate(new Date());
const settleDate = (days = 2) => addDays(today(), days);
const run = (date = settleDate()) => runSettlements(db(), h().settings, fx, date);
const credit = async () => {
  const w = new Worker(db(), buildRegistry(db(), h().settings, fx), { queues: [DEPOT_QUEUE], workerId: "test-depot" });
  while (await w.runDue());
};
/** Net of a captured payment (harness responses are untyped JSON with bigint amounts). */
const netOf = (p: { amount: bigint; fee: bigint; tax: bigint }): bigint => p.amount - p.fee - p.tax;
const forStation = async (m: Merchant) => db().select().from(settlements).where(eq(settlements.stationId, m.stationId));
const entriesOf = async (id: string) => db().select().from(settlementEntries).where(eq(settlementEntries.settlementId, id));

describe("settlement batches", () => {
  test("T+2: captured payments net of fee + GST, refunds and payouts deducted; bank credit; reconciliation ok", async () => {
    const m = await h().merchant();
    const a = await h().paid(m, "card", { amount: 100_000n });
    const b = await h().paid(m, "upi", { amount: 200_000n });
    await h().call(m, "POST", `/v1/payments/${a.id}/refunds`, { amount: 30_000n });
    await h().call(m, "POST", "/v1/payouts", {
      amount: 20_000n,
      mode: "IMPS",
      beneficiary: { name: "Supplier Co", account_number: "123456789012", ifsc: "HDFC0001234" },
    });
    await h().drainAll();

    // Not yet due: T+2 batch for tomorrow has an earlier cutoff.
    expect((await run(settleDate(1))).created).toBe(0);
    const summary = await run();
    expect(summary.created).toBe(1);
    const [s] = await forStation(m);
    const netA = netOf(a);
    const netB = netOf(b);
    expect(s!.amount).toBe(netA + netB - 30_000n - 20_000n);
    expect(s!.amount).toBe(s!.gross - s!.fees - s!.tax);
    expect([s!.status, s!.schedule, s!.payoutCurrency]).toEqual(["processing", "T+2", "INR"]);
    expect((await entriesOf(s!.id)).map((e) => e.kind).sort()).toEqual(["payment", "payment", "payout", "refund"]);

    await credit();
    const settled = (await h().call(m, "GET", `/v1/settlements/${s!.id}`)).body;
    expect(settled.status).toBe("processed");
    expect(settled.utr).toMatch(/^MRSTL\d{15}$/);
    expect((await h().call(m, "GET", "/v1/events?type=settlement.processed")).body.data).toHaveLength(1);
    const csv = await h().call(m, "GET", `/v1/settlements/${s!.id}/report`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.split("\r\n")[0]).toBe(
      "settlement_id,settlement_date,entry_type,reference_id,occurred_at,currency,gross,fee,gst,net,release_on",
    );
    expect(csv.text).toContain(`${a.id}`);

    // Idempotent per date; nothing new to settle the day after.
    expect((await run()).created).toBe(0);
    expect((await run(settleDate(3))).created).toBe(0);
    const [report, mismatches] = await db().transaction((tx) => reconcile(tx));
    expect(mismatches).toEqual([]);
    expect([report.status, report.settlementsChecked]).toEqual(["ok", 1]);
  });

  test("rolling reserve: held from the batch, released on the release date", async () => {
    const m = await h().merchant();
    expect(
      (await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/policy`, { reserve_bps: 1000, reserve_hold_days: 7 })).status,
    ).toBe(200);
    const p = await h().paid(m, "upi", { amount: 100_000n });
    await run();
    const [s1] = await forStation(m);
    const net = netOf(p);
    const hold = (net * 1000n + 5_000n) / 10_000n;
    expect(s1!.amount).toBe(net - hold);
    const holdEntry = (await entriesOf(s1!.id)).find((e) => e.kind === "reserve_hold")!;
    expect([holdEntry.amount, holdEntry.releaseOn]).toEqual([-hold, addDays(settleDate(), 7)]);
    await h().paid(m, "upi", { amount: 10_000n }); // so there is a batch on the release date
    expect((await run(addDays(settleDate(), 6))).created).toBe(1);
    const released = await run(addDays(settleDate(), 7));
    const relEntries = released.settlements.length ? await entriesOf(released.settlements[0]!.id) : [];
    const before = await forStation(m);
    const all = (await Promise.all(before.map((x) => entriesOf(x.id)))).flat();
    expect(all.filter((e) => e.kind === "reserve_release").map((e) => e.amount)).toEqual([hold]);
    expect(relEntries.length + all.length).toBeGreaterThan(0);
    expect((await db().transaction((tx) => reconcile(tx)))[1]).toEqual([]);
  });

  test("chargebacks: an open dispute is recovered from the next settlement; a later win is released back", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card", { amount: 100_000n });
    await h().call(m, "POST", `/v1/payments/${p.id}/simulate_dispute`, { amount: 40_000n, outcome: "win" });
    await h().drainAll();
    await run();
    const [s] = await forStation(m);
    const kinds = await entriesOf(s!.id);
    expect(kinds.find((e) => e.kind === "dispute_recovery")!.amount).toBe(-40_000n);
    expect(s!.amount).toBe(netOf(p) - 40_000n);
    const d = (await h().call(m, "GET", `/v1/disputes?payment_id=${p.id}`)).body.data[0];
    await fetch(`${h().platformUrl}/v1/disputes/${d.id}/evidence`, {
      method: "POST",
      headers: { Authorization: `Bearer ${m.secret}` },
      body: (() => {
        const f = new FormData();
        f.append("text", "Customer received the goods; tracking attached in our portal.");
        return f;
      })(),
    });
    await h().call(m, "POST", `/v1/disputes/${d.id}/submit`);
    await h().drainAll();
    const r2 = await run(settleDate(3));
    const e2 = await entriesOf(r2.settlements[0]!.id);
    expect(e2.map((e) => [e.kind, e.amount])).toEqual([["dispute_release", 40_000n]]);
    expect((await db().transaction((tx) => reconcile(tx)))[1]).toEqual([]);
  });

  test("USD balances settle in INR at the day's stored FX snapshot (half-even)", async () => {
    const m = await h().merchant();
    const o = (await h().call(m, "POST", "/v1/orders", { amount: 12_345n, currency: "USD" })).body;
    await h().pay(m, o.id, "card");
    await h().drainAll();
    const p = (await h().call(m, "GET", `/v1/orders/${o.id}/payments`)).body.data[0];
    expect(p.status).toBe("captured");
    const summary = await run();
    const usd = summary.settlements.find((x) => x.currency === "USD")!;
    expect(usd.amount).toBe(netOf(p));
    // 11,936 cents × 83.25 = 993,672 paise exactly
    expect([usd.payoutCurrency, usd.fxRate, usd.payoutAmount]).toEqual(["INR", "83.2500000000", (usd.amount * 8325n + 50n) / 100n]);
    const fxLatest = (await h().call(m, "GET", "/v1/fx_rates/latest")).body;
    expect([fxLatest.base, fxLatest.quote, fxLatest.rate]).toEqual(["USD", "INR", "83.2500000000"]);
    await credit();
    expect((await db().transaction((tx) => reconcile(tx)))[1]).toEqual([]);
  });

  test("reconciliation catches a tampered settlement", async () => {
    const m = await h().merchant();
    await h().paid(m, "card");
    await run();
    await db().execute(sql`ALTER TABLE settlements DROP CONSTRAINT ck_settlements_amount_identity`);
    try {
      await db().execute(sql`UPDATE settlements SET amount = amount + 1, gross = gross + 1`);
      const [report, mismatches] = await db().transaction((tx) => reconcile(tx));
      expect(report.status).toBe("mismatch");
      expect(new Set(mismatches.map((x) => x.check))).toEqual(new Set(["settlement_entries_sum", "settlement_ledger", "balance_identity"]));
    } finally {
      await db().execute(sql`UPDATE settlements SET amount = amount - 1, gross = gross - 1`);
      await db().execute(sql`ALTER TABLE settlements ADD CONSTRAINT ck_settlements_amount_identity CHECK (amount = gross - fees - tax)`);
    }
  });

  test("scheduler + worker: daily FX snapshot and run are enqueued once per IST day", async () => {
    const clock = new FrozenClock(new Date(Date.now() + 2 * 86_400_000));
    const m = await h().merchant();
    await h().paid(m, "upi");
    const date = await scheduleDaily(db(), clock);
    await scheduleDaily(db(), clock);
    const jobs = await db().execute<{ kind: string }>(sql`SELECT kind FROM jobs WHERE queue = 'depot' ORDER BY id`);
    expect(jobs.rows.map((r) => r.kind)).toEqual(["depot.snapshot_fx", "depot.run_settlements"]);
    const w = new Worker(db(), buildRegistry(db(), h().settings, fx, clock), { queues: [DEPOT_QUEUE], workerId: "sched", clock });
    for (let i = 0; i < 10 && (await w.runOnce()); i++);
    expect((await forStation(m)).map((s) => s.settlementDate)).toEqual([date]);
    const rec = await db().execute<{ status: string }>(sql`SELECT status FROM reconciliation_reports`);
    expect(rec.rows.map((r) => r.status)).toEqual(["ok"]);
  });

  test("depot API (supertest): run + reconcile + CSV, service token required", async () => {
    const app = createDepotApp({ ...h().settings, depot_api_key: "test-depot-key" }, db(), fx);
    const m = await h().merchant();
    await h().paid(m, "card");
    expect((await request(app).post("/internal/depot/v1/runs").send({ date: settleDate() })).status).toBe(401);
    const r = await request(app).post("/internal/depot/v1/runs").set("Authorization", "Bearer test-depot-key").send({ date: settleDate() });
    expect([r.status, r.body.created]).toEqual([201, 1]);
    const rec = await request(app).post("/internal/depot/v1/reconciliations").set("Authorization", "Bearer test-depot-key");
    expect([rec.body.status, rec.body.mismatch_count]).toEqual(["ok", 0]);
    const csv = await request(app)
      .get(`/internal/depot/v1/settlements/${r.body.settlements[0].id}/report.csv`)
      .set("Authorization", "Bearer test-depot-key");
    expect(csv.text).toContain("total");
    expect((await request(app).get("/healthz")).body.service).toBe("depot");
  });
});

describe("property: settlement amount = Σ entries = Σ gross − fees − GST", () => {
  const arbEntry = fc.record({
    gross: fc.bigInt({ min: -10_000_000n, max: 10_000_000n }),
    fee: fc.bigInt({ min: 0n, max: 100_000n }),
    tax: fc.bigInt({ min: 0n, max: 20_000n }),
  });
  test("totals()", () => {
    fc.assert(
      fc.property(fc.array(arbEntry, { maxLength: 50 }), (raw) => {
        const entries: Entry[] = raw.map((r, i) => ({
          kind: "payment",
          referenceId: `x${i}`,
          occurredAt: "",
          ...r,
          amount: r.gross - r.fee - r.tax,
        }));
        const t = totals(entries);
        return t.amount === t.gross - t.fees - t.tax && t.amount === entries.reduce((a, e) => a + e.amount, 0n);
      }),
    );
  });

  test("real batches over random payment/refund mixes reconcile to zero mismatches", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ amount: fc.bigInt({ min: 1_000n, max: 300_000n }), refund: fc.nat({ max: 100 }) }), {
          minLength: 1,
          maxLength: 4,
        }),
        async (plan) => {
          // Unique VPAs: Conductor's velocity rules would (rightly) block one instrument used dozens of times.
          const vpa = () => ({ scenario: "success", details: { upi: { vpa: `buyer${Math.random().toString(36).slice(2, 10)}@okaxis` } } });
          const m = await h().merchant();
          await h().paid(m, "upi", { amount: 900_000n, ...vpa() });
          for (const step of plan) {
            const p = await h().paid(m, "upi", { amount: step.amount, ...vpa() });
            const amt = (step.amount * BigInt(step.refund)) / 100n;
            if (amt > 0n) await h().call(m, "POST", `/v1/payments/${p.id}/refunds`, { amount: amt });
          }
          await h().drainAll();
          const s = (await run()).settlements.find((x) => x.stationId === m.stationId)!;
          const es = await entriesOf(s.id);
          expect(s.amount).toBe(es.reduce((a, e) => a + e.amount, 0n));
          expect(s.amount).toBe(s.gross - s.fees - s.tax);
          expect((await db().transaction((tx) => reconcile(tx)))[1]).toEqual([]);
        },
      ),
      { numRuns: 5 },
    );
  });
});

test("engine accounts() lists merchant balances only", async () => {
  const m = await h().merchant();
  const accts = await new SettlementEngine(db(), h().settings, fx).accounts();
  expect(accts).toContainEqual({ stationId: m.stationId, livemode: false, currency: "INR" });
});
