/**
 * The seed simulation: 90 days of a payments business, one IST day at a time.
 *
 *   for each day D:
 *     events 00:00–11:00  → flush rows + ledger
 *     Depot settlement run for D at 11:00 (the real engine), bank credits at 14:00
 *     events 11:00–24:00  → flush rows + ledger
 *
 * Every money movement goes through the production ledger recipes (via
 * BufferedLedger), so reconciliation must come out clean.
 */
import { createHash } from "node:crypto";

import type pg from "pg";

import {
  type Currency,
  FrozenClock,
  IdPrefix,
  withIdSource,
  istStartOf,
  addDays,
  Money,
  newId,
  type Settings,
  type Db,
} from "@mintrail/shared";
import {
  computeCaptureBreakdown,
  GST_RATE_BPS,
  type LedgerService,
  recordCapture,
  recordDisputeClosed,
  recordDisputeOpened,
  recordPayoutInitiated,
  recordPayoutPaid,
  recordPayoutReversed,
  recordRefundFailed,
  recordRefundFee,
  recordRefundInitiated,
  recordRefundPaid,
  stationAccount,
} from "@mintrail/ledger";
import { feeBps, type Station } from "@mintrail/api";
import { SettlementEngine, type FxFeed } from "@mintrail/depot";
import { DECLINE_REASONS } from "@mintrail/junction";

import { BufferedLedger, bulkInsert, type Col } from "./bulk.js";
import { BANKS, CARD_BINS, type Category, DECLINES, FIRST_NAMES, LAST_NAMES, PSP_HANDLES } from "./catalog.js";
import { Rng } from "./rng.js";

export interface SimMerchant {
  station: Station;
  cat: Category;
  livemode: boolean;
  weight: number;
  freight: boolean;
  approvalThreshold: bigint;
}

type Ev = { at: number; run: () => Promise<void> };

const HOUR = 3_600_000;
const CONCURRENCY = 8;

