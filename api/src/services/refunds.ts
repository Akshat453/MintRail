/**
 * Refunds (ADR-0012).
 *
 *   POST /v1/payments/:id/refunds ─▶ pending ──(Junction refund.processed)──▶ processed
 *                                          └──(refund.failed / bank rejects)──▶ failed
 *
 * The merchant's balance is debited when the refund is *created* (so the money
 * cannot be settled out meanwhile) and returned if it fails. Instant refunds
 * cost ``refund_instant_fee_bps`` of the amount plus 18% GST, charged to the
 * merchant. Total refunds (non-failed) + open/lost disputes never exceed the
 * captured amount.
 */
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";

import {
  type Clock,
  ConflictError,
  type Currency,
  enqueue,
  ErrorCode,
  IdPrefix,
  InvalidAmountError,
  InvalidRequestError,
  Money,
  newId,
  NotFoundError,
  type Settings,
  systemClock,
  type Tx,
} from "@mintrail/shared";
import {
  GST_RATE_BPS,
  LedgerService,
  recordRefundFailed,
  recordRefundFee,
  recordRefundInitiated,
  recordRefundPaid,
} from "@mintrail/ledger";
import { emit } from "@mintrail/signal";

import { refundOut } from "../http/out.js";
import { type JunctionClient, JunctionRejectedError } from "../junction-client.js";
import { disputes, type Payment, payments, type Refund, refunds, type RefundStatus } from "../schema/index.js";
import { PaymentService, QUEUE, SCENARIO_RE, validateNotes } from "./payments.js";
import type { Principal } from "./stations.js";

export const JOB_REFUND_SUBMIT = "payments.refund_submit";

export interface NewRefund {
  amount: bigint | null;
  reason: string;
  speed: "normal" | "instant";
  notes: Record<string, unknown> | null;
  scenario: string | null;
}

