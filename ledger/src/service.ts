/**
 * Ledger domain service. Every write goes through ``post``. Callers own the DB
 * transaction: the service never commits, so a payment state change and its
 * ledger entry commit (or roll back) together.
 *
 * Concurrency: balance rows of every touched account are locked FOR UPDATE in
 * ascending account-id order (a global lock order → no deadlocks), and the
 * idempotency check is repeated once the locks are held. See ADR-0003.
 */
import { createHash } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  type Clock,
  ConflictError,
  type Currency,
  CurrencyMismatchError,
  IdPrefix,
  InvalidAmountError,
  InvalidRequestError,
  Money,
  newId,
  pyRepr,
  systemClock,
  type Tx,
} from "@mintrail/shared";

import {
  AccountExistsError,
  AccountNotFoundError,
  AlreadyReversedError,
  IdempotencyConflictError,
  InsufficientBalanceError,
  TransactionNotFoundError,
  UnbalancedTransactionError,
} from "./errors.js";
import { pyJsonDumps } from "./pyjson.js";
import {
  type LedgerAccountRow,
  type LedgerBalanceRow,
  ledgerAccounts,
  ledgerBalances,
  ledgerPostings,
  type LedgerTransactionRow,
  ledgerTransactions,
} from "./schema.js";

export const MAX_LINES_PER_TRANSACTION = 100;
export const MAX_IDEMPOTENCY_KEY_LEN = 255;

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type Direction = "debit" | "credit";
export type AccountStatus = "active" | "frozen";

export const isDebitNormal = (t: AccountType): boolean => t === "asset" || t === "expense";
export const flipped = (d: Direction): Direction => (d === "debit" ? "credit" : "debit");

// ------------------------------------------------------------------ inputs
export interface PostingLine {
  accountId: string;
  direction: Direction;
  amount: Money;
}

const accountIdOf = (a: string | { id: string }): string => (typeof a === "string" ? a : a.id);
export const debit = (account: string | { id: string }, amount: Money): PostingLine => ({
  accountId: accountIdOf(account),
  direction: "debit",
  amount,
});
export const credit = (account: string | { id: string }, amount: Money): PostingLine => ({
  accountId: accountIdOf(account),
  direction: "credit",
  amount,
});

export interface TransactionRequest {
  idempotencyKey: string;
  description: string;
  lines: readonly PostingLine[];
  referenceType?: string | null;
  referenceId?: string | null;
  effectiveAt?: Date | null;
  metadata?: Record<string, unknown>;
  reversesId?: string | null;
}

/**
 * SHA-256 over the semantically significant fields, byte-identical to M1.
 * ``effectiveAt`` and ``metadata`` are excluded: a retry that stamps a new time
 * is still the same money movement.
 */
