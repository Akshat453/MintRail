/**
 * Junction M2: the bank side of refunds, chargebacks and payouts, plus a
 * simulated FX feed. Same pattern as authorizations: accept → job → resolve →
 * signed callback to Platform (``JOB_DELIVER``).
 *
 * Test controls (test mode only):
 *   refunds   scenario ``refund_fail[:reason]``                       → refund.failed
 *   disputes  scenario ``win`` | ``lose`` (default: win iff evidence submitted)
 *   payouts   scenario ``payout_fail[:reason]``; account ending ``0000`` → invalid_account,
 *             ``1111`` → beneficiary_bank_offline
 */
import { randomInt } from "node:crypto";

import { and, eq, ne, sql } from "drizzle-orm";

import { type Clock, enqueue, type Settings, systemClock, type Tx } from "@mintrail/shared";

import { BankError, JOB_DELIVER, pyIsoformat, QUEUE, DELIVERY_MAX_ATTEMPTS } from "./bank.js";
import {
  BankStatus,
  junctionAuthorizations,
  type JunctionDispute,
  junctionDisputes,
  type JunctionPayout,
  junctionPayouts,
  type JunctionRefund,
  junctionRefunds,
} from "./schema.js";

export const JOB_REFUND_RESOLVE = "junction.refund_resolve";
export const JOB_DISPUTE_DECIDE = "junction.dispute_decide";
export const JOB_PAYOUT_RESOLVE = "junction.payout_resolve";

const REFUND_LATENCY_S = { instant: 3, normal: 45 } as const;
const DISPUTE_REVIEW_S = 30;
const PAYOUT_LATENCY_S: Record<string, number> = { IMPS: 2, UPI: 2, NEFT: 30, RTGS: 30 };

const digits = (n: number): string => Array.from({ length: n }, () => randomInt(10)).join("");
export const newRefundRef = (): string => `RFN${digits(12)}`;
export const newDisputeRef = (): string => `DSP${digits(12)}`;
export const newPayoutRef = (): string => `PYT${digits(12)}`;

/** Deterministic simulated USD→INR mid rate for a date (4 dp, as a string — never a float on the wire). */
export function simulatedUsdInr(date: string): string {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  const centiPaise = 830_000 + Math.round(7_500 * Math.sin(day / 9)) + Math.round(2_500 * Math.cos(day / 3));
  return `${Math.floor(centiPaise / 10_000)}.${String(centiPaise % 10_000).padStart(4, "0")}`;
}

