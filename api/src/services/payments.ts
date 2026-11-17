/**
 * Orders and payments: the core money path (ported 1:1 from M1, ADR-0008).
 *
 *   created → pending → authorized → captured;   any non-terminal → failed
 *   failed + authorization.succeeded → "late authorization": stays failed, voided at the bank
 *
 * Callbacks are deduplicated by Junction event id and ordered by ``sequence``.
 */
import { and, count, desc, eq, gte, lt, ne, sql } from "drizzle-orm";

import {
  type Clock,
  ConflictError,
  type Currency,
  enqueue,
  ErrorCode,
  IdPrefix,
  InvalidAmountError,
  InvalidRequestError,
  log,
  MintRailError,
  Money,
  newId,
  NotFoundError,
  pyRepr,
  type Settings,
  systemClock,
  type Tx,
} from "@mintrail/shared";
import { reasons, RiskEngine, type VelocityCounter } from "@mintrail/conductor";
import { computeCaptureBreakdown, LedgerService, recordCapture } from "@mintrail/ledger";

import { feeBps } from "../fees.js";
import { type JunctionClient, JunctionRejectedError, JunctionUnavailableError } from "../junction-client.js";
import type { Instrument } from "../payment-methods.js";
import {
  type CaptureMode,
  type Order,
  orders,
  type Payment,
  paymentEvents,
  payments,
  type PaymentStatus,
  stations,
} from "../schema/index.js";
import type { Principal } from "./stations.js";
import { emit } from "@mintrail/signal";
import { paymentOut } from "../http/out.js";

export const QUEUE = "payments";
export const JOB_SUBMIT = "payments.submit";
export const JOB_STATUS_CHECK = "payments.status_check";
export const JOB_CAPTURE = "payments.capture";
export const JOB_VOID = "payments.void";
export const JOB_EXPIRE = "payments.expire_authorization";

export const MIN_AMOUNT = 100n;
export const MAX_AMOUNT = 100_000_000_000n;
export const MAX_NOTES = 15;
export const SCENARIO_RE = /^[a-z_]{1,32}(:[a-z0-9_.]{1,30})?$/;

const EVENT_PENDING = "authorization.pending";
const EVENT_SUCCEEDED = "authorization.succeeded";
const EVENT_FAILED = "authorization.failed";

export interface NewPayment {
  orderId: string;
  instrument: Instrument;
  capture: CaptureMode | null;
  customerEmail: string | null;
  scenario: string | null;
}

const toDate = (v: string): Date => new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
const gatewayError = (message: string): MintRailError => new MintRailError(message, { code: ErrorCode.GATEWAY_ERROR });

/** Conductor's view of recent payments (implements ``VelocityCounter``). */
export class PaymentVelocity implements VelocityCounter {
  constructor(private readonly tx: Tx) {}

  async attemptsSince(fingerprint: string, since: Date, livemode: boolean): Promise<number> {
    const [r] = await this.tx
      .select({ n: count() })
      .from(payments)
      .where(
        and(eq(payments.instrumentFingerprint, fingerprint), eq(payments.livemode, livemode), gte(payments.createdAt, since.toISOString())),
      );
    return Number(r?.n ?? 0);
  }

  async failuresSince(fingerprint: string, since: Date, livemode: boolean): Promise<number> {
    const [r] = await this.tx
      .select({ n: count() })
      .from(payments)
      .where(
        and(
          eq(payments.instrumentFingerprint, fingerprint),
          eq(payments.livemode, livemode),
          gte(payments.createdAt, since.toISOString()),
          eq(payments.status, "failed"),
          sql`${payments.errorCode} IS DISTINCT FROM 'risk_blocked'`,
        ),
      );
    return Number(r?.n ?? 0);
  }
}

/** Python ``str()`` of a JSON scalar. */
const pyStr = (v: unknown): string => (typeof v === "boolean" ? (v ? "True" : "False") : String(v));