export class RefundService {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly junctionClient: JunctionClient | null = null,
    private readonly clock: Clock = systemClock,
  ) {}

  private get junction(): JunctionClient {
    if (!this.junctionClient) throw new Error("RefundService needs a JunctionClient for this operation");
    return this.junctionClient;
  }

  private ledger(): LedgerService {
    return new LedgerService(this.tx, this.clock);
  }

  /** Captured amount still refundable: captured − non-failed refunds − open/lost disputes. */
  async refundable(p: Payment): Promise<bigint> {
    const [r] = await this.tx
      .select({ n: sql<string>`coalesce(sum(${refunds.amount}), 0)::text` })
      .from(refunds)
      .where(and(eq(refunds.paymentId, p.id), ne(refunds.status, "failed")));
    const [d] = await this.tx
      .select({ n: sql<string>`coalesce(sum(${disputes.amount}), 0)::text` })
      .from(disputes)
      .where(and(eq(disputes.paymentId, p.id), inArray(disputes.status, ["needs_response", "under_review", "lost"])));
    return p.amount - BigInt(r!.n) - BigInt(d!.n);
  }

  async create(principal: Principal, paymentId: string, req: NewRefund): Promise<Refund> {
    if (req.scenario !== null) {
      if (principal.livemode)
        throw new InvalidRequestError("test scenarios are only available in test mode", { code: ErrorCode.SCENARIO_NOT_ALLOWED });
      if (!SCENARIO_RE.test(req.scenario)) throw new InvalidRequestError("malformed test scenario", { param: "MintRail-Test-Scenario" });
    }
    const p = await new PaymentService(this.tx, this.settings).getPayment(principal, paymentId);
    if (p.status !== "captured") {
      throw new ConflictError(`payment is ${p.status}; only captured payments can be refunded`, { code: ErrorCode.PAYMENT_NOT_REFUNDABLE });
    }
    const refundable = await this.refundable(p);
    const amount = req.amount ?? refundable;
    if (amount <= 0n) {
      if (req.amount === null) throw new ConflictError("payment is already fully refunded", { code: ErrorCode.PAYMENT_NOT_REFUNDABLE });
      throw new InvalidAmountError("refund amount must be positive", { param: "amount" });
    }
    if (amount > refundable) {
      throw new InvalidAmountError(`refund amount exceeds the refundable amount (${refundable})`, {
        code: ErrorCode.REFUND_AMOUNT_EXCEEDED,
        param: "amount",
        details: { refundable },
      });
    }
    if (req.speed === "instant" && p.method === "netbanking") {
      throw new InvalidRequestError("instant refunds are available for card and UPI payments only", { param: "speed" });
    }
    const currency = p.currency as Currency;
    const money = Money.of(amount, currency);
    const fee = req.speed === "instant" ? money.applyBps(BigInt(this.settings.refund_instant_fee_bps), "half_up") : Money.zero(currency);
    const tax = fee.applyBps(GST_RATE_BPS, "half_even");
    const [refund] = await this.tx
      .insert(refunds)
      .values({
        id: newId(IdPrefix.REFUND, BigInt(this.clock.now().getTime())),
        paymentId: p.id,
        stationId: p.stationId,
        livemode: p.livemode,
        amount,
        currency,
        status: "pending",
        reason: req.reason,
        speed: req.speed,
        fee: fee.amount,
        tax: tax.amount,
        notes: validateNotes(req.notes),
        testScenario: req.scenario,
      })
      .returning();
    const ledger = this.ledger();
    await recordRefundInitiated(ledger, { stationId: p.stationId, refundId: refund!.id, amount: money, livemode: p.livemode });
    await recordRefundFee(ledger, { stationId: p.stationId, refundId: refund!.id, fee, tax, livemode: p.livemode });
    await enqueue(
      this.tx,
      JOB_REFUND_SUBMIT,
      { refund_id: refund!.id },
      { queue: QUEUE, dedupeKey: `payments:refund_submit:${refund!.id}` },
    );
    await this.publish(refund!, "refund.created");
    return refund!;
  }

  async get(principal: Principal | null, refundId: string, lock = false): Promise<Refund> {
    const where = [eq(refunds.id, refundId)];
    if (principal) where.push(eq(refunds.stationId, principal.station.id), eq(refunds.livemode, principal.livemode));
    const q = this.tx
      .select()
      .from(refunds)
      .where(and(...where));
    const [r] = await (lock ? q.for("update") : q);
    if (!r) throw new NotFoundError(`refund ${refundId} not found`, { code: ErrorCode.REFUND_NOT_FOUND });
    return r;
  }

  async list(
    principal: Principal,
    opts: { limit: number; startingAfter?: string | null; paymentId?: string | null; status?: RefundStatus | null },
  ): Promise<[Refund[], boolean]> {
    const where = [eq(refunds.stationId, principal.station.id), eq(refunds.livemode, principal.livemode)];
    if (opts.startingAfter) where.push(lt(refunds.id, opts.startingAfter));
    if (opts.paymentId) where.push(eq(refunds.paymentId, opts.paymentId));
    if (opts.status) where.push(eq(refunds.status, opts.status));
    const rows = await this.tx
      .select()
      .from(refunds)
      .where(and(...where))
      .orderBy(desc(refunds.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  forPayment(paymentId: string): Promise<Refund[]> {
    return this.tx.select().from(refunds).where(eq(refunds.paymentId, paymentId)).orderBy(refunds.id);
  }

  /** Job ``payments.refund_submit``. Junction dedupes by refund id, so retrying is safe. */
  async submit(refundId: string): Promise<void> {
    const r = await this.get(null, refundId, true);
    if (r.status !== "pending" || r.junctionRef !== null) return;
    const [p] = await this.tx.select().from(payments).where(eq(payments.id, r.paymentId));
    try {
      const res = await this.junction.refund({
        refundId: r.id,
        authRef: p!.junctionRef!,
        amount: r.amount,
        speed: r.speed,
        scenario: r.testScenario,
      });
      await this.update(r, { junctionRef: String(res.ref) });
    } catch (e) {
      if (!(e instanceof JunctionRejectedError)) throw e;
      await this.fail(r, `bank_${e.code}`, e.detail.slice(0, 300));
    }
  }

  /** Apply a Junction ``refund.processed`` / ``refund.failed`` event. */
  async applyEvent(event: Record<string, unknown>): Promise<string> {
    const r = await this.get(null, String(event.refund_id), true);
    if (r.status !== "pending") return "ignored";
    if (r.junctionRef === null) await this.update(r, { junctionRef: String(event.ref) });
    if (event.type === "refund.processed") {
      const done = await this.update(r, { status: "processed", processedAt: this.clock.now().toISOString() });
      await recordRefundPaid(this.ledger(), { refundId: r.id, amount: Money.of(r.amount, r.currency), livemode: r.livemode });
      await this.publish(done, "refund.processed");
    } else {
      const reason = String(event.failure_reason ?? "bank_failure");
      await this.fail(r, reason.slice(0, 64), `The bank could not process the refund (${reason.replaceAll("_", " ")})`);
    }
    return "applied";
  }

  private async fail(r: Refund, code: string, description: string): Promise<Refund> {
    const failed = await this.update(r, {
      status: "failed",
      errorCode: code,
      errorDescription: description,
      failedAt: this.clock.now().toISOString(),
    });
    await recordRefundFailed(this.ledger(), { refundId: r.id });
    await this.publish(failed, "refund.failed");
    return failed;
  }

  private async update(r: Refund, values: Partial<typeof refunds.$inferInsert>): Promise<Refund> {
    const [row] = await this.tx
      .update(refunds)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(refunds.id, r.id))
      .returning();
    return row!;
  }

  private async publish(r: Refund, type: "refund.created" | "refund.processed" | "refund.failed"): Promise<void> {
    await emit(this.tx, { stationId: r.stationId, livemode: r.livemode, type, object: refundOut(r) }, this.clock);
  }
}
