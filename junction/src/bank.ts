/**
 * Junction's bank logic: accept, decide, resolve, capture, void (same as M1).
 *
 *   POST /v1/authorizations ─▶ pending ─▶ job junction.decide
 *        decide:  [emit authorization.pending, seq 1]; schedule resolve at +latency
 *        resolve: authorized|declined; emit authorization.succeeded|failed, seq 2 (+dups)
 *                 [out_of_order: stale seq-1 pending emitted *after* seq 2]
 */
import { randomInt } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { type Clock, enqueue, type Settings, systemClock, type Tx } from "@mintrail/shared";

import { choosePlan, DECLINE_REASONS, type Plan, planFromDict } from "./scenarios.js";
import { BankStatus, type JunctionAuthorization, junctionAuthorizations } from "./schema.js";

export const QUEUE = "junction";
export const JOB_DECIDE = "junction.decide";
export const JOB_RESOLVE = "junction.resolve";
export const JOB_DELIVER = "junction.deliver_callback";
export const EVENT_PENDING = "authorization.pending";
export const EVENT_SUCCEEDED = "authorization.succeeded";
export const EVENT_FAILED = "authorization.failed";
const SEQ_PENDING = 1;
const SEQ_FINAL = 2;
export const DELIVERY_MAX_ATTEMPTS = 8;

export class BankError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AuthorizeRequest {
  paymentId: string;
  merchantRef: string;
  amount: bigint;
  currency: string;
  method: string;
  instrument: string;
  livemode: boolean;
  scenario: string | null;
}

/** Bank reference in the style of a 12-digit RRN. */
export const newRef = (): string => `JN${Array.from({ length: 12 }, () => randomInt(10)).join("")}`;

/** Python ``datetime.isoformat()`` for an aware UTC datetime. */
export const pyIsoformat = (d: Date): string => d.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");

export class Bank {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Returns ``[row, accepted]``; ``accepted=false`` means "answer 503". */
  async authorize(req: AuthorizeRequest): Promise<[JunctionAuthorization, boolean]> {
    let [row] = await this.tx
      .select()
      .from(junctionAuthorizations)
      .where(eq(junctionAuthorizations.paymentId, req.paymentId))
      .for("update");
    if (!row) {
      const p = choosePlan({
        seed: this.settings.junction_seed,
        paymentId: req.paymentId,
        method: req.method,
        instrument: req.instrument,
        scenario: req.scenario,
        livemode: req.livemode,
      });
      [row] = await this.tx
        .insert(junctionAuthorizations)
        .values({
          ref: newRef(),
          paymentId: req.paymentId,
          merchantRef: req.merchantRef,
          amount: req.amount,
          currency: req.currency,
          method: req.method,
          instrument: req.instrument,
          livemode: req.livemode,
          scenario: req.scenario,
          status: BankStatus.RECEIVED,
          plan: { ...p },
          sequence: 0,
          requestsSeen: 0,
        })
        .returning();
    } else if (row.amount !== req.amount || row.currency !== req.currency) {
      throw new BankError("duplicate_mismatch", "payment_id reused with a different amount", 409);
    }
    const p = planFromDict(row!.plan);
    let status = row!.status;
    const seen = row!.requestsSeen + 1;
    let accepted = true;
    if (status === BankStatus.RECEIVED) {
      if (seen <= p.unavailable_attempts) {
        accepted = false;
      } else {
        status = BankStatus.PENDING;
        await enqueue(this.tx, JOB_DECIDE, { ref: row!.ref }, { queue: QUEUE, dedupeKey: `junction:decide:${row!.ref}` });
      }
    }
    const [updated] = await this.tx
      .update(junctionAuthorizations)
      .set({ requestsSeen: seen, status, updatedAt: sql`now()` })
      .where(eq(junctionAuthorizations.ref, row!.ref))
      .returning();
    return [updated!, accepted];
  }

  async get(ref: string, lock = false): Promise<JunctionAuthorization> {
    const q = this.tx.select().from(junctionAuthorizations).where(eq(junctionAuthorizations.ref, ref));
    const [row] = await (lock ? q.for("update") : q);
    if (!row) throw new BankError("not_found", `no authorization ${ref}`, 404);
    return row;
  }

