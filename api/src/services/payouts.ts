/**
 * Freight — payouts from a Station's balance (ADR-0016).
 *
 *   create ─▶ queued ──submit──▶ processing ──payout.processed──▶ processed
 *     │                              └──────payout.failed───────▶ failed (funds returned)
 *     └─(amount ≥ approval threshold)─▶ pending_approval ─approve─▶ queued
 *                                              ├─reject (Railyard)─▶ rejected (funds returned)
 *                                              └─cancel (merchant)─▶ cancelled (funds returned)
 *
 * Funds are reserved in the ledger at creation. A per-Station advisory lock
 * serialises creation so the IST-day limit cannot be raced.
 */
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import {
  type Clock,
  ConflictError,
  enqueue,
  ErrorCode,
  IdPrefix,
  InvalidAmountError,
  InvalidRequestError,
  istStartOf,
  istDate,
  addDays,
  MintRailError,
  Money,
  newId,
  NotFoundError,
  type Settings,
  systemClock,
  type Tx,
} from "@mintrail/shared";
import { LedgerService, recordPayoutInitiated, recordPayoutPaid, recordPayoutReversed } from "@mintrail/ledger";
import { emit } from "@mintrail/signal";

import { parseCsv } from "../csv.js";
import { payoutOut } from "../http/out.js";
import { type JunctionClient, JunctionRejectedError } from "../junction-client.js";
import { type Payout, type PayoutBatch, payoutBatches, type PayoutMode, payouts, type PayoutStatus } from "../schema/index.js";
import { QUEUE, SCENARIO_RE } from "./payments.js";
import { getPolicy } from "./policies.js";
import type { Principal } from "./stations.js";

export const JOB_PAYOUT_SUBMIT = "payments.payout_submit";
export const PURPOSES = ["vendor_bill", "salary", "refund", "cashback", "payout", "utility_bill", "rent", "other"] as const;

/** Per-transaction rail limits (paise). */
const MODE_LIMITS: Record<PayoutMode, [bigint, bigint]> = {
  IMPS: [100n, 5_00_000_00n],
  UPI: [100n, 1_00_000_00n],
  NEFT: [100n, 10_00_00_000_00n],
  RTGS: [2_00_000_00n, 10_00_00_000_00n],
};
const RELEASED: PayoutStatus[] = ["failed", "rejected", "cancelled"];

export interface PayoutInput {
  amount: bigint;
  mode: PayoutMode;
  purpose: string;
  beneficiary: { name: string; account_number?: string | null; ifsc?: string | null; vpa?: string | null };
  reference?: string | null;
  narration?: string | null;
}

export function validatePayout(i: PayoutInput): void {
  const name = i.beneficiary.name?.trim() ?? "";
  if (name.length < 3 || name.length > 120)
    throw new InvalidRequestError("beneficiary name must be 3-120 characters", {
      code: ErrorCode.INVALID_BENEFICIARY,
      param: "beneficiary.name",
    });
  if (i.mode === "UPI") {
    if (!i.beneficiary.vpa || !/^[a-z0-9.\-_]{2,256}@[a-z][a-z0-9]{1,63}$/i.test(i.beneficiary.vpa)) {
      throw new InvalidRequestError("UPI payouts need a valid vpa", { code: ErrorCode.INVALID_BENEFICIARY, param: "beneficiary.vpa" });
    }
    if (i.beneficiary.account_number || i.beneficiary.ifsc)
      throw new InvalidRequestError("UPI payouts take a vpa, not a bank account", {
        code: ErrorCode.INVALID_BENEFICIARY,
        param: "beneficiary",
      });
  } else {
    if (!i.beneficiary.account_number || !/^\d{9,18}$/.test(i.beneficiary.account_number)) {
      throw new InvalidRequestError("account_number must be 9-18 digits", {
        code: ErrorCode.INVALID_BENEFICIARY,
        param: "beneficiary.account_number",
      });
    }
    if (!i.beneficiary.ifsc || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(i.beneficiary.ifsc)) {
      throw new InvalidRequestError("ifsc must look like HDFC0001234", { code: ErrorCode.INVALID_BENEFICIARY, param: "beneficiary.ifsc" });
    }
    if (i.beneficiary.vpa)
      throw new InvalidRequestError("bank payouts take an account, not a vpa", {
        code: ErrorCode.INVALID_BENEFICIARY,
        param: "beneficiary.vpa",
      });
  }
  const [min, max] = MODE_LIMITS[i.mode];
  if (i.amount < min || i.amount > max)
    throw new InvalidAmountError(`${i.mode} payouts must be between ${min} and ${max} paise`, { param: "amount" });
  if (!(PURPOSES as readonly string[]).includes(i.purpose))
    throw new InvalidRequestError(`unknown purpose '${i.purpose}'`, { param: "purpose" });
  if (i.reference && i.reference.length > 40)
    throw new InvalidRequestError("reference must be at most 40 characters", { param: "reference" });
  if (i.narration && !/^[A-Za-z0-9 ]{1,30}$/.test(i.narration))
    throw new InvalidRequestError("narration must be 1-30 letters, digits or spaces", { param: "narration" });
}

