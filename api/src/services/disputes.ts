/**
 * Disputes / chargebacks (ADR-0015).
 *
 *   Junction dispute.opened ─▶ needs_response ──submit evidence──▶ under_review ─▶ won | lost
 *                                    └──accept / deadline passes──────────────────▶ lost
 *
 * Opening a dispute moves the amount from the merchant's dispute_reserve to
 * dispute_clearing (the reserve may go negative: the merchant owes it, and
 * Depot recovers it from the next settlement). Won returns it; lost pays it to
 * the network out of customer funds.
 *
 * Evidence: up to ``evidence_max_files`` files of at most ``evidence_max_bytes``,
 * accepted only if the *content* is a PDF, PNG or JPEG (magic bytes, not the
 * client's Content-Type or filename).
 */
import { createHash } from "node:crypto";

import { and, asc, count, desc, eq, inArray, lt, sql } from "drizzle-orm";

import {
  type Clock,
  ConflictError,
  type Currency,
  enqueue,
  ErrorCode,
  IdPrefix,
  InvalidRequestError,
  log,
  MintRailError,
  Money,
  newId,
  NotFoundError,
  type Settings,
  systemClock,
  type Tx,
} from "@mintrail/shared";
import { LedgerService, recordDisputeClosed, recordDisputeOpened } from "@mintrail/ledger";
import { emit } from "@mintrail/signal";

import { disputeOut } from "../http/out.js";
import { type JunctionClient, JunctionRejectedError, JunctionUnavailableError } from "../junction-client.js";
import { type Dispute, disputeEvidence, type DisputeEvidence, disputes, type DisputeStatus, payments } from "../schema/index.js";
import { QUEUE } from "./payments.js";
import type { Principal } from "./stations.js";

export const JOB_DISPUTE_DEADLINE = "payments.dispute_deadline";
export const EVIDENCE_KINDS = ["receipt", "shipping_proof", "customer_communication", "refund_policy", "other"] as const;

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Sniff the real content type from the first bytes. */
export function sniffContentType(buf: Buffer): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(-200) || "evidence";
const toDate = (v: string): Date => new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));