export function fingerprint(req: TransactionRequest): string {
  const lines = req.lines
    .map((l) => [l.accountId, l.direction, l.amount.amount, l.amount.currency] as const)
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) {
        const x = a[i]!;
        const y = b[i]!;
        if (x === y) continue;
        return x < y ? -1 : 1;
      }
      return 0;
    });
  const canonical = pyJsonDumps({
    description: req.description,
    reference_type: req.referenceType ?? null,
    reference_id: req.referenceId ?? null,
    reverses_id: req.reversesId ?? null,
    lines,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ------------------------------------------------------------------ outputs
export interface PostedLine {
  accountId: string;
  direction: Direction;
  amount: Money;
}

export interface PostedTransaction {
  id: string;
  idempotencyKey: string;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  reversesId: string | null;
  livemode: boolean;
  effectiveAt: string;
  lines: PostedLine[];
  replayed: boolean;
}

export class AccountBalance {
  constructor(
    readonly accountId: string,
    readonly code: string,
    readonly type: AccountType,
    readonly debits: Money,
    readonly credits: Money,
  ) {}

  /** Balance on the account's normal side (positive = "has funds"). */
  get balance(): Money {
    return isDebitNormal(this.type) ? this.debits.sub(this.credits) : this.credits.sub(this.debits);
  }
}

export interface TrialBalance {
  currency: Currency;
  livemode: boolean;
  debits: Money;
  credits: Money;
  isBalanced: boolean;
}

export interface BalanceDiscrepancy {
  account_id: string;
  code: string;
  cached_debits: bigint;
  cached_credits: bigint;
  actual_debits: bigint;
  actual_credits: bigint;
}

export const normalBalance = (type: AccountType, debits: bigint, credits: bigint): bigint =>
  isDebitNormal(type) ? debits - credits : credits - debits;

export interface NewAccount {
  code: string;
  name: string;
  type: AccountType;
  currency: Currency;
  livemode: boolean;
  ownerId?: string | null;
  allowNegative?: boolean;
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  ((e as { code?: string }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505");

// ------------------------------------------------------------------ service
export class LedgerService {
  constructor(
    readonly tx: Tx,
    private readonly clock: Clock = systemClock,
  ) {}

  // ---------------------------------------------------------------- accounts
  async createAccount(spec: NewAccount): Promise<LedgerAccountRow> {
    if ((await this.getAccountByCode(spec.code)) !== null) {
      throw new AccountExistsError(`ledger account ${pyRepr(spec.code)} already exists`, { param: "code" });
    }
    return this.insertAccount(this.tx, spec);
  }

  /** Get-or-create by ``code``; safe under concurrent callers. */
  async ensureAccount(spec: NewAccount): Promise<LedgerAccountRow> {
    let existing = await this.getAccountByCode(spec.code);
    if (existing === null) {
      try {
        return await this.tx.transaction((sp) => this.insertAccount(sp, spec));
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        existing = await this.getAccountByCode(spec.code);
        if (existing === null) throw e;
      }
    }
    if (
      existing.type !== spec.type ||
      existing.currency !== spec.currency ||
      existing.livemode !== spec.livemode ||
      existing.ownerId !== (spec.ownerId ?? null)
    ) {
      throw new ConflictError(`ledger account ${pyRepr(spec.code)} exists with a different definition`, { param: "code" });
    }
    return existing;
  }

  private async insertAccount(tx: Tx, spec: NewAccount): Promise<LedgerAccountRow> {
    if (!spec.code || spec.code.length > 200) {
      throw new InvalidRequestError("account code must be 1-200 characters", { param: "code" });
    }
    const id = newId(IdPrefix.LEDGER_ACCOUNT);
    const [row] = await tx
      .insert(ledgerAccounts)
      .values({
        id,
        code: spec.code,
        name: spec.name,
        type: spec.type,
        currency: spec.currency,
        livemode: spec.livemode,
        ownerId: spec.ownerId ?? null,
        allowNegative: spec.allowNegative ?? false,
        status: "active",
      })
      .returning();
    await tx.insert(ledgerBalances).values({ accountId: id, debitsTotal: 0n, creditsTotal: 0n, version: 0 });
    return row!;
  }

  async getAccount(accountId: string): Promise<LedgerAccountRow> {
    const [row] = await this.tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, accountId));
    if (!row) throw new AccountNotFoundError(`ledger account ${accountId} not found`);
    return row;
  }

  async getAccountByCode(code: string): Promise<LedgerAccountRow | null> {
    const [row] = await this.tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.code, code));
    return row ?? null;
  }

  async setAccountStatus(accountId: string, status: AccountStatus): Promise<void> {
    await this.getAccount(accountId);
    await this.tx.update(ledgerAccounts).set({ status }).where(eq(ledgerAccounts.id, accountId));
  }

  // ---------------------------------------------------------------- posting
  async post(request: TransactionRequest): Promise<PostedTransaction> {
    validateShape(request);
    const fp = fingerprint(request);

    // Fast path for retries: no locks needed to replay.
    const prior = await this.findByKey(request.idempotencyKey);
    if (prior) return this.replay(prior, fp);

    const accountIds = [...new Set(request.lines.map((l) => l.accountId))].sort();
    const balanceRows = await this.tx
      .select()
      .from(ledgerBalances)
      .where(inArray(ledgerBalances.accountId, accountIds))
      .orderBy(asc(ledgerBalances.accountId))
      .for("update");
    const balances = new Map(balanceRows.map((b) => [b.accountId, b]));
    const missing = accountIds.filter((a) => !balances.has(a));
    if (missing.length > 0) {
      throw new AccountNotFoundError(`ledger account ${missing[0]} not found`, { details: { missing } });
    }
    const accounts = new Map(
      (await this.tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, accountIds))).map((a) => [a.id, a]),
    );

    // Authoritative idempotency check, now that competing writers are serialised.
    const raced = await this.findByKey(request.idempotencyKey);
    if (raced) return this.replay(raced, fp);

    const livemode = checkAccounts(request.lines, accounts);
    const deltas = checkFunds(request.lines, accounts, balances);

    const id = newId(IdPrefix.LEDGER_TRANSACTION);
    try {
      await this.tx.transaction(async (sp) => {
        await sp.insert(ledgerTransactions).values({
          id,
          idempotencyKey: request.idempotencyKey,
          fingerprint: fp,
          description: request.description,
          referenceType: request.referenceType ?? null,
          referenceId: request.referenceId ?? null,
          reversesId: request.reversesId ?? null,
          livemode,
          effectiveAt: (request.effectiveAt ?? this.clock.now()).toISOString(),
          metadata: { ...(request.metadata ?? {}) },
        });
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await this.findByKey(request.idempotencyKey);
      if (existing) return this.replay(existing, fp);
      if (request.reversesId) {
        throw new AlreadyReversedError(`ledger transaction ${request.reversesId} is already reversed`);
      }
      throw e;
    }

    for (const ln of request.lines) {
      await this.tx.insert(ledgerPostings).values({
        transactionId: id,
        accountId: ln.accountId,
        direction: ln.direction,
        amount: ln.amount.amount,
        currency: ln.amount.currency,
      });
    }
    for (const [accountId, [d, c]] of deltas) {
      await this.tx
        .update(ledgerBalances)
        .set({
          debitsTotal: sql`${ledgerBalances.debitsTotal} + ${d}`,
          creditsTotal: sql`${ledgerBalances.creditsTotal} + ${c}`,
          version: sql`${ledgerBalances.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(ledgerBalances.accountId, accountId));
    }
    return this.load(id, false);
  }

  /** Post the exact mirror image of a transaction. A transaction can be reversed at most once. */
  async reverse(transactionId: string, opts: { idempotencyKey: string; description?: string }): Promise<PostedTransaction> {
    const [original] = await this.tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, transactionId));
    if (!original) throw new TransactionNotFoundError(`ledger transaction ${transactionId} not found`);
    if (original.reversesId !== null) throw new InvalidRequestError("a reversal cannot itself be reversed");
    const [prior] = await this.tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.reversesId, transactionId));
    if (prior && prior.idempotencyKey !== opts.idempotencyKey) {
      throw new AlreadyReversedError(`ledger transaction ${transactionId} is already reversed`);
    }
    const postings = await this.tx
      .select()
      .from(ledgerPostings)
      .where(eq(ledgerPostings.transactionId, transactionId))
      .orderBy(asc(ledgerPostings.id));
    return this.post({
      idempotencyKey: opts.idempotencyKey,
      description: opts.description || `Reversal of ${transactionId}`,
      lines: postings.map((p) => ({
        accountId: p.accountId,
        direction: flipped(p.direction as Direction),
        amount: Money.of(p.amount, p.currency),
      })),
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      reversesId: transactionId,
    });
  }

  // ---------------------------------------------------------------- reads
  async getTransaction(transactionId: string): Promise<PostedTransaction> {
    const [row] = await this.tx
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.id, transactionId));
    if (!row) throw new TransactionNotFoundError(`ledger transaction ${transactionId} not found`);
    return this.load(transactionId, false);
  }

  /** The transaction posted under ``idempotencyKey``, if any. */
  async transactionByKey(idempotencyKey: string): Promise<PostedTransaction | null> {
    const row = await this.findByKey(idempotencyKey);
    return row ? this.load(row.id, false) : null;
  }

  async transactionsForReference(referenceType: string, referenceId: string): Promise<PostedTransaction[]> {
    const rows = await this.tx
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.referenceType, referenceType), eq(ledgerTransactions.referenceId, referenceId)))
      .orderBy(asc(ledgerTransactions.id));
    return Promise.all(rows.map((r) => this.load(r.id, false)));
  }

  async balance(accountId: string): Promise<AccountBalance> {
    const [row] = await this.tx
      .select({ a: ledgerAccounts, b: ledgerBalances })
      .from(ledgerAccounts)
      .innerJoin(ledgerBalances, eq(ledgerBalances.accountId, ledgerAccounts.id))
      .where(eq(ledgerAccounts.id, accountId));
    if (!row) throw new AccountNotFoundError(`ledger account ${accountId} not found`);
    return toBalance(row.a, row.b);
  }

  async balancesForOwner(ownerId: string, livemode: boolean): Promise<AccountBalance[]> {
    const rows = await this.tx
      .select({ a: ledgerAccounts, b: ledgerBalances })
      .from(ledgerAccounts)
      .innerJoin(ledgerBalances, eq(ledgerBalances.accountId, ledgerAccounts.id))
      .where(and(eq(ledgerAccounts.ownerId, ownerId), eq(ledgerAccounts.livemode, livemode)))
      .orderBy(asc(ledgerAccounts.code));
    return rows.map((r) => toBalance(r.a, r.b));
  }

  async trialBalance(currency: Currency, livemode: boolean): Promise<TrialBalance> {
    const [row] = await this.tx
      .select({
        d: sql<bigint>`coalesce(sum(${ledgerBalances.debitsTotal}), 0)::bigint`.mapWith(BigInt),
        c: sql<bigint>`coalesce(sum(${ledgerBalances.creditsTotal}), 0)::bigint`.mapWith(BigInt),
      })
      .from(ledgerBalances)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerBalances.accountId))
      .where(and(eq(ledgerAccounts.currency, currency), eq(ledgerAccounts.livemode, livemode)));
    const debits = Money.of(row!.d, currency);
    const credits = Money.of(row!.c, currency);
    return { currency, livemode, debits, credits, isBalanced: debits.equals(credits) };
  }

  /** Recompute every balance from postings; report cached totals that drifted. */
  async reconcile(): Promise<BalanceDiscrepancy[]> {
    const res = await this.tx.execute<{
      id: string;
      code: string;
      debits_total: bigint;
      credits_total: bigint;
      actual_debits: bigint;
      actual_credits: bigint;
    }>(sql`
      SELECT a.id, a.code, b.debits_total, b.credits_total,
             COALESCE(p.d, 0)::bigint AS actual_debits, COALESCE(p.c, 0)::bigint AS actual_credits
        FROM ledger_accounts a
        JOIN ledger_balances b ON b.account_id = a.id
        LEFT JOIN (
              SELECT account_id,
                     SUM(amount) FILTER (WHERE direction = 'debit')  AS d,
                     SUM(amount) FILTER (WHERE direction = 'credit') AS c
                FROM ledger_postings
               GROUP BY account_id
        ) p ON p.account_id = a.id
       WHERE b.debits_total <> COALESCE(p.d, 0)
          OR b.credits_total <> COALESCE(p.c, 0)
       ORDER BY a.id`);
    return res.rows.map((r) => ({
      account_id: r.id,
      code: r.code,
      cached_debits: BigInt(r.debits_total),
      cached_credits: BigInt(r.credits_total),
      actual_debits: BigInt(r.actual_debits),
      actual_credits: BigInt(r.actual_credits),
    }));
  }

  // ---------------------------------------------------------------- internals
  private async findByKey(key: string): Promise<LedgerTransactionRow | null> {
    const [row] = await this.tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, key));
    return row ?? null;
  }

  private async replay(existing: LedgerTransactionRow, fp: string): Promise<PostedTransaction> {
    if (existing.fingerprint !== fp) {
      throw new IdempotencyConflictError("idempotency key was already used for a different ledger transaction", {
        param: "idempotency_key",
      });
    }
    return this.load(existing.id, true);
  }

  private async load(id: string, replayed: boolean): Promise<PostedTransaction> {
    const [t] = await this.tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, id));
    const postings = await this.tx
      .select()
      .from(ledgerPostings)
      .where(eq(ledgerPostings.transactionId, id))
      .orderBy(asc(ledgerPostings.id));
    return {
      id: t!.id,
      idempotencyKey: t!.idempotencyKey,
      description: t!.description,
      referenceType: t!.referenceType,
      referenceId: t!.referenceId,
      reversesId: t!.reversesId,
      livemode: t!.livemode,
      effectiveAt: t!.effectiveAt,
      lines: postings.map((p) => ({
        accountId: p.accountId,
        direction: p.direction as Direction,
        amount: Money.of(p.amount, p.currency),
      })),
      replayed,
    };
  }
}

export function validateShape(request: TransactionRequest): void {
  const key = request.idempotencyKey;
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LEN) {
    throw new InvalidRequestError(`idempotency_key must be 1-${MAX_IDEMPOTENCY_KEY_LEN} characters`, {
      param: "idempotency_key",
    });
  }
  if (!request.description.trim()) throw new InvalidRequestError("description is required", { param: "description" });
  if (request.lines.length < 2) throw new UnbalancedTransactionError("a transaction needs at least two postings");
  if (request.lines.length > MAX_LINES_PER_TRANSACTION) {
    throw new InvalidRequestError(`a transaction may have at most ${MAX_LINES_PER_TRANSACTION} postings`);
  }
  const net = new Map<string, bigint>();
  for (const ln of request.lines) {
    if (!ln.amount.isPositive()) throw new InvalidAmountError("posting amounts must be positive", { param: "amount" });
    const sign = ln.direction === "debit" ? 1n : -1n;
    net.set(ln.amount.currency, (net.get(ln.amount.currency) ?? 0n) + sign * ln.amount.amount);
  }
  const unbalanced = Object.fromEntries([...net].filter(([, n]) => n !== 0n));
  if (Object.keys(unbalanced).length > 0) {
    throw new UnbalancedTransactionError("debits must equal credits in every currency", {
      details: { net_by_currency: unbalanced },
    });
  }
}

function checkAccounts(lines: readonly PostingLine[], accounts: Map<string, LedgerAccountRow>): boolean {
  const modes = new Set([...accounts.values()].map((a) => a.livemode));
  if (modes.size !== 1) throw new InvalidRequestError("cannot mix test-mode and live-mode ledger accounts");
  for (const ln of lines) {
    const account = accounts.get(ln.accountId)!;
    if (account.currency !== ln.amount.currency) {
      throw new CurrencyMismatchError(`account ${account.code} is ${account.currency}, posting is ${ln.amount.currency}`);
    }
    if (account.status !== "active") throw new ConflictError(`ledger account ${account.code} is ${account.status}`);
  }
  return [...modes][0]!;
}

function checkFunds(
  lines: readonly PostingLine[],
  accounts: Map<string, LedgerAccountRow>,
  balances: Map<string, LedgerBalanceRow>,
): Map<string, [bigint, bigint]> {
  const deltas = new Map<string, [bigint, bigint]>();
  for (const ln of lines) {
    const d = deltas.get(ln.accountId) ?? [0n, 0n];
    if (ln.direction === "debit") d[0] += ln.amount.amount;
    else d[1] += ln.amount.amount;
    deltas.set(ln.accountId, d);
  }
  for (const [accountId, [d, c]] of deltas) {
    const account = accounts.get(accountId)!;
    if (account.allowNegative) continue;
    const bal = balances.get(accountId)!;
    const type = account.type as AccountType;
    const before = normalBalance(type, bal.debitsTotal, bal.creditsTotal);
    const after = normalBalance(type, bal.debitsTotal + d, bal.creditsTotal + c);
    // Only block movements that make things worse.
    if (after < 0n && after < before) {
      throw new InsufficientBalanceError(`insufficient balance in ${account.code}`, {
        details: { account: account.code, available: before, requested: before - after, currency: account.currency },
      });
    }
  }
  return deltas;
}

function toBalance(a: LedgerAccountRow, b: LedgerBalanceRow): AccountBalance {
  return new AccountBalance(a.id, a.code, a.type as AccountType, Money.of(b.debitsTotal, a.currency), Money.of(b.creditsTotal, a.currency));
}