export class PayoutService {
  constructor(
    readonly tx: Tx,
    private readonly settings: Settings,
    private readonly junctionClient: JunctionClient | null = null,
    private readonly clock: Clock = systemClock,
  ) {}

  private get junction(): JunctionClient {
    if (!this.junctionClient) throw new Error("PayoutService needs a JunctionClient for this operation");
    return this.junctionClient;
  }

  private ledger(): LedgerService {
    return new LedgerService(this.tx, this.clock);
  }

  async create(
    principal: Principal,
    input: PayoutInput,
    opts: { batchId?: string | null; scenario?: string | null } = {},
  ): Promise<Payout> {
    validatePayout(input);
    if (opts.scenario) {
      if (principal.livemode)
        throw new InvalidRequestError("test scenarios are only available in test mode", { code: ErrorCode.SCENARIO_NOT_ALLOWED });
      if (!SCENARIO_RE.test(opts.scenario)) throw new InvalidRequestError("malformed test scenario", { param: "MintRail-Test-Scenario" });
    }
    const stationId = principal.station.id;
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`payouts:${stationId}`}))`);
    const policy = await getPolicy(this.tx, this.settings, stationId);
    const today = istDate(this.clock.now());
    const [used] = await this.tx
      .select({ n: sql<string>`coalesce(sum(${payouts.amount}), 0)::text` })
      .from(payouts)
      .where(
        and(
          eq(payouts.stationId, stationId),
          eq(payouts.livemode, principal.livemode),
          notInArray(payouts.status, RELEASED),
          sql`${payouts.createdAt} >= ${istStartOf(today).toISOString()} AND ${payouts.createdAt} < ${istStartOf(addDays(today, 1)).toISOString()}`,
        ),
      );
    const usedToday = BigInt(used!.n);
    if (usedToday + input.amount > policy.payoutDailyLimit) {
      throw new MintRailError(`daily payout limit of ${policy.payoutDailyLimit} paise reached (used ${usedToday})`, {
        code: ErrorCode.PAYOUT_LIMIT_EXCEEDED,
        param: "amount",
        details: { daily_limit: policy.payoutDailyLimit, used_today: usedToday },
      });
    }
    const needsApproval = input.amount >= policy.payoutApprovalThreshold;
    const [p] = await this.tx
      .insert(payouts)
      .values({
        id: newId(IdPrefix.PAYOUT, BigInt(this.clock.now().getTime())),
        stationId,
        livemode: principal.livemode,
        batchId: opts.batchId ?? null,
        amount: input.amount,
        currency: "INR",
        mode: input.mode,
        purpose: input.purpose,
        beneficiaryName: input.beneficiary.name.trim(),
        accountNumber: input.beneficiary.account_number ?? null,
        ifsc: input.beneficiary.ifsc ?? null,
        vpa: input.beneficiary.vpa ?? null,
        reference: input.reference ?? null,
        narration: input.narration ?? null,
        status: needsApproval ? "pending_approval" : "queued",
        testScenario: opts.scenario ?? null,
      })
      .returning();
    await recordPayoutInitiated(this.ledger(), { stationId, payoutId: p!.id, amount: Money.of(p!.amount, "INR"), livemode: p!.livemode });
    if (!needsApproval) await this.enqueueSubmit(p!);
    return p!;
  }

  async get(principal: Principal | null, id: string, lock = false): Promise<Payout> {
    const where = [eq(payouts.id, id)];
    if (principal) where.push(eq(payouts.stationId, principal.station.id), eq(payouts.livemode, principal.livemode));
    const q = this.tx
      .select()
      .from(payouts)
      .where(and(...where));
    const [p] = await (lock ? q.for("update") : q);
    if (!p) throw new NotFoundError(`payout ${id} not found`, { code: ErrorCode.PAYOUT_NOT_FOUND });
    return p;
  }

  async list(
    principal: Principal | null,
    opts: {
      limit: number;
      startingAfter?: string | null;
      status?: PayoutStatus | null;
      batchId?: string | null;
      stationId?: string | null;
    },
  ): Promise<[Payout[], boolean]> {
    const where = [];
    if (principal) where.push(eq(payouts.stationId, principal.station.id), eq(payouts.livemode, principal.livemode));
    if (opts.stationId) where.push(eq(payouts.stationId, opts.stationId));
    if (opts.startingAfter) where.push(lt(payouts.id, opts.startingAfter));
    if (opts.status) where.push(eq(payouts.status, opts.status));
    if (opts.batchId) where.push(eq(payouts.batchId, opts.batchId));
    const rows = await this.tx
      .select()
      .from(payouts)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(payouts.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  async approve(staffId: string, id: string): Promise<Payout> {
    const p = await this.get(null, id, true);
    if (p.status !== "pending_approval") throw new ConflictError(`payout is ${p.status}`, { code: ErrorCode.PAYOUT_NOT_ACTIONABLE });
    const u = await this.update(p, { status: "queued", approvedBy: staffId, approvedAt: this.clock.now().toISOString() });
    await this.enqueueSubmit(u);
    return u;
  }

  async reject(staffId: string, id: string, reason: string): Promise<Payout> {
    const p = await this.get(null, id, true);
    if (p.status !== "pending_approval") throw new ConflictError(`payout is ${p.status}`, { code: ErrorCode.PAYOUT_NOT_ACTIONABLE });
    const u = await this.update(p, { status: "rejected", approvedBy: staffId, rejectedReason: reason });
    await recordPayoutReversed(this.ledger(), { payoutId: p.id });
    return u;
  }

  async cancel(principal: Principal, id: string): Promise<Payout> {
    const p = await this.get(principal, id, true);
    if (p.status !== "pending_approval")
      throw new ConflictError(`payout is ${p.status}; only payouts awaiting approval can be cancelled`, {
        code: ErrorCode.PAYOUT_NOT_ACTIONABLE,
      });
    const u = await this.update(p, { status: "cancelled" });
    await recordPayoutReversed(this.ledger(), { payoutId: p.id });
    return u;
  }

  /** Job ``payments.payout_submit``. */
  async submit(id: string): Promise<void> {
    const p = await this.get(null, id, true);
    if (p.status !== "queued") return;
    try {
      const res = await this.junction.payout({
        payoutId: p.id,
        amount: p.amount,
        mode: p.mode,
        destination: p.vpa ?? `${p.ifsc}:${p.accountNumber}`,
        livemode: p.livemode,
        scenario: p.testScenario,
      });
      await this.update(p, { status: "processing", junctionRef: String(res.ref) });
    } catch (e) {
      if (!(e instanceof JunctionRejectedError)) throw e;
      await this.fail(p, `bank_${e.code}`);
    }
  }

  /** Junction ``payout.processed`` / ``payout.failed``. */
  async applyEvent(event: Record<string, unknown>): Promise<string> {
    const p = await this.get(null, String(event.payout_id), true);
    if (p.status !== "processing" && p.status !== "queued") return "ignored";
    if (event.type === "payout.processed") {
      const u = await this.update(p, {
        status: "processed",
        utr: String(event.utr),
        junctionRef: String(event.ref),
        processedAt: this.clock.now().toISOString(),
      });
      await recordPayoutPaid(this.ledger(), { payoutId: p.id, amount: Money.of(p.amount, "INR"), livemode: p.livemode });
      await emit(this.tx, { stationId: u.stationId, livemode: u.livemode, type: "payout.processed", object: payoutOut(u) }, this.clock);
    } else {
      await this.fail(p, String(event.failure_reason ?? "bank_failure"));
    }
    return "applied";
  }

  private async fail(p: Payout, reason: string): Promise<Payout> {
    const u = await this.update(p, { status: "failed", failureReason: reason.slice(0, 200), failedAt: this.clock.now().toISOString() });
    await recordPayoutReversed(this.ledger(), { payoutId: p.id });
    await emit(this.tx, { stationId: u.stationId, livemode: u.livemode, type: "payout.failed", object: payoutOut(u) }, this.clock);
    return u;
  }

  // ------------------------------------------------------------ bulk CSV
  static readonly CSV_HEADER = ["beneficiary_name", "account_number", "ifsc", "vpa", "amount", "mode", "purpose", "reference", "narration"];

  /**
   * Import a payout CSV (amount in rupees, e.g. ``1500.00``). Each row is created in its
   * own savepoint, so bad rows are reported without rejecting the good ones.
   */
  async bulk(principal: Principal, args: { csv: string; filename: string; createdBy: string }): Promise<[PayoutBatch, Payout[]]> {
    const rows = parseCsv(args.csv);
    if (rows.length < 2) throw new InvalidRequestError("CSV needs a header row and at least one payout", { param: "file" });
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const missing = ["beneficiary_name", "amount", "mode", "purpose"].filter((h) => !header.includes(h));
    if (missing.length) throw new InvalidRequestError(`CSV is missing columns: ${missing.join(", ")}`, { param: "file" });
    const body = rows.slice(1);
    if (body.length > this.settings.payout_csv_max_rows)
      throw new InvalidRequestError(`at most ${this.settings.payout_csv_max_rows} rows per file`, { param: "file" });
    const batchId = newId(IdPrefix.PAYOUT_BATCH);
    await this.tx.insert(payoutBatches).values({
      id: batchId,
      stationId: principal.station.id,
      livemode: principal.livemode,
      filename: args.filename.slice(0, 200),
      rowCount: body.length,
      acceptedCount: 0,
      rejectedCount: 0,
      totalAmount: 0n,
      createdBy: args.createdBy,
    });
    const created: Payout[] = [];
    const errors: Record<string, unknown>[] = [];
    for (const [i, r] of body.entries()) {
      const col = (name: string) => {
        const idx = header.indexOf(name);
        const v = idx < 0 ? "" : (r[idx] ?? "").trim();
        return v === "" ? null : v;
      };
      try {
        const amount = col("amount");
        if (!amount || !/^\d{1,13}(\.\d{1,2})?$/.test(amount))
          throw new InvalidAmountError("amount must be rupees like 1500 or 1500.50", { param: "amount" });
        const p = await this.tx.transaction((sp) =>
          new PayoutService(sp, this.settings, this.junctionClient, this.clock).create(
            principal,
            {
              amount: Money.fromMajor(amount, "INR").amount,
              mode: (col("mode") ?? "").toUpperCase() as PayoutMode,
              purpose: col("purpose") ?? "",
              beneficiary: {
                name: col("beneficiary_name") ?? "",
                account_number: col("account_number"),
                ifsc: col("ifsc")?.toUpperCase(),
                vpa: col("vpa"),
              },
              reference: col("reference"),
              narration: col("narration"),
            },
            { batchId },
          ),
        );
        created.push(p);
      } catch (e) {
        if (!(e instanceof MintRailError)) throw e;
        errors.push({ row: BigInt(i + 2), code: e.code, message: e.message, param: e.param });
      }
    }
    const [batch] = await this.tx
      .update(payoutBatches)
      .set({
        acceptedCount: created.length,
        rejectedCount: errors.length,
        totalAmount: created.reduce((a, p) => a + p.amount, 0n),
        errors,
      })
      .where(eq(payoutBatches.id, batchId))
      .returning();
    return [batch!, created];
  }

  async batch(principal: Principal, id: string): Promise<[PayoutBatch, Payout[]]> {
    const [b] = await this.tx
      .select()
      .from(payoutBatches)
      .where(
        and(eq(payoutBatches.id, id), eq(payoutBatches.stationId, principal.station.id), eq(payoutBatches.livemode, principal.livemode)),
      );
    if (!b) throw new NotFoundError(`payout batch ${id} not found`);
    return [b, await this.tx.select().from(payouts).where(eq(payouts.batchId, id)).orderBy(payouts.id)];
  }

  pendingApproval(limit: number) {
    return this.tx
      .select()
      .from(payouts)
      .where(inArray(payouts.status, ["pending_approval"]))
      .orderBy(payouts.id)
      .limit(limit);
  }

  private async enqueueSubmit(p: Payout): Promise<void> {
    await enqueue(this.tx, JOB_PAYOUT_SUBMIT, { payout_id: p.id }, { queue: QUEUE, dedupeKey: `payments:payout_submit:${p.id}` });
  }

  private async update(p: Payout, values: Partial<typeof payouts.$inferInsert>): Promise<Payout> {
    const [row] = await this.tx
      .update(payouts)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(payouts.id, p.id))
      .returning();
    return row!;
  }
}
