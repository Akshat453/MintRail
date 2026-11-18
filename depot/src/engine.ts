/**
 * Depot settlement engine (ADR-0014).
 *
 * One batch per (Station, mode, currency, business date D):
 *
 *   credits (enter after the T+N cutoff)          debits (deducted as soon as they happen)
 *   ─────────────────────────────────────         ───────────────────────────────────────
 *   captured payments  (net of fee + GST)         refunds (+ instant fee + GST)
 *   failed-refund reversals                       payouts
 *   failed/rejected/cancelled payout reversals    rolling-reserve hold (reserve_bps of payment net)
 *   reserve releases due by D                     dispute recovery (dispute_reserve owed, capped at net)
 *   dispute releases (won disputes already recovered)
 *
 *   cutoff = end of business day D − N  (``settlement_cutoff_hour_ist`` IST)
 *   amount = Σ entries = Σ gross − Σ fee − Σ GST       (> 0, or everything carries forward)
 *
 * Ledger: reserve and dispute sweeps move money between merchant_balance and the
 * Station's sub-accounts; ``settlement_initiated`` moves the net to
 * settlement_clearing (USD is converted to INR by treasury at the snapshot rate in the same
 * transaction); ``depot.bank_credit`` later posts
 * ``settlement_paid`` with a simulated UTR and emits ``settlement.processed``.
 */
import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import {
  addDays,
  businessDayEnd,
  type Clock,
  convert,
  type Currency,
  enqueue,
  IdPrefix,
  log,
  Money,
  newId,
  type Settings,
  systemClock,
  type Tx,
} from "@mintrail/shared";
import {
  DEPOT_QUEUE,
  getPolicy,
  JOB_DEPOT_BANK_CREDIT,
  type Settlement,
  settlementOut,
  settlements,
  settlementEntries,
  type EntryKind,
  stations,
  type Station,
} from "@mintrail/api";
import {
  GST_RATE_BPS,
  LedgerService,
  M2StationAccount,
  m2StationAccount,
  recordSettlementInitiated,
  recordSettlementInitiatedFx,
  recordSettlementPaid,
  recordStationTransfer,
  stationAccount,
} from "@mintrail/ledger";
import { emit } from "@mintrail/signal";

import { type FxFeed, snapshotFor } from "./fx.js";

export interface Entry {
  kind: EntryKind;
  referenceId: string;
  occurredAt: string;
  gross: bigint;
  fee: bigint;
  tax: bigint;
  amount: bigint;
  releaseOn?: string | null;
}

const entry = (
  kind: EntryKind,
  referenceId: string,
  occurredAt: string,
  gross: bigint,
  fee = 0n,
  tax = 0n,
  releaseOn: string | null = null,
): Entry => ({
  kind,
  referenceId,
  occurredAt,
  gross,
  fee,
  tax,
  amount: gross - fee - tax,
  releaseOn,
});

export const scheduleDays = (schedule: string): number => Number(schedule.replace("T+", ""));

/** Σ of a list of entries; ``amount`` always equals gross − fee − tax. */
export function totals(entries: Entry[]): { gross: bigint; fees: bigint; tax: bigint; amount: bigint } {
  const t = { gross: 0n, fees: 0n, tax: 0n, amount: 0n };
  for (const e of entries) {
    t.gross += e.gross;
    t.fees += e.fee;
    t.tax += e.tax;
    t.amount += e.amount;
  }
  return t;
}

/**
 * Settlement invoices above this many lines are issued as one consolidated tax
 * invoice: GST is charged on the invoice's total fee rather than line by line.
 */
export const CONSOLIDATED_INVOICE_LINES = 1_000;

export function consolidatedTotals(entries: Entry[], currency: Currency): { gross: bigint; fees: bigint; tax: bigint; amount: bigint } {
  const t = totals(entries);
  const tax = Money.of(t.fees, currency).applyBps(GST_RATE_BPS, "half_even").amount;
  return { gross: t.gross, fees: t.fees, tax, amount: t.gross - t.fees - tax };
}

