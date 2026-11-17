/** Read side of Depot's settlements (the engine lives in @mintrail/depot) and CSV reports. */
import { and, asc, desc, eq, gte, lt, lte } from "drizzle-orm";

import { apiTime, ErrorCode, NotFoundError, type Tx } from "@mintrail/shared";

import { toCsv } from "../csv.js";
import {
  type FxRate,
  fxRates,
  payments,
  type Payout,
  payouts,
  reconciliationItems,
  reconciliationReports,
  type Refund,
  refunds,
  type Settlement,
  settlementEntries,
  type SettlementEntry,
  settlements,
} from "../schema/index.js";
import type { Principal } from "./stations.js";

export class SettlementReader {
  constructor(readonly tx: Tx) {}

  async list(
    principal: Principal | null,
    opts: {
      limit: number;
      startingAfter?: string | null;
      stationId?: string | null;
      from?: string | null;
      to?: string | null;
      status?: string | null;
    },
  ): Promise<[Settlement[], boolean]> {
    const where = [];
    if (principal) where.push(eq(settlements.stationId, principal.station.id), eq(settlements.livemode, principal.livemode));
    if (opts.stationId) where.push(eq(settlements.stationId, opts.stationId));
    if (opts.startingAfter) where.push(lt(settlements.id, opts.startingAfter));
    if (opts.from) where.push(gte(settlements.settlementDate, opts.from));
    if (opts.to) where.push(lte(settlements.settlementDate, opts.to));
    if (opts.status) where.push(eq(settlements.status, opts.status));
    const rows = await this.tx
      .select()
      .from(settlements)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(settlements.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  async get(principal: Principal | null, id: string): Promise<Settlement> {
    const where = [eq(settlements.id, id)];
    if (principal) where.push(eq(settlements.stationId, principal.station.id), eq(settlements.livemode, principal.livemode));
    const [s] = await this.tx
      .select()
      .from(settlements)
      .where(and(...where));
    if (!s) throw new NotFoundError(`settlement ${id} not found`, { code: ErrorCode.SETTLEMENT_NOT_FOUND });
    return s;
  }

  entries(settlementId: string): Promise<SettlementEntry[]> {
    return this.tx
      .select()
      .from(settlementEntries)
      .where(eq(settlementEntries.settlementId, settlementId))
      .orderBy(asc(settlementEntries.id));
  }

  /** The settlement report a merchant's finance team reconciles against: one line per entry. */
  async reportCsv(principal: Principal | null, id: string): Promise<[Settlement, string]> {
    const s = await this.get(principal, id);
    const entries = await this.entries(s.id);
    const csv = toCsv(
      [
        "settlement_id",
        "settlement_date",
        "entry_type",
        "reference_id",
        "occurred_at",
        "currency",
        "gross",
        "fee",
        "gst",
        "net",
        "release_on",
      ],
      entries.map((e) => [
        s.id,
        s.settlementDate,
        e.kind,
        e.referenceId,
        apiTime(e.occurredAt),
        s.currency,
        major(e.gross),
        major(e.fee),
        major(e.tax),
        major(e.amount),
        e.releaseOn ?? "",
      ]),
    );
    const footer = toCsv(["total", "", "", "", "", s.currency, major(s.gross), major(s.fees), major(s.tax), major(s.amount), ""], []);
    return [s, csv + footer];
  }

  async latestFx(base: string, quote: string): Promise<FxRate | null> {
    const [r] = await this.tx
      .select()
      .from(fxRates)
      .where(and(eq(fxRates.base, base), eq(fxRates.quote, quote)))
      .orderBy(desc(fxRates.asOf), desc(fxRates.id))
      .limit(1);
    return r ?? null;
  }

  async latestReconciliation() {
    const [r] = await this.tx.select().from(reconciliationReports).orderBy(desc(reconciliationReports.runAt)).limit(1);
    if (!r) return null;
    return [
      r,
      await this.tx.select().from(reconciliationItems).where(eq(reconciliationItems.reportId, r.id)).orderBy(asc(reconciliationItems.id)),
    ] as const;
  }
}

/** Paise → "1234.56" for CSVs (bigint arithmetic, no floats). */
export function major(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- reports
const MAX_REPORT_ROWS = 100_000;

export async function paymentsReport(tx: Tx, p: Principal, from: string, to: string): Promise<string> {
  const rows = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.stationId, p.station.id),
        eq(payments.livemode, p.livemode),
        gte(payments.createdAt, from),
        lt(payments.createdAt, to),
      ),
    )
    .orderBy(asc(payments.id))
    .limit(MAX_REPORT_ROWS);
  return toCsv(
    ["payment_id", "order_id", "created_at", "method", "status", "currency", "amount", "fee", "gst", "error_code", "email"],
    rows.map((r) => [
      r.id,
      r.orderId,
      apiTime(r.createdAt),
      r.method,
      r.status,
      r.currency,
      major(r.amount),
      r.fee === null ? "" : major(r.fee),
      r.tax === null ? "" : major(r.tax),
      r.errorCode ?? "",
      r.customerEmail ?? "",
    ]),
  );
}