export class DisputeService {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly junctionClient: JunctionClient | null = null,
    private readonly clock: Clock = systemClock,
  ) {}

  private get junction(): JunctionClient {
    if (!this.junctionClient) throw new Error("DisputeService needs a JunctionClient for this operation");
    return this.junctionClient;
  }

  async get(principal: Principal | null, id: string, lock = false): Promise<Dispute> {
    const where = [eq(disputes.id, id)];
    if (principal) where.push(eq(disputes.stationId, principal.station.id), eq(disputes.livemode, principal.livemode));
    const q = this.tx
      .select()
      .from(disputes)
      .where(and(...where));
    const [d] = await (lock ? q.for("update") : q);
    if (!d) throw new NotFoundError(`dispute ${id} not found`, { code: ErrorCode.DISPUTE_NOT_FOUND });
    return d;
  }

  evidence(disputeId: string): Promise<DisputeEvidence[]> {
    return this.tx
      .select()
      .from(disputeEvidence)
      .where(eq(disputeEvidence.disputeId, disputeId))
      .orderBy(asc(disputeEvidence.createdAt), asc(disputeEvidence.id));
  }

  async evidenceFile(principal: Principal | null, disputeId: string, fileId: string): Promise<DisputeEvidence> {
    await this.get(principal, disputeId);
    const [f] = await this.tx
      .select()
      .from(disputeEvidence)
      .where(and(eq(disputeEvidence.id, fileId), eq(disputeEvidence.disputeId, disputeId)));
    if (!f) throw new NotFoundError(`evidence ${fileId} not found`);
    return f;
  }

  async list(
    principal: Principal | null,
    opts: {
      limit: number;
      startingAfter?: string | null;
      status?: DisputeStatus | null;
      paymentId?: string | null;
      stationId?: string | null;
    },
  ): Promise<[Dispute[], boolean]> {
    const where = [];
    if (principal) where.push(eq(disputes.stationId, principal.station.id), eq(disputes.livemode, principal.livemode));
    if (opts.stationId) where.push(eq(disputes.stationId, opts.stationId));
    if (opts.startingAfter) where.push(lt(disputes.id, opts.startingAfter));
    if (opts.status) where.push(eq(disputes.status, opts.status));
    if (opts.paymentId) where.push(eq(disputes.paymentId, opts.paymentId));
    const rows = await this.tx
      .select()
      .from(disputes)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(disputes.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  /** Test helper: ask Junction to raise a chargeback on a captured *test-mode* payment. */
  async simulate(paymentId: string, args: { amount: bigint | null; reason: string; outcome: "win" | "lose" | null }, stationId?: string) {
    const [p] = await this.tx.select().from(payments).where(eq(payments.id, paymentId));
    if (!p || (stationId && p.stationId !== stationId))
      throw new NotFoundError(`payment ${paymentId} not found`, { code: ErrorCode.PAYMENT_NOT_FOUND });
    if (p.livemode)
      throw new InvalidRequestError("disputes can only be simulated for test-mode payments", { code: ErrorCode.SCENARIO_NOT_ALLOWED });
    if (p.status !== "captured") throw new ConflictError(`payment is ${p.status}; only captured payments can be disputed`);
    try {
      return await this.junction.openDispute({ authRef: p.junctionRef!, amount: args.amount, reason: args.reason, scenario: args.outcome });
    } catch (e) {
      if (e instanceof JunctionRejectedError) throw new ConflictError(`bank rejected the dispute: ${e.detail}`);
      if (e instanceof JunctionUnavailableError) throw new MintRailError("bank unavailable", { code: ErrorCode.GATEWAY_ERROR });
      throw e;
    }
  }

  /** Junction ``dispute.opened``. Idempotent by network reference. */
  async applyOpened(event: Record<string, unknown>): Promise<string> {
    const ref = String(event.ref);
    const [existing] = await this.tx.select().from(disputes).where(eq(disputes.junctionRef, ref));
    if (existing) return "duplicate";
    const [p] = await this.tx
      .select()
      .from(payments)
      .where(eq(payments.id, String(event.payment_id)))
      .for("update");
    if (!p) {
      log.error({ derailment: "dispute_unknown_payment", ref }, "DERAILMENT: chargeback for an unknown payment");
      return "ignored";
    }
    const amount = BigInt(event.amount as bigint);
    const due = toDate(String(event.due_at).replace(/\.\d+/, ""));
    const [d] = await this.tx
      .insert(disputes)
      .values({
        id: newId(IdPrefix.DISPUTE, BigInt(this.clock.now().getTime())),
        paymentId: p.id,
        stationId: p.stationId,
        livemode: p.livemode,
        amount,
        currency: p.currency,
        reason: String(event.reason ?? "general"),
        status: "needs_response",
        junctionRef: ref,
        evidenceDueBy: due.toISOString(),
      })
      .returning();
    await recordDisputeOpened(new LedgerService(this.tx, this.clock), {
      stationId: p.stationId,
      disputeId: d!.id,
      amount: Money.of(amount, p.currency as Currency),
      livemode: p.livemode,
    });
    await enqueue(
      this.tx,
      JOB_DISPUTE_DEADLINE,
      { dispute_id: d!.id },
      { queue: QUEUE, runAt: due, dedupeKey: `payments:dispute_deadline:${d!.id}` },
    );
    await this.publish(d!, "dispute.created");
    return "applied";
  }

  async addEvidence(
    principal: Principal | null,
    disputeId: string,
    args: { files: UploadedFile[]; kind: string; text: string | null; uploadedBy: string },
  ): Promise<[Dispute, DisputeEvidence[]]> {
    let d = await this.get(principal, disputeId, true);
    if (d.status !== "needs_response") {
      throw new ConflictError(`dispute is ${d.status}; evidence can no longer be added`, { code: ErrorCode.DISPUTE_NOT_ACTIONABLE });
    }
    if (!(EVIDENCE_KINDS as readonly string[]).includes(args.kind))
      throw new InvalidRequestError(`unknown evidence kind '${args.kind}'`, { param: "kind" });
    if (args.files.length === 0 && !args.text)
      throw new InvalidRequestError("upload at least one file or provide text", { code: ErrorCode.INVALID_EVIDENCE });
    const [existing] = await this.tx.select({ n: count() }).from(disputeEvidence).where(eq(disputeEvidence.disputeId, d.id));
    if ((existing?.n ?? 0) + args.files.length > this.settings.evidence_max_files) {
      throw new InvalidRequestError(`at most ${this.settings.evidence_max_files} evidence files per dispute`, {
        code: ErrorCode.INVALID_EVIDENCE,
      });
    }
    for (const f of args.files) {
      if (f.size === 0 || f.size > this.settings.evidence_max_bytes) {
        throw new InvalidRequestError(`${safeName(f.originalname)} must be between 1 byte and ${this.settings.evidence_max_bytes} bytes`, {
          code: ErrorCode.INVALID_EVIDENCE,
        });
      }
      if (sniffContentType(f.buffer) === null) {
        throw new InvalidRequestError(`${safeName(f.originalname)} is not a PDF, PNG or JPEG file`, {
          code: ErrorCode.INVALID_EVIDENCE,
          param: "files",
        });
      }
    }
    for (const f of args.files) {
      await this.tx.insert(disputeEvidence).values({
        id: newId(IdPrefix.EVIDENCE_FILE),
        disputeId: d.id,
        kind: args.kind,
        filename: safeName(f.originalname),
        contentType: sniffContentType(f.buffer)!,
        sizeBytes: f.size,
        sha256: createHash("sha256").update(f.buffer).digest("hex"),
        content: f.buffer,
        uploadedBy: args.uploadedBy,
        createdAt: sql`clock_timestamp()` as unknown as string, // keeps upload order within one request
      });
    }
    if (args.text) {
      [d] = (await this.tx
        .update(disputes)
        .set({ evidenceText: args.text.slice(0, 5000), updatedAt: this.clock.now().toISOString() })
        .where(eq(disputes.id, d.id))
        .returning()) as [Dispute];
    }
    return [d, await this.evidence(d.id)];
  }

  async submit(principal: Principal | null, disputeId: string): Promise<Dispute> {
    const d = await this.get(principal, disputeId, true);
    if (d.status !== "needs_response") throw new ConflictError(`dispute is ${d.status}`, { code: ErrorCode.DISPUTE_NOT_ACTIONABLE });
    const files = await this.evidence(d.id);
    if (files.length === 0 && !d.evidenceText)
      throw new InvalidRequestError("add evidence before submitting", { code: ErrorCode.INVALID_EVIDENCE });
    if (toDate(d.evidenceDueBy).getTime() < this.clock.now().getTime()) {
      throw new ConflictError("the evidence deadline has passed", { code: ErrorCode.DISPUTE_NOT_ACTIONABLE });
    }
    await this.callJunction(() => this.junction.submitDisputeEvidence(d.junctionRef, files.length + (d.evidenceText ? 1 : 0)));
    const [u] = await this.tx
      .update(disputes)
      .set({ status: "under_review", evidenceSubmittedAt: this.clock.now().toISOString(), updatedAt: this.clock.now().toISOString() })
      .where(eq(disputes.id, d.id))
      .returning();
    return u!;
  }

  /** The merchant (or staff on their behalf, or the deadline) concedes: lost now. */
  async accept(principal: Principal | null, disputeId: string, reason = "accepted by merchant"): Promise<Dispute> {
    const d = await this.get(principal, disputeId, true);
    if (d.status === "lost") return d;
    if (d.status !== "needs_response") throw new ConflictError(`dispute is ${d.status}`, { code: ErrorCode.DISPUTE_NOT_ACTIONABLE });
    await this.callJunction(() => this.junction.acceptDispute(d.junctionRef));
    return this.close(d, false, reason);
  }

  /** Job ``payments.dispute_deadline``. */
  async deadline(disputeId: string): Promise<void> {
    const d = await this.get(null, disputeId, true);
    if (d.status === "needs_response") await this.accept(null, d.id, "evidence deadline passed");
  }

  /** Junction ``dispute.won`` / ``dispute.lost``. */
  async applyClosed(event: Record<string, unknown>): Promise<string> {
    const [d] = await this.tx
      .select()
      .from(disputes)
      .where(eq(disputes.junctionRef, String(event.ref)))
      .for("update");
    if (!d) return "ignored";
    if (d.status === "won" || d.status === "lost") return "ignored";
    await this.close(
      d,
      event.type === "dispute.won",
      event.type === "dispute.won" ? "evidence accepted by the issuer" : "issuer ruled for the cardholder",
    );
    return "applied";
  }

  private async close(d: Dispute, won: boolean, reason: string): Promise<Dispute> {
    const [u] = await this.tx
      .update(disputes)
      .set({
        status: won ? "won" : "lost",
        outcomeReason: reason,
        closedAt: this.clock.now().toISOString(),
        updatedAt: this.clock.now().toISOString(),
      })
      .where(eq(disputes.id, d.id))
      .returning();
    await recordDisputeClosed(new LedgerService(this.tx, this.clock), {
      stationId: d.stationId,
      disputeId: d.id,
      amount: Money.of(d.amount, d.currency as Currency),
      livemode: d.livemode,
      won,
    });
    await this.publish(u!, "dispute.closed");
    return u!;
  }

  private async callJunction<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof JunctionRejectedError)
        throw new ConflictError(`bank rejected the request: ${e.detail}`, { code: ErrorCode.DISPUTE_NOT_ACTIONABLE });
      if (e instanceof JunctionUnavailableError)
        throw new MintRailError(`bank unavailable: ${e.message}`, { code: ErrorCode.GATEWAY_ERROR });
      throw e;
    }
  }

  private async publish(d: Dispute, type: "dispute.created" | "dispute.closed"): Promise<void> {
    await emit(this.tx, { stationId: d.stationId, livemode: d.livemode, type, object: disputeOut(d) }, this.clock);
  }

  static openStatuses = ["needs_response", "under_review"] as const;
  countOpen(stationId: string, livemode: boolean) {
    return this.tx
      .select({ n: count() })
      .from(disputes)
      .where(
        and(eq(disputes.stationId, stationId), eq(disputes.livemode, livemode), inArray(disputes.status, [...DisputeService.openStatuses])),
      );
  }
}