export class SettlementEngine {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly fx: FxFeed,
    private readonly clock: Clock = systemClock,
  ) {}

  private ledger(): LedgerService {
    return new LedgerService(this.tx, this.clock);
  }

  /** Every (station, mode, currency) that has a merchant balance account. */
  async accounts(): Promise<{ stationId: string; livemode: boolean; currency: Currency }[]> {
    const r = await this.tx.execute<{ owner_id: string; livemode: boolean; currency: string }>(sql`
      SELECT owner_id, livemode, currency FROM ledger_accounts
       WHERE code LIKE 'station:%:merchant_balance:%' ORDER BY owner_id, livemode, currency`);
    return r.rows.map((x) => ({ stationId: x.owner_id, livemode: x.livemode, currency: x.currency as Currency }));
  }

  /** Gather the unsettled items for one batch (pure reads). */
  async collect(station: Station, livemode: boolean, currency: Currency, date: string): Promise<{ entries: Entry[]; cutoff: Date }> {
    const cutoff = businessDayEnd(addDays(date, -scheduleDays(station.settlementSchedule)), this.settings.settlement_cutoff_hour_ist);
    const asOf = this.clock.now();
    const c = cutoff.toISOString();
    const now = asOf.toISOString();
    const sid = station.id;
    const unsettled = (kind: string, col: string) =>
      sql.raw(`NOT EXISTS (SELECT 1 FROM settlement_entries e WHERE e.kind = '${kind}' AND e.reference_id = ${col})`);
    // Every batch takes *all* eligible items, so anything before the previous batch's cutoff /
    // run time is already settled. Scan only from there, with a 2-day overlap for transactions
    // that committed after the previous run with an earlier timestamp (NOT EXISTS dedupes).
    const [prev] = (
      await this.tx.execute<{ cutoff: string | null; ran: string | null }>(sql`
        SELECT max(cutoff_at) AS cutoff, max(created_at) AS ran FROM settlements
         WHERE station_id = ${sid} AND livemode = ${livemode} AND currency = ${currency}`)
    ).rows;
    const overlap = (v: string | null | undefined) =>
      v
        ? new Date(new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).getTime() - 2 * 86_400_000).toISOString()
        : "1970-01-01T00:00:00Z";
    const fromCutoff = overlap(prev?.cutoff);
    const fromRun = overlap(prev?.ran);

    const out: Entry[] = [];
    const pays = await this.tx.execute<{ id: string; at: string; amount: string; fee: string; tax: string }>(sql`
      SELECT p.id, p.captured_at AS at, p.amount::text, coalesce(p.fee, 0)::text AS fee, coalesce(p.tax, 0)::text AS tax
        FROM payments p
       WHERE p.station_id = ${sid} AND p.livemode = ${livemode} AND p.currency = ${currency}
         AND p.status = 'captured' AND p.captured_at >= ${fromCutoff} AND p.captured_at < ${c} AND ${unsettled("payment", "p.id")}
       ORDER BY p.id`);
    for (const p of pays.rows) out.push(entry("payment", p.id, p.at, BigInt(p.amount), BigInt(p.fee), BigInt(p.tax)));

    const rfs = await this.tx.execute<{ id: string; at: string; amount: string; fee: string; tax: string }>(sql`
      SELECT r.id, r.created_at AS at, r.amount::text, r.fee::text, r.tax::text FROM refunds r
       WHERE r.station_id = ${sid} AND r.livemode = ${livemode} AND r.currency = ${currency}
         AND r.created_at >= ${fromRun} AND r.created_at <= ${now} AND ${unsettled("refund", "r.id")} ORDER BY r.id`);
    for (const r of rfs.rows) out.push(entry("refund", r.id, r.at, -BigInt(r.amount), BigInt(r.fee), BigInt(r.tax)));

    const rrev = await this.tx.execute<{ id: string; at: string; amount: string; fee: string; tax: string }>(sql`
      SELECT r.id, r.failed_at AS at, r.amount::text, r.fee::text, r.tax::text FROM refunds r
       WHERE r.station_id = ${sid} AND r.livemode = ${livemode} AND r.currency = ${currency}
         AND r.status = 'failed' AND r.failed_at >= ${fromCutoff} AND r.failed_at < ${c} AND ${unsettled("refund_reversal", "r.id")} ORDER BY r.id`);
    for (const r of rrev.rows) out.push(entry("refund_reversal", r.id, r.at, BigInt(r.amount), -BigInt(r.fee), -BigInt(r.tax)));

    if (currency === "INR") {
      const pos = await this.tx.execute<{ id: string; at: string; amount: string }>(sql`
        SELECT p.id, p.created_at AS at, p.amount::text FROM payouts p
         WHERE p.station_id = ${sid} AND p.livemode = ${livemode} AND p.created_at >= ${fromRun} AND p.created_at <= ${now}
           AND ${unsettled("payout", "p.id")} ORDER BY p.id`);
      for (const p of pos.rows) out.push(entry("payout", p.id, p.at, -BigInt(p.amount)));
      const prev = await this.tx.execute<{ id: string; at: string; amount: string }>(sql`
        SELECT p.id, coalesce(p.failed_at, p.updated_at) AS at, p.amount::text FROM payouts p
         WHERE p.station_id = ${sid} AND p.livemode = ${livemode} AND p.status IN ('failed','rejected','cancelled')
           AND p.updated_at >= ${fromCutoff} AND coalesce(p.failed_at, p.updated_at) < ${c} AND ${unsettled("payout_reversal", "p.id")} ORDER BY p.id`);
      for (const p of prev.rows) out.push(entry("payout_reversal", p.id, p.at, BigInt(p.amount)));
    }

    const releases = await this.tx.execute<{ settlement_id: string; amount: string }>(sql`
      SELECT h.reference_id AS settlement_id, (-h.amount)::text AS amount
        FROM settlement_entries h JOIN settlements s ON s.id = h.settlement_id
       WHERE s.station_id = ${sid} AND s.livemode = ${livemode} AND s.currency = ${currency}
         AND h.kind = 'reserve_hold' AND h.release_on <= ${date} AND ${unsettled("reserve_release", "h.reference_id")}
       ORDER BY h.id`);
    for (const r of releases.rows) out.push(entry("reserve_release", r.settlement_id, now, BigInt(r.amount)));
    return { entries: out, cutoff };
  }

  /** Create (or return the existing) settlement for one batch. ``null`` = nothing positive to settle. */
  async settleOne(stationId: string, livemode: boolean, currency: Currency, date: string): Promise<Settlement | null> {
    return (await this.settle(stationId, livemode, currency, date)).settlement;
  }

  async settle(
    stationId: string,
    livemode: boolean,
    currency: Currency,
    date: string,
  ): Promise<{ settlement: Settlement | null; created: boolean }> {
    const s = await this.create(stationId, livemode, currency, date);
    return { settlement: s === "existing" ? this.existing! : s, created: s !== "existing" && s !== null };
  }

  private existing: Settlement | undefined;

  private async create(stationId: string, livemode: boolean, currency: Currency, date: string): Promise<Settlement | null | "existing"> {
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`depot:${stationId}:${livemode}:${currency}`}))`);
    const [existing] = await this.tx
      .select()
      .from(settlements)
      .where(
        and(
          eq(settlements.stationId, stationId),
          eq(settlements.livemode, livemode),
          eq(settlements.currency, currency),
          eq(settlements.settlementDate, date),
        ),
      );
    if (existing) {
      this.existing = existing;
      return "existing";
    }
    const [station] = await this.tx.select().from(stations).where(eq(stations.id, stationId));
    if (!station || station.status !== "active") return null;

    const id = newId(IdPrefix.SETTLEMENT, BigInt(this.clock.now().getTime()));
    const { entries, cutoff } = await this.collect(station, livemode, currency, date);
    const payNet = entries.filter((e) => e.kind === "payment").reduce((a, e) => a + e.amount, 0n);
    let net = totals(entries).amount;

    // Rolling reserve on this batch's payment net.
    const policy = await getPolicy(this.tx, this.settings, stationId);
    const hold =
      policy.reserveBps > 0 && payNet > 0n ? Money.of(payNet, currency).applyBps(BigInt(policy.reserveBps), "half_up").amount : 0n;
    if (hold > 0n && net - hold > 0n) {
      entries.push(entry("reserve_hold", id, this.clock.now().toISOString(), -hold, 0n, 0n, addDays(date, policy.reserveHoldDays)));
      net -= hold;
    }

    // Dispute receivable sweep (negative: the merchant owes chargebacks; positive: won disputes to return).
    const ledger = this.ledger();
    const dr = await ledger.getAccountByCode(m2StationAccount(stationId, M2StationAccount.DISPUTE_RESERVE, currency, livemode).code);
    if (dr) {
      const bal = (await ledger.balance(dr.id)).balance.amount;
      if (bal > 0n) {
        entries.push(entry("dispute_release", id, this.clock.now().toISOString(), bal));
      } else if (bal < 0n && net > 0n) {
        const recover = -bal < net ? -bal : net;
        entries.push(entry("dispute_recovery", id, this.clock.now().toISOString(), -recover));
      }
    }

    const t = entries.length > CONSOLIDATED_INVOICE_LINES ? consolidatedTotals(entries, currency) : totals(entries);
    // Nothing to pay out: carry everything forward — unless a chargeback recovery consumed the
    // whole batch, which is recorded as a zero-amount settlement so the items count as settled.
    if (entries.length === 0 || t.amount < 0n || (t.amount === 0n && !entries.some((e) => e.kind === "dispute_recovery"))) return null;

    // Safety: the merchant balance must cover the batch (it always should — see ADR-0014).
    const mb = await ledger.getAccountByCode(stationAccount(stationId, currency, livemode).code);
    const available = mb ? (await ledger.balance(mb.id)).balance.amount : 0n;
    const sweeps = entries.filter((e) => e.kind.startsWith("reserve_") || e.kind.startsWith("dispute_")).reduce((a, e) => a + e.amount, 0n);
    if (available + sweeps < t.amount) {
      log.error(
        { derailment: "settlement_exceeds_balance", station_id: stationId, livemode, currency, date },
        "DERAILMENT: settlement exceeds merchant balance",
      );
      return null;
    }

    let payoutCurrency: Currency = currency;
    let payoutAmount = t.amount;
    let fxRateId: string | null = null;
    let fxRate: string | null = null;
    if (currency !== "INR") {
      const snap = await snapshotFor(this.tx, this.fx, currency, "INR", date, this.clock);
      payoutCurrency = "INR";
      payoutAmount = convert(Money.of(t.amount, currency), "INR", snap.rate).amount;
      fxRateId = snap.id;
      fxRate = snap.rate;
    }

    const [s] = await this.tx
      .insert(settlements)
      .values({
        id,
        stationId,
        livemode,
        currency,
        settlementDate: date,
        schedule: station.settlementSchedule,
        cutoffAt: cutoff.toISOString(),
        entryCount: entries.length,
        gross: t.gross,
        fees: t.fees,
        tax: t.tax,
        amount: t.amount,
        payoutCurrency,
        payoutAmount,
        fxRateId,
        fxRate,
        createdAt: this.clock.now().toISOString(),
        updatedAt: this.clock.now().toISOString(),
        status: t.amount === 0n ? "processed" : "processing",
        processedAt: t.amount === 0n ? this.clock.now().toISOString() : null,
      })
      .returning();
    for (let i = 0; i < entries.length; i += 500) {
      await this.tx.insert(settlementEntries).values(
        entries.slice(i, i + 500).map((e) => ({
          settlementId: id,
          kind: e.kind,
          referenceId: e.referenceId,
          occurredAt: e.occurredAt,
          gross: e.gross,
          fee: e.fee,
          tax: e.tax,
          amount: e.amount,
          releaseOn: e.releaseOn ?? null,
        })),
      );
    }

    // Ledger: sub-account sweeps first (they change merchant_balance), then the settlement itself.
    const sum = (k: EntryKind) => entries.filter((e) => e.kind === k).reduce((a, e) => a + e.amount, 0n);
    const transfer = (account: M2StationAccount, key: string, description: string, amount: bigint) =>
      recordStationTransfer(ledger, {
        stationId,
        account,
        key,
        description,
        amount: Money.of(amount, currency),
        livemode,
        referenceId: id,
      });
    await transfer(M2StationAccount.RESERVE, `reserve_hold:${id}`, `Rolling reserve held by ${id}`, -sum("reserve_hold"));
    await transfer(M2StationAccount.RESERVE, `reserve_release:${id}`, `Rolling reserve released by ${id}`, -sum("reserve_release"));
    await transfer(
      M2StationAccount.DISPUTE_RESERVE,
      `dispute_sweep:${id}`,
      `Chargeback sweep in ${id}`,
      -(sum("dispute_recovery") + sum("dispute_release")),
    );
    if (t.amount === 0n) return s!;
    const posted =
      currency === "INR"
        ? await recordSettlementInitiated(ledger, { stationId, settlementId: id, amount: Money.of(t.amount, currency), livemode })
        : await recordSettlementInitiatedFx(ledger, {
            stationId,
            settlementId: id,
            amount: Money.of(t.amount, currency),
            payout: Money.of(payoutAmount, "INR"),
            fxRate: fxRate!,
            livemode,
          });
    const [withTxn] = await this.tx.update(settlements).set({ ledgerTransactionId: posted.id }).where(eq(settlements.id, id)).returning();
    await enqueue(
      this.tx,
      JOB_DEPOT_BANK_CREDIT,
      { settlement_id: id },
      {
        queue: DEPOT_QUEUE,
        runAt: new Date(this.clock.now().getTime() + this.settings.settlement_bank_delay_s * 1000),
        dedupeKey: `depot:bank_credit:${id}`,
      },
    );
    return withTxn ?? s!;
  }

  /** Job ``depot.bank_credit``: the (simulated) bank confirms the credit to the merchant's account. */
  async bankCredit(settlementId: string): Promise<Settlement | null> {
    const [s] = await this.tx.select().from(settlements).where(eq(settlements.id, settlementId)).for("update");
    if (!s || s.status !== "processing") return s ?? null;
    const now = this.clock.now();
    const utr = `MRSTL${now.toISOString().slice(2, 10).replaceAll("-", "")}${String(BigInt(`0x${createHash("sha256").update(s.id).digest("hex").slice(0, 15)}`) % 1_000_000_000n).padStart(9, "0")}`;
    await recordSettlementPaid(this.ledger(), {
      settlementId: s.id,
      amount: Money.of(s.payoutAmount, s.payoutCurrency),
      livemode: s.livemode,
    });
    const [done] = await this.tx
      .update(settlements)
      .set({ status: "processed", utr, processedAt: now.toISOString(), updatedAt: sql`now()` })
      .where(eq(settlements.id, s.id))
      .returning();
    await emit(
      this.tx,
      { stationId: s.stationId, livemode: s.livemode, type: "settlement.processed", object: settlementOut(done!) },
      this.clock,
    );
    return done!;
  }
}