/** FNV-1a: a stable 32-bit seed from a string. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
const DAY = 24 * HOUR;
const SUCCESS: Record<string, number> = { upi: 0.932, card: 0.912, netbanking: 0.895 };
const USD_INR = 83;
const TINY_PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const PDF_SHA = createHash("sha256").update(TINY_PDF).digest("hex");

export interface SimStats {
  payments: number;
  captured: number;
  refunds: number;
  disputes: number;
  payouts: number;
  settlements: number;
}

export class World {
  readonly stats: SimStats = { payments: 0, captured: 0, refunds: 0, disputes: 0, payouts: 0, settlements: 0 };
  private queue: Ev[] = [];
  readonly profile: Record<string, number> = {};
  private rows: Record<string, unknown[][]> = {};
  now = new Date();
  private readonly arjunId: string;

  constructor(
    private readonly rng: Rng,
    private readonly db: Db,
    private readonly client: pg.PoolClient,
    private readonly ledger: BufferedLedger,
    private readonly settings: Settings,
    private readonly merchants: SimMerchant[],
    private readonly fx: FxFeed,
    staff: { arjun: string },
    private readonly endAt: number,
  ) {
    this.arjunId = staff.arjun;
  }

  private get L(): LedgerService {
    return this.ledger as unknown as LedgerService;
  }

  private push(table: string, row: unknown[]): void {
    (this.rows[table] ??= []).push(row);
  }

  private at(t: number, run: () => Promise<void>): void {
    if (t < this.endAt) this.queue.push({ at: t, run });
  }

  private mb(m: SimMerchant, currency: Currency): bigint {
    return this.ledger.balance(stationAccount(m.station.id, currency, m.livemode).code);
  }

  // ---------------------------------------------------------------- the day loop
  async simulate(firstDay: string, days: number, paymentTarget: number, onDay: (d: number) => void): Promise<void> {
    const weightSum = this.merchants.reduce((a, m) => a + m.weight, 0);
    for (let d = 0; d < days; d++) {
      const date = addDays(firstDay, d);
      const start = istStartOf(date).getTime();
      const weekday = new Date(start + 6 * HOUR).getUTCDay();
      const seasonal = (weekday === 0 || weekday === 6 ? 1.12 : 0.95) * (0.82 + (0.36 * d) / days) * (date.endsWith("-01") ? 1.25 : 1);
      for (const m of this.merchants) {
        const base = (paymentTarget / days) * (m.weight / weightSum) * seasonal;
        const n = Math.max(0, Math.round(base * (0.85 + 0.3 * this.rng.float())));
        for (let i = 0; i < n; i++) this.at(start + this.timeOfDay(m.cat), () => this.payment(m));
        if (m.freight && this.rng.chance(0.35)) this.at(start + 10 * HOUR + this.rng.int(0, 9 * HOUR), () => this.payoutRun(m));
      }
      let t = performance.now();
      const lap = (k: string) => {
        const n = performance.now();
        this.profile[k] = (this.profile[k] ?? 0) + (n - t);
        t = n;
      };
      await this.runUntil(start + 11 * HOUR);
      lap("generate");
      await this.flush();
      lap("flush");
      await this.settle(date, start);
      lap("settle");
      await this.runUntil(start + DAY);
      lap("generate");
      await this.flush();
      lap("flush");
      onDay(d);
    }
  }

  private async runUntil(t: number): Promise<void> {
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at >= t) return;
      this.queue.shift();
      this.now = new Date(next.at);
      this.ledger.now = this.now;
      await next.run();
    }
  }

  private timeOfDay(cat: Category): number {
    const [a, b] = cat.peakHours;
    const hour = this.rng.chance(0.72) ? a + this.rng.float() * (b - a) : 6 + this.rng.float() * 18;
    return Math.floor(Math.min(hour, 23.99) * HOUR);
  }

  // ---------------------------------------------------------------- payments
  private amountFor(m: SimMerchant, currency: Currency): bigint {
    const median = currency === "USD" ? m.cat.ticket / USD_INR : m.cat.ticket;
    let major = median * Math.exp(m.cat.sigma * this.rng.normal());
    major = Math.min(Math.max(major, currency === "USD" ? 5 : 49), currency === "USD" ? 4_000 : 4_99_999);
    // Prices end in round numbers or 9s, like real carts.
    const rupees = this.rng.chance(0.5) ? Math.round(major / 10) * 10 - (this.rng.chance(0.5) ? 1 : 0) : Math.round(major);
    return BigInt(Math.max(rupees, currency === "USD" ? 5 : 49)) * 100n;
  }

  private customer(): { email: string; name: string } {
    const f = this.rng.pick(FIRST_NAMES);
    const l = this.rng.pick(LAST_NAMES);
    return { name: `${f} ${l}`, email: `${f.toLowerCase()}.${l.toLowerCase()}${this.rng.int(1, 999)}@mail.example` };
  }

  private async payment(m: SimMerchant): Promise<void> {
    const method = this.rng.weighted([
      ["upi", m.cat.mix[0]],
      ["card", m.cat.mix[1]],
      ["netbanking", m.cat.mix[2]],
    ] as const);
    const currency: Currency = method === "card" && m.livemode && this.rng.chance(m.cat.usdShare) ? "USD" : "INR";
    const amount = this.amountFor(m, currency);
    const t0 = this.now.getTime();
    const orderId = newId(IdPrefix.ORDER, BigInt(t0));
    const id = newId(IdPrefix.PAYMENT, BigInt(t0 + 120));
    const cust = this.customer();
    const ok = this.rng.chance(SUCCESS[method]!);
    let card: [string, string, string, number, number] | null = null;
    let vpa: string | null = null;
    let bank: string | null = null;
    if (method === "card") {
      const [network, bin] = this.rng.pick(CARD_BINS);
      card = [network, bin, this.rng.digits(4), this.rng.int(1, 12), this.rng.int(2027, 2032)];
    } else if (method === "upi") {
      vpa = `${cust.name.split(" ")[0]!.toLowerCase()}${this.rng.int(10, 99)}@${this.rng.pick(PSP_HANDLES)}`;
    } else bank = this.rng.pick(BANKS);
    const created = new Date(t0);
    const resolved = new Date(t0 + this.rng.int(2_000, 25_000));
    const captured = new Date(resolved.getTime() + this.rng.int(300, 2_500));
    const jref = `JN${this.rng.digits(12)}`;
    const fp = this.rng.hex(32);
    let fee: bigint | null = null;
    let tax: bigint | null = null;
    let decline: string | null = null;
    if (ok) {
      const br = computeCaptureBreakdown(Money.of(amount, currency), { feeBps: feeBps(m.station.feePlan, currency, method) });
      fee = br.fee.amount;
      tax = br.tax.amount;
      this.now = captured;
      this.ledger.now = captured;
      await recordCapture(this.L, { stationId: m.station.id, paymentId: id, breakdown: br, livemode: m.livemode });
      this.stats.captured += 1;
      this.push("junction_authorizations", [
        jref,
        id,
        m.station.id,
        amount,
        currency,
        method,
        card ? `card:${card[1]}:${card[2]}` : vpa ? `upi:${vpa}` : `netbanking:${bank}`,
        m.livemode,
        null,
        "captured",
        null,
        {},
        2,
        1,
        created,
        captured,
      ]);
      this.scheduleAfterCapture(m, { id, amount, currency, method, captured: captured.getTime(), fee, tax });
    } else {
      decline = this.rng.weighted(DECLINES[method]!);
    }
    this.stats.payments += 1;
    this.push("orders", [
      orderId,
      m.station.id,
      m.livemode,
      amount,
      currency,
      `rcpt_${this.rng.digits(8)}`,
      {},
      ok ? "paid" : "attempted",
      ok ? amount : 0n,
      1,
      created,
      ok ? captured : resolved,
    ]);
    this.push("payments", [
      id,
      orderId,
      m.station.id,
      m.livemode,
      amount,
      currency,
      method,
      "automatic",
      ok ? "captured" : "failed",
      card?.[0] ?? null,
      card?.[1] ?? null,
      card?.[2] ?? null,
      card?.[3] ?? null,
      card?.[4] ?? null,
      vpa,
      bank,
      fp,
      cust.email,
      jref,
      2,
      decline,
      decline ? (DECLINE_REASONS[decline] ?? "Declined by the bank") : null,
      "allow",
      this.rng.int(0, 25),
      [],
      "not_required",
      fee,
      tax,
      ok ? resolved : null,
      ok ? captured : null,
      ok ? null : resolved,
      created,
      ok ? captured : resolved,
    ]);
    this.push("payment_events", [id, "api", "payment.created", true, {}, created]);
    this.push("payment_events", [
      id,
      "junction",
      ok ? "payment.captured" : "payment.failed",
      true,
      ok ? { fee, tax } : { code: decline },
      ok ? captured : resolved,
    ]);
  }

  // ---------------------------------------------------------------- refunds & disputes (scheduled from the capture)
  private scheduleAfterCapture(
    m: SimMerchant,
    p: { id: string; amount: bigint; currency: Currency; method: string; captured: number; fee: bigint; tax: bigint },
  ): void {
    if (this.rng.chance(0.044)) {
      const at = p.captured + Math.floor((0.2 + this.rng.float() * 9) * DAY);
      const partial = this.rng.chance(0.3);
      const amt = partial ? (p.amount * BigInt(this.rng.int(20, 80))) / 100n : p.amount;
      this.at(at, () => this.refund(m, p, amt));
    }
    const disputeP = p.method === "card" ? 0.0105 : p.method === "upi" ? 0.0016 : 0.0012;
    if (this.rng.chance(disputeP)) {
      const at = p.captured + Math.floor((5 + this.rng.float() * 40) * DAY);
      this.at(at, () => this.dispute(m, p));
    }
  }

  private refunded = new Map<string, bigint>();

  private async refund(
    m: SimMerchant,
    p: { id: string; amount: bigint; currency: Currency; method: string },
    wanted: bigint,
  ): Promise<void> {
    const already = this.refunded.get(p.id) ?? 0n;
    const amount = wanted > p.amount - already ? p.amount - already : wanted;
    if (amount <= 0n) return;
    const instant = p.method !== "netbanking" && this.rng.chance(0.2);
    const money = Money.of(amount, p.currency);
    const fee = instant ? money.applyBps(BigInt(this.settings.refund_instant_fee_bps), "half_up") : Money.zero(p.currency);
    const tax = fee.applyBps(GST_RATE_BPS, "half_even");
    if (this.mb(m, p.currency) < amount + fee.amount + tax.amount) return; // a real merchant would see MR_INSUFFICIENT_BALANCE
    this.refunded.set(p.id, already + amount);
    const id = newId(IdPrefix.REFUND, BigInt(this.now.getTime()));
    await recordRefundInitiated(this.L, { stationId: m.station.id, refundId: id, amount: money, livemode: m.livemode });
    await recordRefundFee(this.L, { stationId: m.station.id, refundId: id, fee, tax, livemode: m.livemode });
    this.stats.refunds += 1;
    const created = new Date(this.now);
    const reason = this.rng.weighted([
      ["requested_by_customer", 60],
      ["order_cancelled", 25],
      ["duplicate", 8],
      ["other", 7],
    ] as const);
    const fails = this.rng.chance(0.025);
    const doneAt = created.getTime() + (instant ? this.rng.int(30_000, 600_000) : Math.floor((1 + this.rng.float() * 4) * DAY));
    const row: unknown[] = [
      id,
      p.id,
      m.station.id,
      m.livemode,
      amount,
      p.currency,
      "pending",
      reason,
      instant ? "instant" : "normal",
      fee.amount,
      tax.amount,
      {},
      `RFN${this.rng.digits(12)}`,
      null,
      null,
      null,
      null,
      created,
      created,
    ];
    const idx = (this.rows.refunds ??= []).push(row) - 1;
    const table = this.rows.refunds;
    this.at(doneAt, async () => {
      // If the row was already flushed, update it in the database instead.
      const target = this.rows.refunds === table && table[idx] === row ? row : null;
      if (fails) {
        await recordRefundFailed(this.L, { refundId: id });
        if (target)
          Object.assign(target, {
            6: "failed",
            14: "beneficiary_account_closed",
            15: "The bank could not process the refund (beneficiary account closed)",
            17: this.now,
          });
        else
          this.updates.push([
            "UPDATE refunds SET status='failed', error_code='beneficiary_account_closed', error_description='The bank could not process the refund (beneficiary account closed)', failed_at=$2, updated_at=$2 WHERE id=$1",
            [id, this.now],
          ]);
        this.refunded.set(p.id, (this.refunded.get(p.id) ?? 0n) - amount);
      } else {
        await recordRefundPaid(this.L, { refundId: id, amount: money, livemode: m.livemode });
        if (target) Object.assign(target, { 6: "processed", 16: this.now });
        else this.updates.push(["UPDATE refunds SET status='processed', processed_at=$2, updated_at=$2 WHERE id=$1", [id, this.now]]);
      }
    });
  }

  private updates: [string, unknown[]][] = [];

  private async dispute(m: SimMerchant, p: { id: string; amount: bigint; currency: Currency }): Promise<void> {
    const refundedAmt = this.refunded.get(p.id) ?? 0n;
    const amount = p.amount - refundedAmt;
    if (amount <= 0n) return;
    this.refunded.set(p.id, p.amount); // nothing left to refund
    const id = newId(IdPrefix.DISPUTE, BigInt(this.now.getTime()));
    const money = Money.of(amount, p.currency);
    await recordDisputeOpened(this.L, { stationId: m.station.id, disputeId: id, amount: money, livemode: m.livemode });
    this.stats.disputes += 1;
    const opened = this.now.getTime();
    const due = new Date(opened + this.settings.dispute_response_days * DAY);
    const reason =
      p.currency === "USD"
        ? "fraudulent"
        : this.rng.weighted([
            ["fraudulent", 30],
            ["product_not_received", 35],
            ["duplicate", 10],
            ["credit_not_processed", 15],
            ["general", 10],
          ] as const);
    const row: unknown[] = [
      id,
      p.id,
      m.station.id,
      m.livemode,
      amount,
      p.currency,
      reason,
      "needs_response",
      `DSP${this.rng.digits(12)}`,
      due,
      null,
      null,
      null,
      null,
      new Date(opened),
      new Date(opened),
    ];
    this.push("disputes", row);
    const responds = this.rng.chance(0.72);
    const close = async (won: boolean, why: string) => {
      await recordDisputeClosed(this.L, { stationId: m.station.id, disputeId: id, amount: money, livemode: m.livemode, won });
      this.updates.push([
        "UPDATE disputes SET status=$2, outcome_reason=$3, closed_at=$4, updated_at=$4 WHERE id=$1",
        [id, won ? "won" : "lost", why, this.now],
      ]);
    };
    if (responds) {
      const submitAt = opened + Math.floor((0.5 + this.rng.float() * 5) * DAY);
      this.at(submitAt, async () => {
        this.push("dispute_evidence", [
          newId(IdPrefix.EVIDENCE_FILE, BigInt(this.now.getTime())),
          id,
          "receipt",
          `invoice-${p.id.slice(-6)}.pdf`,
          "application/pdf",
          TINY_PDF.length,
          PDF_SHA,
          TINY_PDF,
          "user:owner",
          this.now,
        ]);
        this.updates.push([
          "UPDATE disputes SET status='under_review', evidence_text=$2, evidence_submitted_at=$3, updated_at=$3 WHERE id=$1",
          [id, "Order delivered and acknowledged by the customer; invoice and delivery confirmation attached.", this.now],
        ]);
        this.at(this.now.getTime() + Math.floor((3 + this.rng.float() * 8) * DAY), () =>
          this.rng.chance(0.56) ? close(true, "evidence accepted by the issuer") : close(false, "issuer ruled for the cardholder"),
        );
      });
    } else {
      this.at(due.getTime(), () => close(false, "evidence deadline passed"));
    }
  }

  // ---------------------------------------------------------------- Freight payouts
  private async payoutRun(m: SimMerchant): Promise<void> {
    const avail = this.mb(m, "INR");
    let budget = (avail * BigInt(this.rng.int(10, 30))) / 100n;
    const n = this.rng.int(1, 4);
    for (let i = 0; i < n && budget > 2_000_00n; i++) {
      const amount = BigInt(Math.min(Number(budget / 100n), this.rng.int(2_000, 1_50_000))) * 100n;
      budget -= amount;
      await this.payout(m, amount);
    }
  }

  private async payout(m: SimMerchant, amount: bigint): Promise<void> {
    if (this.mb(m, "INR") < amount) return;
    const id = newId(IdPrefix.PAYOUT, BigInt(this.now.getTime()));
    await recordPayoutInitiated(this.L, { stationId: m.station.id, payoutId: id, amount: Money.of(amount, "INR"), livemode: m.livemode });
    this.stats.payouts += 1;
    const mode =
      amount >= 2_00_000_00n
        ? "RTGS"
        : this.rng.weighted([
            ["IMPS", 50],
            ["NEFT", 30],
            ["UPI", amount <= 1_00_000_00n ? 20 : 0],
          ] as const);
    const name = `${this.rng.pick(FIRST_NAMES)} ${this.rng.pick(LAST_NAMES)}`;
    const vpa = mode === "UPI" ? `${name.split(" ")[0]!.toLowerCase()}@${this.rng.pick(PSP_HANDLES)}` : null;
    const acct = mode === "UPI" ? null : this.rng.digits(this.rng.int(11, 14));
    const ifsc = mode === "UPI" ? null : `${this.rng.pick(BANKS)}0${this.rng.digits(6)}`;
    const purpose = this.rng.weighted([
      ["vendor_bill", 45],
      ["salary", 20],
      ["refund", 10],
      ["rent", 10],
      ["utility_bill", 10],
      ["other", 5],
    ] as const);
    const needsApproval = amount >= m.approvalThreshold;
    const created = new Date(this.now);
    this.push("payouts", [
      id,
      m.station.id,
      m.livemode,
      null,
      amount,
      "INR",
      mode,
      purpose,
      name,
      acct,
      ifsc,
      vpa,
      `PO-${this.rng.digits(6)}`,
      null,
      needsApproval ? "pending_approval" : "processing",
      `PYT${this.rng.digits(12)}`,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      created,
      created,
    ]);
    const finish = async () => {
      const fail = acct?.endsWith("0") && this.rng.chance(0.3);
      if (fail) {
        await recordPayoutReversed(this.L, { payoutId: id });
        this.updates.push([
          "UPDATE payouts SET status='failed', failure_reason='beneficiary_bank_offline', failed_at=$2, updated_at=$2 WHERE id=$1",
          [id, this.now],
        ]);
      } else {
        await recordPayoutPaid(this.L, { payoutId: id, amount: Money.of(amount, "INR"), livemode: m.livemode });
        const utr = `JUNC${this.now.toISOString().slice(2, 10).replaceAll("-", "")}${this.rng.digits(10)}`;
        this.updates.push([
          "UPDATE payouts SET status='processed', utr=$2, processed_at=$3, updated_at=$3 WHERE id=$1",
          [id, utr, this.now],
        ]);
      }
    };
    if (needsApproval) {
      this.at(created.getTime() + this.rng.int(2, 20) * HOUR, async () => {
        if (this.rng.chance(0.1)) {
          await recordPayoutReversed(this.L, { payoutId: id });
          this.updates.push([
            "UPDATE payouts SET status='rejected', approved_by=$2, rejected_reason='Beneficiary not verified against vendor master', updated_at=$3 WHERE id=$1",
            [id, this.arjunId, this.now],
          ]);
          return;
        }
        this.updates.push([
          "UPDATE payouts SET status='processing', approved_by=$2, approved_at=$3, updated_at=$3 WHERE id=$1",
          [id, this.arjunId, this.now],
        ]);
        this.at(this.now.getTime() + this.rng.int(60_000, 3 * HOUR), finish);
      });
    } else {
      this.at(created.getTime() + this.rng.int(10_000, mode === "NEFT" ? 4 * HOUR : 120_000), finish);
    }
  }

  // ---------------------------------------------------------------- settlements (real Depot engine)
  private async settle(date: string, dayStart: number): Promise<void> {
    const runAt = new Date(dayStart + 11 * HOUR);
    const creditAt = new Date(dayStart + 14 * HOUR);
    const jobs = this.merchants.flatMap((m) =>
      (["INR", "USD"] as Currency[])
        .filter((currency) => this.ledger.balances.has(stationAccount(m.station.id, currency, m.livemode).code))
        .map((currency) => ({ m, currency })),
    );
    // Batches are independent (per-station advisory locks), so run several at once. Each gets its
    // own deterministic id stream, so the result does not depend on how the calls interleave.
    const one = async ({ m, currency }: { m: SimMerchant; currency: Currency }) => {
      const rng = new Rng(hashSeed(`${m.station.id}:${currency}:${date}`));
      const source = { nowMs: () => BigInt(runAt.getTime()), random80: () => rng.bits80() };
      await withIdSource(source, async () => {
        const r = await this.db.transaction((tx) =>
          new SettlementEngine(tx, this.settings, this.fx, new FrozenClock(runAt)).settle(m.station.id, m.livemode, currency, date),
        );
        if (r.created) this.stats.settlements += 1;
        if (r.created && r.settlement?.status === "processing" && creditAt.getTime() < this.endAt) {
          source.nowMs = () => BigInt(creditAt.getTime());
          await this.db.transaction((tx) =>
            new SettlementEngine(tx, this.settings, this.fx, new FrozenClock(creditAt)).bankCredit(r.settlement!.id),
          );
        }
      });
    };
    for (let i = 0; i < jobs.length; i += CONCURRENCY) await Promise.all(jobs.slice(i, i + CONCURRENCY).map(one));
    await this.ledger.refresh(this.client);
  }

  // ---------------------------------------------------------------- flushing
  async flush(): Promise<void> {
    await this.client.query("BEGIN");
    try {
      for (const [table, cols] of TABLES) {
        const rows = this.rows[table];
        if (rows?.length) await bulkInsert(this.client, table, cols, rows);
      }
      await this.ledger.flush(this.client);
      for (const [q, params] of this.updates) await this.client.query(q, params);
      await this.client.query("COMMIT");
    } catch (e) {
      await this.client.query("ROLLBACK");
      throw e;
    }
    this.rows = {};
    this.updates = [];
  }
}

const TABLES: [string, Col[]][] = [
  [
    "orders",
    [
      ["id", "text"],
      ["station_id", "text"],
      ["livemode", "boolean"],
      ["amount", "bigint"],
      ["currency", "text"],
      ["receipt", "text"],
      ["notes", "jsonb"],
      ["status", "text"],
      ["amount_paid", "bigint"],
      ["attempts", "int"],
      ["created_at", "timestamptz"],
      ["updated_at", "timestamptz"],
    ],
  ],
  [
    "payments",
    [
      ["id", "text"],
      ["order_id", "text"],
      ["station_id", "text"],
      ["livemode", "boolean"],
      ["amount", "bigint"],
      ["currency", "text"],
      ["method", "text"],
      ["capture_mode", "text"],
      ["status", "text"],
      ["card_network", "text"],
      ["card_bin", "text"],
      ["card_last4", "text"],
      ["card_expiry_month", "int"],
      ["card_expiry_year", "int"],
      ["vpa", "text"],
      ["bank_code", "text"],
      ["instrument_fingerprint", "text"],
      ["customer_email", "text"],
      ["junction_ref", "text"],
      ["junction_sequence", "int"],
      ["error_code", "text"],
      ["error_description", "text"],
      ["risk_decision", "text"],
      ["risk_score", "int"],
      ["risk_reasons", "jsonb"],
      ["risk_review_status", "text"],
      ["fee", "bigint"],
      ["tax", "bigint"],
      ["authorized_at", "timestamptz"],
      ["captured_at", "timestamptz"],
      ["failed_at", "timestamptz"],
      ["created_at", "timestamptz"],
      ["updated_at", "timestamptz"],
    ],
  ],
  [
    "payment_events",
    [
      ["payment_id", "text"],
      ["source", "text"],
      ["type", "text"],
      ["applied", "boolean"],
      ["payload", "jsonb"],
      ["created_at", "timestamptz"],
    ],
  ],
  [
    "junction_authorizations",
    [
      ["ref", "text"],
      ["payment_id", "text"],
      ["merchant_ref", "text"],
      ["amount", "bigint"],
      ["currency", "text"],
      ["method", "text"],
      ["instrument", "text"],
      ["livemode", "boolean"],
      ["scenario", "text"],
      ["status", "text"],
      ["decline_code", "text"],
      ["plan", "jsonb"],
      ["sequence", "int"],
      ["requests_seen", "int"],
      ["created_at", "timestamptz"],
      ["updated_at", "timestamptz"],
    ],
  ],
  [
    "refunds",
    [
      ["id", "text"],
      ["payment_id", "text"],
      ["station_id", "text"],
      ["livemode", "boolean"],
      ["amount", "bigint"],
      ["currency", "text"],
      ["status", "text"],
      ["reason", "text"],
      ["speed", "text"],
      ["fee", "bigint"],
      ["tax", "bigint"],
      ["notes", "jsonb"],
      ["junction_ref", "text"],
      ["test_scenario", "text"],
      ["error_code", "text"],
      ["error_description", "text"],
      ["processed_at", "timestamptz"],
      ["failed_at", "timestamptz"],
      ["created_at", "timestamptz"],
    ],
  ],
  [
    "disputes",
    [
      ["id", "text"],
      ["payment_id", "text"],
      ["station_id", "text"],
      ["livemode", "boolean"],
      ["amount", "bigint"],
      ["currency", "text"],
      ["reason", "text"],
      ["status", "text"],
      ["junction_ref", "text"],
      ["evidence_due_by", "timestamptz"],
      ["evidence_text", "text"],
      ["evidence_submitted_at", "timestamptz"],
      ["outcome_reason", "text"],
      ["closed_at", "timestamptz"],
      ["created_at", "timestamptz"],
      ["updated_at", "timestamptz"],
    ],
  ],
  [
    "dispute_evidence",
    [
      ["id", "text"],
      ["dispute_id", "text"],
      ["kind", "text"],
      ["filename", "text"],
      ["content_type", "text"],
      ["size_bytes", "int"],
      ["sha256", "text"],
      ["content", "bytea"],
      ["uploaded_by", "text"],
      ["created_at", "timestamptz"],
    ],
  ],
  [
    "payouts",
    [
      ["id", "text"],
      ["station_id", "text"],
      ["livemode", "boolean"],
      ["batch_id", "text"],
      ["amount", "bigint"],
      ["currency", "text"],
      ["mode", "text"],
      ["purpose", "text"],
      ["beneficiary_name", "text"],
      ["account_number", "text"],
      ["ifsc", "text"],
      ["vpa", "text"],
      ["reference", "text"],
      ["narration", "text"],
      ["status", "text"],
      ["junction_ref", "text"],
      ["utr", "text"],
      ["test_scenario", "text"],
      ["failure_reason", "text"],
      ["approved_by", "text"],
      ["approved_at", "timestamptz"],
      ["rejected_reason", "text"],
      ["processed_at", "timestamptz"],
      ["failed_at", "timestamptz"],
      ["created_at", "timestamptz"],
      ["updated_at", "timestamptz"],
    ],
  ],
];