export function validateNotes(notes: Record<string, unknown> | null | undefined): Record<string, string> {
  const n = notes ?? {};
  if (Object.keys(n).length > MAX_NOTES) throw new InvalidRequestError(`at most ${MAX_NOTES} notes are allowed`, { param: "notes" });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(n)) {
    if (k.length < 1 || k.length > 40) throw new InvalidRequestError("note keys must be 1-40 characters", { param: "notes" });
    const scalar = typeof v === "string" || typeof v === "bigint" || typeof v === "boolean";
    if (!scalar || pyStr(v).length > 256) {
      throw new InvalidRequestError("note values must be strings of at most 256 characters", { param: `notes.${k}` });
    }
    out[k] = pyStr(v);
  }
  return out;
}

export class PaymentService {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly junctionClient: JunctionClient | null = null,
    private readonly clock: Clock = systemClock,
  ) {}

  get junction(): JunctionClient {
    if (!this.junctionClient) throw new Error("PaymentService needs a JunctionClient for this operation");
    return this.junctionClient;
  }

  // ================================================================ orders
  async createOrder(
    auth: Principal,
    args: { amount: bigint; currency: Currency; receipt: string | null; notes: Record<string, unknown> | null },
  ): Promise<Order> {
    if (args.currency !== "INR" && args.currency !== "USD") {
      throw new InvalidRequestError("currency must be INR or USD", { param: "currency" });
    }
    if (args.amount < MIN_AMOUNT || args.amount > MAX_AMOUNT) {
      throw new InvalidAmountError(`amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT} minor units`, { param: "amount" });
    }
    const [row] = await this.tx
      .insert(orders)
      .values({
        id: newId(IdPrefix.ORDER),
        stationId: auth.station.id,
        livemode: auth.livemode,
        amount: args.amount,
        currency: args.currency,
        receipt: args.receipt,
        notes: validateNotes(args.notes),
        status: "created",
        amountPaid: 0n,
        attempts: 0,
      })
      .returning();
    return row!;
  }

  async getOrder(auth: Principal, orderId: string, lock = false): Promise<Order> {
    const q = this.tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.stationId, auth.station.id), eq(orders.livemode, auth.livemode)));
    const [o] = await (lock ? q.for("update") : q);
    if (!o) throw new NotFoundError(`order ${orderId} not found`, { code: ErrorCode.ORDER_NOT_FOUND });
    return o;
  }

  async listOrders(auth: Principal, opts: { limit: number; startingAfter?: string | null }): Promise<[Order[], boolean]> {
    const where = [eq(orders.stationId, auth.station.id), eq(orders.livemode, auth.livemode)];
    if (opts.startingAfter) where.push(lt(orders.id, opts.startingAfter));
    const rows = await this.tx
      .select()
      .from(orders)
      .where(and(...where))
      .orderBy(desc(orders.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  // ================================================================ payments
  async createPayment(auth: Principal, data: NewPayment): Promise<Payment> {
    if (data.scenario !== null) {
      if (auth.livemode) {
        throw new InvalidRequestError("test scenarios are only available in test mode", { code: ErrorCode.SCENARIO_NOT_ALLOWED });
      }
      if (!SCENARIO_RE.test(data.scenario)) {
        throw new InvalidRequestError("malformed test scenario", { param: "MintRail-Test-Scenario" });
      }
    }
    const order = await this.getOrder(auth, data.orderId, true);
    if (order.status === "paid") throw new ConflictError("order is already paid", { code: ErrorCode.ORDER_ALREADY_PAID });
    const [live] = await this.tx
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, order.id), ne(payments.status, "failed")))
      .limit(1);
    if (live) {
      throw new ConflictError(`order already has payment ${live.id} in status ${live.status}`, { code: ErrorCode.PAYMENT_IN_PROGRESS });
    }
    const currency = order.currency as Currency;
    const inst = data.instrument;
    if (currency === "USD" && inst.method !== "card") {
      throw new InvalidRequestError("USD payments support card only", { code: ErrorCode.INVALID_PAYMENT_METHOD, param: "method" });
    }
    const risk = await new RiskEngine(this.tx, new PaymentVelocity(this.tx), this.clock).evaluate({
      stationId: auth.station.id,
      livemode: auth.livemode,
      amount: Money.of(order.amount, currency),
      method: inst.method,
      instrumentFingerprint: inst.fingerprint,
      cardBin: inst.cardBin,
      vpa: inst.vpa,
      stationMaxAmount: auth.station.maxPaymentAmount,
    });
    const captureMode: CaptureMode = data.capture ?? (auth.station.autoCapture ? "automatic" : "manual");
    const blocked = risk.decision === "block";
    const now = this.clock.now().toISOString();
    const [payment] = await this.tx
      .insert(payments)
      .values({
        id: newId(IdPrefix.PAYMENT),
        orderId: order.id,
        stationId: auth.station.id,
        livemode: auth.livemode,
        amount: order.amount,
        currency: order.currency,
        method: inst.method,
        captureMode,
        status: blocked ? "failed" : "created",
        cardNetwork: inst.cardNetwork,
        cardBin: inst.cardBin,
        cardLast4: inst.cardLast4,
        cardExpiryMonth: inst.cardExpiryMonth,
        cardExpiryYear: inst.cardExpiryYear,
        vpa: inst.vpa,
        bankCode: inst.bankCode,
        instrumentFingerprint: inst.fingerprint,
        customerEmail: data.customerEmail,
        testScenario: data.scenario,
        junctionSequence: 0,
        riskDecision: risk.decision,
        riskScore: risk.score,
        riskReasons: reasons(risk),
        riskReviewStatus: risk.decision === "review" ? "pending" : "not_required",
        ...(blocked
          ? {
              errorCode: "risk_blocked",
              errorDescription: risk.hits
                .map((h) => h.detail)
                .join("; ")
                .slice(0, 300),
              failedAt: now,
            }
          : {}),
      })
      .returning();
    await this.tx
      .update(orders)
      .set({ attempts: order.attempts + 1, status: order.status === "created" ? "attempted" : order.status, updatedAt: sql`now()` })
      .where(eq(orders.id, order.id));

    await this.event(payment!, "api", "payment.created", { risk: reasons(risk) });
    if (blocked) {
      await this.event(payment!, "conductor", "risk.blocked", { score: risk.score });
      await this.publish(payment!, "payment.failed");
      return payment!;
    }
    if (risk.decision === "review") await this.event(payment!, "conductor", "risk.review_required", { score: risk.score });
    await enqueue(this.tx, JOB_SUBMIT, { payment_id: payment!.id }, { queue: QUEUE, dedupeKey: `payments:submit:${payment!.id}` });
    await this.scheduleStatusCheck(payment!, 1);
    return payment!;
  }

  async getPayment(auth: Principal, paymentId: string): Promise<Payment> {
    const [p] = await this.tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.stationId, auth.station.id), eq(payments.livemode, auth.livemode)));
    if (!p) throw new NotFoundError(`payment ${paymentId} not found`, { code: ErrorCode.PAYMENT_NOT_FOUND });
    return p;
  }

  async listPayments(
    auth: Principal,
    opts: { limit: number; startingAfter?: string | null; orderId?: string | null; status?: PaymentStatus | null },
  ): Promise<[Payment[], boolean]> {
    const where = [eq(payments.stationId, auth.station.id), eq(payments.livemode, auth.livemode)];
    if (opts.startingAfter) where.push(lt(payments.id, opts.startingAfter));
    if (opts.orderId) where.push(eq(payments.orderId, opts.orderId));
    if (opts.status) where.push(eq(payments.status, opts.status));
    const rows = await this.tx
      .select()
      .from(payments)
      .where(and(...where))
      .orderBy(desc(payments.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  async lock(paymentId: string): Promise<Payment> {
    const [p] = await this.tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!p) throw new NotFoundError(`payment ${paymentId} not found`, { code: ErrorCode.PAYMENT_NOT_FOUND });
    return p;
  }

  private async update(p: Payment, values: Partial<typeof payments.$inferInsert>): Promise<Payment> {
    const [row] = await this.tx
      .update(payments)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(payments.id, p.id))
      .returning();
    return row!;
  }

  // ================================================================ Junction I/O
  /** Job ``payments.submit``. Junction dedupes by payment id, so retrying is safe. */
  async submit(paymentId: string): Promise<void> {
    let p = await this.lock(paymentId);
    if (p.status !== "created" || p.riskReviewStatus === "rejected") return;
    let auth;
    try {
      auth = await this.junction.authorize({
        paymentId: p.id,
        merchantRef: p.stationId,
        amount: p.amount,
        currency: p.currency,
        method: p.method,
        instrument: maskedInstrument(p),
        livemode: p.livemode,
        scenario: p.testScenario,
      });
    } catch (e) {
      if (!(e instanceof JunctionRejectedError)) throw e;
      await this.event(await this.fail(p, "gateway_rejected", e.detail.slice(0, 300)), "junction", "submit.rejected", { code: e.code });
      return;
    }
    p = await this.update(p, {
      junctionRef: p.junctionRef ?? auth.ref,
      status: p.status === "created" ? "pending" : p.status,
    });
    await this.event(p, "junction", "submit.accepted", { ref: auth.ref });
  }

  /** Apply one Junction event. Returns applied | duplicate | stale | ignored. */
  async applyJunctionEvent(event: Record<string, unknown>, source = "junction"): Promise<string> {
    let p = await this.lock(String(event.payment_id));
    const sequence = Number(event.sequence);
    const inserted = await this.tx
      .insert(paymentEvents)
      .values({
        paymentId: p.id,
        source,
        type: `junction.${String(event.type)}`,
        junctionEventId: String(event.id),
        sequence,
        applied: false,
        payload: event,
      })
      .onConflictDoNothing({ target: paymentEvents.junctionEventId })
      .returning({ id: paymentEvents.id });
    if (inserted.length === 0) return "duplicate";
    const rowId = inserted[0]!.id;
    const setRow = (values: { applied?: boolean; note?: string | null }) =>
      this.tx.update(paymentEvents).set(values).where(eq(paymentEvents.id, rowId));

    if (p.junctionRef === null) p = await this.update(p, { junctionRef: String(event.ref) });
    if (sequence <= p.junctionSequence) {
      await setRow({ note: `stale: sequence ${sequence} <= applied ${p.junctionSequence}` });
      return "stale";
    }
    p = await this.update(p, { junctionSequence: sequence });

    const status = p.status as PaymentStatus;
    const etype = event.type;
    let outcome = "applied";
    let note: string | null = null;
    if (etype === EVENT_PENDING) {
      if (status === "created") await this.update(p, { status: "pending" });
      else [outcome, note] = ["ignored", `no-op: payment is ${status}`];
    } else if (etype === EVENT_SUCCEEDED) {
      if (status === "created" || status === "pending") {
        await this.authorize(p);
      } else if (status === "failed") {
        [outcome, note] = ["ignored", "late authorization after failure; void scheduled"];
        log.warn({ payment_id: p.id }, "late authorization");
        await this.enqueueVoid(p, "late_authorization");
      } else {
        [outcome, note] = ["ignored", `no-op: payment is ${status}`];
      }
    } else if (etype === EVENT_FAILED) {
      if (status === "created" || status === "pending") {
        await this.fail(p, String(event.decline_code || "declined"), String(event.decline_reason || "Declined by the bank").slice(0, 300));
      } else {
        [outcome, note] = ["ignored", `bank reported failure for ${status} payment`];
        log.error({ derailment: "payment_state_conflict", payment_id: p.id }, "DERAILMENT: bank failure event for a non-pending payment");
      }
    } else {
      [outcome, note] = ["ignored", `unknown event type ${pyRepr(String(etype))}`];
    }
    await setRow({ applied: outcome === "applied", note });
    return outcome;
  }

  /** Job ``payments.status_check``: poll Junction for payments stuck at the bank. */
  async statusCheck(paymentId: string, attempt: number): Promise<void> {
    const p = await this.lock(paymentId);
    if (p.status !== "created" && p.status !== "pending") return;
    let auth = null;
    try {
      auth = await this.junction.find(p.id);
    } catch (e) {
      if (!(e instanceof JunctionUnavailableError)) throw e;
    }
    if (auth !== null && ["authorized", "declined", "captured"].includes(auth.status)) {
      await this.applyJunctionEvent(
        {
          id: `inq_${auth.ref}_${auth.sequence}`,
          type: auth.status === "declined" ? EVENT_FAILED : EVENT_SUCCEEDED,
          sequence: Math.max(auth.sequence, 1),
          ref: auth.ref,
          payment_id: p.id,
          decline_code: auth.declineCode,
          decline_reason: null,
        },
        "status_check",
      );
      return;
    }
    const ageMs = this.clock.now().getTime() - toDate(p.createdAt).getTime();
    if (ageMs >= this.settings.payment_timeout_s * 1000) {
      if (auth !== null && auth.status === "pending") {
        try {
          await this.junction.void(auth.ref);
        } catch (e) {
          if (!(e instanceof JunctionUnavailableError || e instanceof JunctionRejectedError)) throw e;
          log.warn({ payment_id: p.id }, "could not void timed-out authorization");
        }
      }
      await this.fail(p, "gateway_timeout", "No final response from the bank in time");
      return;
    }
    await this.scheduleStatusCheck(p, attempt + 1);
  }

  async capture(paymentId: string, amount: bigint | null = null): Promise<Payment> {
    let p = await this.lock(paymentId);
    if (p.status === "captured") return p;
    if (p.status !== "authorized") {
      throw new ConflictError(`payment is ${p.status}; only authorized payments can be captured`, {
        code: ErrorCode.PAYMENT_NOT_CAPTURABLE,
      });
    }
    if (p.riskReviewStatus === "pending") {
      throw new ConflictError("payment is awaiting risk review", { code: ErrorCode.PAYMENT_NOT_CAPTURABLE });
    }
    if (amount !== null && amount !== p.amount) throw new InvalidAmountError("partial capture is not supported", { param: "amount" });
    try {
      await this.junction.capture(p.junctionRef!, p.amount);
    } catch (e) {
      if (e instanceof JunctionUnavailableError) throw gatewayError(`bank unavailable during capture: ${e.message}`);
      if (e instanceof JunctionRejectedError) throw gatewayError(`bank rejected capture: ${e.detail}`);
      throw e;
    }
    const [station] = await this.tx.select().from(stations).where(eq(stations.id, p.stationId));
    const currency = p.currency as Currency;
    const breakdown = computeCaptureBreakdown(Money.of(p.amount, currency), { feeBps: feeBps(station!.feePlan, currency, p.method) });
    await recordCapture(new LedgerService(this.tx, this.clock), {
      stationId: p.stationId,
      paymentId: p.id,
      breakdown,
      livemode: p.livemode,
    });
    p = await this.update(p, {
      fee: breakdown.fee.amount,
      tax: breakdown.tax.amount,
      status: "captured",
      capturedAt: this.clock.now().toISOString(),
    });
    await this.tx
      .update(orders)
      .set({ amountPaid: p.amount, status: "paid", updatedAt: sql`now()` })
      .where(eq(orders.id, p.orderId));
    await this.event(p, "api", "payment.captured", { fee: p.fee, tax: p.tax });
    await this.publish(p, "payment.captured");
    return p;
  }

  /** Job ``payments.void``: release an authorization at the bank. */
  async void(paymentId: string, reason: string): Promise<void> {
    let p = await this.lock(paymentId);
    if (p.status === "captured") return;
    if (p.junctionRef !== null) {
      try {
        await this.junction.void(p.junctionRef);
      } catch (e) {
        if (!(e instanceof JunctionRejectedError)) throw e;
        await this.event(p, "junction", "void.rejected", { code: e.code });
        return;
      }
    }
    if (p.status !== "failed") p = await this.fail(p, reason, `Authorization voided (${reason.replaceAll("_", " ")})`);
    await this.event(p, "junction", "authorization.voided", { reason });
  }

  async expireAuthorization(paymentId: string): Promise<void> {
    const p = await this.lock(paymentId);
    if (p.status === "authorized") await this.void(paymentId, "authorization_expired");
  }

  // ================================================================ risk review
  async review(paymentId: string, approve: boolean, staffId: string): Promise<Payment> {
    let p = await this.lock(paymentId);
    if (p.riskReviewStatus !== "pending") throw new ConflictError(`payment risk review is ${p.riskReviewStatus}`);
    p = await this.update(p, { riskReviewedBy: staffId, riskReviewedAt: this.clock.now().toISOString() });
    if (approve) {
      p = await this.update(p, { riskReviewStatus: "approved" });
      if (p.status === "authorized" && p.captureMode === "automatic") await this.enqueueCapture(p);
    } else {
      p = await this.update(p, { riskReviewStatus: "rejected" });
      if (p.status === "created" || p.status === "pending") p = await this.fail(p, "risk_rejected", "Rejected during risk review");
      if (p.junctionRef !== null || p.status === "authorized") await this.enqueueVoid(p, "risk_rejected");
    }
    await this.event(p, "railyard", `risk.review_${approve ? "approved" : "rejected"}`, {});
    return p;
  }

  // ================================================================ internals
  private async authorize(p: Payment): Promise<Payment> {
    const now = this.clock.now();
    const updated = await this.update(p, { status: "authorized", authorizedAt: now.toISOString() });
    await this.publish(updated, "payment.authorized");
    await enqueue(
      this.tx,
      JOB_EXPIRE,
      { payment_id: p.id },
      {
        queue: QUEUE,
        runAt: new Date(now.getTime() + this.settings.authorization_expiry_s * 1000),
        dedupeKey: `payments:expire:${p.id}`,
      },
    );
    if (updated.captureMode === "automatic" && (updated.riskReviewStatus === "not_required" || updated.riskReviewStatus === "approved")) {
      await this.enqueueCapture(updated);
    }
    return updated;
  }

  private async fail(p: Payment, code: string, description: string): Promise<Payment> {
    const updated = await this.update(p, {
      status: "failed",
      errorCode: code.slice(0, 64),
      errorDescription: description,
      failedAt: this.clock.now().toISOString(),
    });
    await this.event(updated, "system", "payment.failed", { code });
    await this.publish(updated, "payment.failed");
    return updated;
  }

  private enqueueCapture(p: Payment): Promise<bigint | null> {
    return enqueue(this.tx, JOB_CAPTURE, { payment_id: p.id }, { queue: QUEUE, dedupeKey: `payments:capture:${p.id}` });
  }

  private enqueueVoid(p: Payment, reason: string): Promise<bigint | null> {
    return enqueue(this.tx, JOB_VOID, { payment_id: p.id, reason }, { queue: QUEUE, dedupeKey: `payments:void:${p.id}` });
  }

  private scheduleStatusCheck(p: Payment, attempt: number): Promise<bigint | null> {
    return enqueue(
      this.tx,
      JOB_STATUS_CHECK,
      { payment_id: p.id, attempt },
      {
        queue: QUEUE,
        runAt: new Date(this.clock.now().getTime() + this.settings.payment_status_check_after_s * 1000),
        dedupeKey: `payments:status_check:${p.id}:${attempt}`,
      },
    );
  }

  /** Transactional outbox → Signal webhooks (same transaction as the state change). */
  private async publish(p: Payment, type: "payment.authorized" | "payment.captured" | "payment.failed"): Promise<void> {
    await emit(this.tx, { stationId: p.stationId, livemode: p.livemode, type, object: paymentOut(p) }, this.clock);
  }

  private async event(p: Payment, source: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.tx.insert(paymentEvents).values({ paymentId: p.id, source, type, payload, applied: true });
  }
}

export function maskedInstrument(p: Payment): string {
  if (p.method === "card") return `card:${p.cardBin}:${p.cardLast4}`;
  if (p.method === "upi") return `upi:${p.vpa}`;
  return `netbanking:${p.bankCode}`;
}
