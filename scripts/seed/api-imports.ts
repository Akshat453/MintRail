/** Platform imports for the seed, plus the event objects for recent webhook history (public API shapes). */
import { and, eq, gte } from "drizzle-orm";

import { type Db } from "@mintrail/shared";
import {
  disputeOut,
  disputes,
  paymentOut,
  payments,
  payoutOut,
  payouts,
  refundOut,
  refunds,
  settlementOut,
  settlements,
} from "@mintrail/api";

export {
  AuditService,
  DashboardAuthService,
  DerailmentService,
  StaffContext,
  StaffService,
  StationService,
  stations,
  updatePolicy,
  type StaffRole,
} from "@mintrail/api";

export interface HistoricEvent {
  type: string;
  at: string;
  object: Record<string, unknown>;
}

export async function eventOutboxObject(db: Db, stationId: string, livemode: boolean, since: string): Promise<HistoricEvent[]> {
  const out: HistoricEvent[] = [];
  const own = <T extends { stationId: unknown; livemode: unknown; createdAt: unknown }>(t: T) =>
    and(eq(t.stationId as never, stationId), eq(t.livemode as never, livemode), gte(t.createdAt as never, since));
  for (const p of await db.select().from(payments).where(own(payments))) {
    if (p.status === "captured") out.push({ type: "payment.captured", at: p.capturedAt!, object: paymentOut(p) });
    else if (p.status === "failed") out.push({ type: "payment.failed", at: p.failedAt!, object: paymentOut(p) });
  }
  for (const r of await db.select().from(refunds).where(own(refunds))) {
    out.push({ type: "refund.created", at: r.createdAt, object: refundOut(r) });
    if (r.processedAt) out.push({ type: "refund.processed", at: r.processedAt, object: refundOut(r) });
    if (r.failedAt) out.push({ type: "refund.failed", at: r.failedAt, object: refundOut(r) });
  }
  for (const p of await db.select().from(payouts).where(own(payouts))) {
    if (p.processedAt) out.push({ type: "payout.processed", at: p.processedAt, object: payoutOut(p) });
    if (p.failedAt) out.push({ type: "payout.failed", at: p.failedAt, object: payoutOut(p) });
  }
  for (const d of await db.select().from(disputes).where(own(disputes))) {
    out.push({ type: "dispute.created", at: d.createdAt, object: disputeOut(d) });
    if (d.closedAt) out.push({ type: "dispute.closed", at: d.closedAt, object: disputeOut(d) });
  }
  for (const s of await db
    .select()
    .from(settlements)
    .where(and(eq(settlements.stationId, stationId), eq(settlements.livemode, livemode), gte(settlements.createdAt, since)))) {
    if (s.processedAt) out.push({ type: "settlement.processed", at: s.processedAt, object: settlementOut(s) });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}