export class BankOps {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly clock: Clock = systemClock,
  ) {}

  private scaled(seconds: number): number {
    return seconds * this.settings.junction_latency_scale * 1000;
  }

  private async schedule(kind: string, ref: string, seconds: number): Promise<void> {
    await enqueue(
      this.tx,
      kind,
      { ref },
      { queue: QUEUE, runAt: new Date(this.clock.now().getTime() + this.scaled(seconds)), dedupeKey: `${kind}:${ref}` },
    );
  }

  private async callback(event: Record<string, unknown>): Promise<void> {
    await enqueue(this.tx, JOB_DELIVER, event, {
      queue: QUEUE,
      maxAttempts: DELIVERY_MAX_ATTEMPTS,
      dedupeKey: `junction:deliver:${event.id as string}:0`,
    });
  }

  // ------------------------------------------------------------ refunds
  async refund(req: {
    refundId: string;
    authRef: string;
    amount: bigint;
    speed: "normal" | "instant";
    scenario: string | null;
  }): Promise<JunctionRefund> {
    const [existing] = await this.tx.select().from(junctionRefunds).where(eq(junctionRefunds.refundId, req.refundId));
    if (existing) {
      if (existing.amount !== req.amount || existing.authRef !== req.authRef)
        throw new BankError("duplicate_mismatch", "refund_id reused with different details", 409);
      return existing;
    }
    const [auth] = await this.tx.select().from(junctionAuthorizations).where(eq(junctionAuthorizations.ref, req.authRef)).for("update");
    if (!auth) throw new BankError("not_found", `no authorization ${req.authRef}`, 404);
    if (auth.status !== BankStatus.CAPTURED) throw new BankError("not_refundable", `authorization is ${auth.status}`, 409);
    const [row] = await this.tx
      .select({ total: sql<string>`coalesce(sum(amount), 0)::text` })
      .from(junctionRefunds)
      .where(and(eq(junctionRefunds.authRef, auth.ref), ne(junctionRefunds.status, "failed")));
    if (BigInt(row!.total) + req.amount > auth.amount)
      throw new BankError("refund_exceeds_capture", "refunds would exceed the captured amount", 422);
    const [created] = await this.tx
      .insert(junctionRefunds)
      .values({
        ref: newRefundRef(),
        refundId: req.refundId,
        authRef: auth.ref,
        amount: req.amount,
        currency: auth.currency,
        speed: req.speed,
        scenario: auth.livemode ? null : req.scenario,
        status: "pending",
      })
      .returning();
    await this.schedule(JOB_REFUND_RESOLVE, created!.ref, REFUND_LATENCY_S[req.speed]);
    return created!;
  }

  async getRefund(ref: string): Promise<JunctionRefund> {
    const [r] = await this.tx.select().from(junctionRefunds).where(eq(junctionRefunds.ref, ref));
    if (!r) throw new BankError("not_found", `no refund ${ref}`, 404);
    return r;
  }

  async resolveRefund(ref: string): Promise<void> {
    const [r] = await this.tx.select().from(junctionRefunds).where(eq(junctionRefunds.ref, ref)).for("update");
    if (!r || r.status !== "pending") return;
    const fail = r.scenario?.startsWith("refund_fail") ?? false;
    const reason = fail ? (r.scenario!.split(":")[1] ?? "beneficiary_account_closed") : null;
    const [auth] = await this.tx.select().from(junctionAuthorizations).where(eq(junctionAuthorizations.ref, r.authRef));
    await this.tx
      .update(junctionRefunds)
      .set({ status: fail ? "failed" : "processed", failureReason: reason, updatedAt: sql`now()` })
      .where(eq(junctionRefunds.ref, ref));
    await this.callback({
      id: `jev_${r.ref}_1`,
      type: fail ? "refund.failed" : "refund.processed",
      sequence: 1,
      ref: r.ref,
      refund_id: r.refundId,
      payment_id: auth?.paymentId ?? null,
      amount: r.amount,
      currency: r.currency,
      failure_reason: reason,
      occurred_at: pyIsoformat(this.clock.now()),
    });
  }

  // ------------------------------------------------------------ disputes
  async openDispute(req: { authRef: string; amount: bigint | null; reason: string; scenario: string | null }): Promise<JunctionDispute> {
    const [auth] = await this.tx.select().from(junctionAuthorizations).where(eq(junctionAuthorizations.ref, req.authRef));
    if (!auth) throw new BankError("not_found", `no authorization ${req.authRef}`, 404);
    if (auth.status !== BankStatus.CAPTURED) throw new BankError("not_disputable", `authorization is ${auth.status}`, 409);
    const amount = req.amount ?? auth.amount;
    if (amount <= 0n || amount > auth.amount)
      throw new BankError("invalid_amount", "dispute amount must be within the captured amount", 422);
    const due = new Date(this.clock.now().getTime() + this.settings.dispute_response_days * 86_400_000);
    const [d] = await this.tx
      .insert(junctionDisputes)
      .values({
        ref: newDisputeRef(),
        authRef: auth.ref,
        paymentId: auth.paymentId,
        amount,
        currency: auth.currency,
        reason: req.reason,
        scenario: req.scenario,
        status: "open",
        evidenceCount: 0,
        dueAt: due.toISOString(),
      })
      .returning();
    await this.callback(this.disputeEvent(d!, "dispute.opened", 1));
    return d!;
  }

  async getDispute(ref: string, lock = false): Promise<JunctionDispute> {
    const q = this.tx.select().from(junctionDisputes).where(eq(junctionDisputes.ref, ref));
    const [d] = await (lock ? q.for("update") : q);
    if (!d) throw new BankError("not_found", `no dispute ${ref}`, 404);
    return d;
  }

  async submitEvidence(ref: string, documents: number): Promise<JunctionDispute> {
    const d = await this.getDispute(ref, true);
    if (d.status !== "open") throw new BankError("not_open", `dispute is ${d.status}`, 409);
    const [u] = await this.tx
      .update(junctionDisputes)
      .set({ status: "evidence_submitted", evidenceCount: documents, updatedAt: sql`now()` })
      .where(eq(junctionDisputes.ref, ref))
      .returning();
    await this.schedule(JOB_DISPUTE_DECIDE, ref, DISPUTE_REVIEW_S);
    return u!;
  }

  /** The merchant accepts the chargeback (or missed the deadline): lost immediately. */
  async acceptDispute(ref: string): Promise<JunctionDispute> {
    const d = await this.getDispute(ref, true);
    if (d.status === "lost") return d;
    if (d.status !== "open") throw new BankError("not_open", `dispute is ${d.status}`, 409);
    return this.close(d, false);
  }

  async decideDispute(ref: string): Promise<void> {
    const d = await this.getDispute(ref, true);
    if (d.status !== "evidence_submitted") return;
    const won = d.scenario === "win" ? true : d.scenario === "lose" ? false : d.evidenceCount > 0;
    await this.close(d, won);
  }

  private async close(d: JunctionDispute, won: boolean): Promise<JunctionDispute> {
    const [u] = await this.tx
      .update(junctionDisputes)
      .set({ status: won ? "won" : "lost", updatedAt: sql`now()` })
      .where(eq(junctionDisputes.ref, d.ref))
      .returning();
    await this.callback(this.disputeEvent(u!, won ? "dispute.won" : "dispute.lost", 2));
    return u!;
  }

  private disputeEvent(d: JunctionDispute, type: string, sequence: number): Record<string, unknown> {
    return {
      id: `jev_${d.ref}_${sequence}`,
      type,
      sequence,
      ref: d.ref,
      auth_ref: d.authRef,
      payment_id: d.paymentId,
      amount: d.amount,
      currency: d.currency,
      reason: d.reason,
      due_at: pyIsoformat(new Date(d.dueAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"))),
      occurred_at: pyIsoformat(this.clock.now()),
    };
  }

  // ------------------------------------------------------------ payouts
  async payout(req: {
    payoutId: string;
    amount: bigint;
    mode: string;
    destination: string;
    livemode: boolean;
    scenario: string | null;
  }): Promise<JunctionPayout> {
    const [existing] = await this.tx.select().from(junctionPayouts).where(eq(junctionPayouts.payoutId, req.payoutId));
    if (existing) {
      if (existing.amount !== req.amount) throw new BankError("duplicate_mismatch", "payout_id reused with a different amount", 409);
      return existing;
    }
    const [p] = await this.tx
      .insert(junctionPayouts)
      .values({
        ref: newPayoutRef(),
        payoutId: req.payoutId,
        amount: req.amount,
        mode: req.mode,
        destination: req.destination,
        scenario: req.livemode ? null : req.scenario,
        status: "pending",
      })
      .returning();
    await this.schedule(JOB_PAYOUT_RESOLVE, p!.ref, PAYOUT_LATENCY_S[req.mode] ?? 30);
    return p!;
  }

  async getPayout(ref: string): Promise<JunctionPayout> {
    const [p] = await this.tx.select().from(junctionPayouts).where(eq(junctionPayouts.ref, ref));
    if (!p) throw new BankError("not_found", `no payout ${ref}`, 404);
    return p;
  }

  async resolvePayout(ref: string): Promise<void> {
    const [p] = await this.tx.select().from(junctionPayouts).where(eq(junctionPayouts.ref, ref)).for("update");
    if (!p || p.status !== "pending") return;
    let reason: string | null = null;
    if (p.scenario?.startsWith("payout_fail")) reason = p.scenario.split(":")[1] ?? "beneficiary_bank_offline";
    else if (p.destination.endsWith("0000")) reason = "invalid_account";
    else if (p.destination.endsWith("1111")) reason = "beneficiary_bank_offline";
    const now = this.clock.now();
    const utr = reason ? null : `JUNC${now.toISOString().slice(2, 10).replaceAll("-", "")}${digits(10)}`;
    await this.tx
      .update(junctionPayouts)
      .set({ status: reason ? "failed" : "processed", failureReason: reason, utr, updatedAt: sql`now()` })
      .where(eq(junctionPayouts.ref, ref));
    await this.callback({
      id: `jev_${p.ref}_1`,
      type: reason ? "payout.failed" : "payout.processed",
      sequence: 1,
      ref: p.ref,
      payout_id: p.payoutId,
      amount: p.amount,
      utr,
      failure_reason: reason,
      occurred_at: pyIsoformat(now),
    });
  }
}