  async findByPayment(paymentId: string): Promise<JunctionAuthorization | null> {
    const [row] = await this.tx.select().from(junctionAuthorizations).where(eq(junctionAuthorizations.paymentId, paymentId));
    return row ?? null;
  }

  private async setStatus(ref: string, values: Partial<typeof junctionAuthorizations.$inferInsert>): Promise<JunctionAuthorization> {
    const [row] = await this.tx
      .update(junctionAuthorizations)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(junctionAuthorizations.ref, ref))
      .returning();
    return row!;
  }

  async capture(ref: string, amount: bigint): Promise<JunctionAuthorization> {
    const row = await this.get(ref, true);
    if (row.status === BankStatus.CAPTURED) return row;
    if (row.status !== BankStatus.AUTHORIZED) throw new BankError("not_capturable", `authorization is ${row.status}`, 409);
    if (amount !== row.amount) throw new BankError("amount_mismatch", "partial capture is not supported", 422);
    return this.setStatus(ref, { status: BankStatus.CAPTURED });
  }

  async void(ref: string): Promise<JunctionAuthorization> {
    const row = await this.get(ref, true);
    if (row.status === BankStatus.VOIDED || row.status === BankStatus.DECLINED) return row;
    if (row.status === BankStatus.CAPTURED) throw new BankError("already_captured", "captured payments must be refunded", 409);
    return this.setStatus(ref, { status: BankStatus.VOIDED });
  }

  // ---------------------------------------------------------------- simulation
  async decide(ref: string): Promise<void> {
    let row = await this.get(ref, true);
    if (row.status !== BankStatus.PENDING) return;
    const p = planFromDict(row.plan);
    if (p.pending_first && !p.out_of_order) row = await this.emit(row, EVENT_PENDING, SEQ_PENDING);
    if (p.final !== "none") {
      await enqueue(
        this.tx,
        JOB_RESOLVE,
        { ref: row.ref },
        {
          queue: QUEUE,
          runAt: new Date(this.clock.now().getTime() + this.scaled(p.latency_s)),
          dedupeKey: `junction:resolve:${row.ref}`,
        },
      );
    }
  }

  async resolve(ref: string): Promise<void> {
    let row = await this.get(ref, true);
    if (row.status !== BankStatus.PENDING) return; // voided while the customer was deciding
    const p: Plan = planFromDict(row.plan);
    let eventType: string;
    if (p.final === "authorized") {
      row = await this.setStatus(ref, { status: BankStatus.AUTHORIZED });
      eventType = EVENT_SUCCEEDED;
    } else {
      row = await this.setStatus(ref, { status: BankStatus.DECLINED, declineCode: p.decline_code });
      eventType = EVENT_FAILED;
    }
    row = await this.emit(row, eventType, SEQ_FINAL, 1 + p.duplicates);
    if (p.pending_first && p.out_of_order) await this.emit(row, EVENT_PENDING, SEQ_PENDING, 1, 1);
  }

  private scaled(seconds: number): number {
    return seconds * this.settings.junction_latency_scale * 1000;
  }

  private async emit(row: JunctionAuthorization, type: string, sequence: number, copies = 1, delayS = 0): Promise<JunctionAuthorization> {
    const now = this.clock.now();
    const event = eventPayload(row, type, sequence, now);
    const updated = await this.setStatus(row.ref, { sequence: Math.max(row.sequence, sequence) });
    for (let copy = 0; copy < copies; copy++) {
      await enqueue(this.tx, JOB_DELIVER, event, {
        queue: QUEUE,
        runAt: new Date(now.getTime() + this.scaled(delayS + 0.5 * copy)),
        maxAttempts: DELIVERY_MAX_ATTEMPTS,
        dedupeKey: `junction:deliver:${event.id as string}:${copy}`,
      });
    }
    return updated;
  }
}

export function eventPayload(row: JunctionAuthorization, type: string, sequence: number, now: Date): Record<string, unknown> {
  const declineCode = type === EVENT_FAILED ? row.declineCode : null;
  return {
    id: `jev_${row.ref}_${sequence}`,
    type,
    sequence,
    ref: row.ref,
    payment_id: row.paymentId,
    amount: row.amount,
    currency: row.currency,
    decline_code: declineCode,
    decline_reason: declineCode ? (DECLINE_REASONS[declineCode] ?? null) : null,
    occurred_at: pyIsoformat(now),
  };
}