export async function refundsReport(tx: Tx, p: Principal, from: string, to: string): Promise<string> {
  const rows: Refund[] = await tx
    .select()
    .from(refunds)
    .where(
      and(eq(refunds.stationId, p.station.id), eq(refunds.livemode, p.livemode), gte(refunds.createdAt, from), lt(refunds.createdAt, to)),
    )
    .orderBy(asc(refunds.id))
    .limit(MAX_REPORT_ROWS);
  return toCsv(
    ["refund_id", "payment_id", "created_at", "status", "speed", "reason", "currency", "amount", "fee", "gst"],
    rows.map((r) => [
      r.id,
      r.paymentId,
      apiTime(r.createdAt),
      r.status,
      r.speed,
      r.reason,
      r.currency,
      major(r.amount),
      major(r.fee),
      major(r.tax),
    ]),
  );
}

export async function settlementsReport(tx: Tx, p: Principal, from: string, to: string): Promise<string> {
  const rows = await tx
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.stationId, p.station.id),
        eq(settlements.livemode, p.livemode),
        gte(settlements.settlementDate, from.slice(0, 10)),
        lt(settlements.settlementDate, to.slice(0, 10)),
      ),
    )
    .orderBy(asc(settlements.settlementDate));
  return toCsv(
    [
      "settlement_id",
      "settlement_date",
      "status",
      "currency",
      "entries",
      "gross",
      "fees",
      "gst",
      "net",
      "payout_currency",
      "payout_amount",
      "fx_rate",
      "utr",
    ],
    rows.map((s) => [
      s.id,
      s.settlementDate,
      s.status,
      s.currency,
      s.entryCount,
      major(s.gross),
      major(s.fees),
      major(s.tax),
      major(s.amount),
      s.payoutCurrency,
      major(s.payoutAmount),
      s.fxRate ?? "",
      s.utr ?? "",
    ]),
  );
}

export async function payoutsReport(tx: Tx, p: Principal, from: string, to: string): Promise<string> {
  const rows: Payout[] = await tx
    .select()
    .from(payouts)
    .where(
      and(eq(payouts.stationId, p.station.id), eq(payouts.livemode, p.livemode), gte(payouts.createdAt, from), lt(payouts.createdAt, to)),
    )
    .orderBy(asc(payouts.id))
    .limit(MAX_REPORT_ROWS);
  return toCsv(
    ["payout_id", "created_at", "status", "mode", "purpose", "beneficiary", "amount", "utr", "failure_reason", "reference"],
    rows.map((r) => [
      r.id,
      apiTime(r.createdAt),
      r.status,
      r.mode,
      r.purpose,
      r.beneficiaryName,
      major(r.amount),
      r.utr ?? "",
      r.failureReason ?? "",
      r.reference ?? "",
    ]),
  );
}
