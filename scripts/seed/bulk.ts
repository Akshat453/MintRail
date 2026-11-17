/**
 * Seed-only bulk writers.
 *
 * ``bulkInsert`` sends whole columns as Postgres arrays (``unnest``), so 10k rows
 * cost one round trip. ``BufferedLedger`` implements the slice of LedgerService
 * the ledger *recipes* use, buffering postings in memory and flushing them per
 * simulated day — the recipes themselves (keys, lines, descriptions, metadata,
 * fingerprints) are the production ones, so the seeded ledger is exactly what
 * the live system would have written.
 */
import type pg from "pg";

import { IdPrefix, Money, newId, type Tx } from "@mintrail/shared";
import {
  fingerprint,
  flipped,
  type LedgerAccountRow,
  LedgerService,
  type NewAccount,
  type PostedTransaction,
  type TransactionRequest,
  validateShape,
} from "@mintrail/ledger";

export type Col = [name: string, pgType: string];

/** Postgres array literal element quoting. */
const quote = (x: unknown): string => `"${String(x).replace(/["\\]/g, (c) => `\\${c}`)}"`;

function toPg(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return `{${v.map(quote).join(",")}}`;
  if (typeof v === "object") return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
  return v;
}

export async function bulkInsert(
  client: pg.Pool | pg.PoolClient,
  table: string,
  cols: Col[],
  rows: unknown[][],
  chunk = 10_000,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const arrays = cols.map((_, c) => part.map((r) => toPg(r[c])));
    // jsonb, arrays and bytea travel as text and are converted in the SELECT.
    const viaText = (t: string) => t === "jsonb" || t.endsWith("[]") || t === "bytea";
    const select = cols
      .map(([, t], c) => (t === "bytea" ? `decode(u.c${c}, 'base64')` : viaText(t) ? `u.c${c}::${t}` : `u.c${c}`))
      .join(", ");
    const unnest = cols.map(([, t], c) => `$${c + 1}::${viaText(t) ? "text" : t}[]`).join(", ");
    const alias = cols.map((_, c) => `c${c}`).join(", ");
    await client.query(
      `INSERT INTO ${table} (${cols.map(([n]) => n).join(", ")}) SELECT ${select} FROM unnest(${unnest}) AS u(${alias})`,
      arrays,
    );
  }
}

interface Pending {
  txn: unknown[];
  postings: unknown[][];
}

export class BufferedLedger {
  private readonly accounts = new Map<string, LedgerAccountRow>();
  private readonly accountsById = new Map<string, LedgerAccountRow>();
  private readonly byKey = new Map<string, PostedTransaction>();
  private readonly byId = new Map<string, PostedTransaction>();
  private pending: Pending[] = [];
  private deltas = new Map<string, [bigint, bigint]>();
  /** Running normal balance per account code (for the seed's own overdraft checks). */
  readonly balances = new Map<string, bigint>();
  now: Date = new Date();

  constructor(private readonly tx: Tx) {}

  async ensureAccount(spec: NewAccount): Promise<LedgerAccountRow> {
    const hit = this.accounts.get(spec.code);
    if (hit) return hit;
    const row = await new LedgerService(this.tx).ensureAccount(spec);
    this.accounts.set(row.code, row);
    this.accountsById.set(row.id, row);
    return row;
  }

  balance(code: string): bigint {
    return this.balances.get(code) ?? 0n;
  }

  async post(req: TransactionRequest): Promise<PostedTransaction> {
    validateShape(req);
    const prior = this.byKey.get(req.idempotencyKey);
    if (prior) return { ...prior, replayed: true };
    const id = newId(IdPrefix.LEDGER_TRANSACTION, BigInt(this.now.getTime()));
    const livemode = this.accountsById.get(req.lines[0]!.accountId)!.livemode;
    const effectiveAt = (req.effectiveAt ?? this.now).toISOString();
    const posted: PostedTransaction = {
      id,
      idempotencyKey: req.idempotencyKey,
      description: req.description,
      referenceType: req.referenceType ?? null,
      referenceId: req.referenceId ?? null,
      reversesId: req.reversesId ?? null,
      livemode,
      effectiveAt,
      lines: req.lines.map((l) => ({ accountId: l.accountId, direction: l.direction, amount: l.amount })),
      replayed: false,
    };
    this.pending.push({
      txn: [
        id,
        req.idempotencyKey,
        fingerprint(req),
        req.description,
        req.referenceType ?? null,
        req.referenceId ?? null,
        req.reversesId ?? null,
        livemode,
        effectiveAt,
        req.metadata ?? {},
        effectiveAt,
      ],
      postings: req.lines.map((l) => [id, l.accountId, l.direction, l.amount.amount, l.amount.currency, effectiveAt]),
    });
    for (const l of req.lines) {
      const d = this.deltas.get(l.accountId) ?? [0n, 0n];
      if (l.direction === "debit") d[0] += l.amount.amount;
      else d[1] += l.amount.amount;
      this.deltas.set(l.accountId, d);
      const acct = this.accountsById.get(l.accountId)!;
      const debitNormal = acct.type === "asset" || acct.type === "expense";
      const sign = (l.direction === "debit") === debitNormal ? 1n : -1n;
      this.balances.set(acct.code, this.balance(acct.code) + sign * l.amount.amount);
    }
    this.byKey.set(req.idempotencyKey, posted);
    this.byId.set(id, posted);
    return posted;
  }

  async transactionByKey(key: string): Promise<PostedTransaction | null> {
    return this.byKey.get(key) ?? null;
  }

  async reverse(transactionId: string, opts: { idempotencyKey: string; description?: string }): Promise<PostedTransaction> {
    const original = this.byId.get(transactionId)!;
    return this.post({
      idempotencyKey: opts.idempotencyKey,
      description: opts.description || `Reversal of ${transactionId}`,
      lines: original.lines.map((l) => ({
        accountId: l.accountId,
        direction: flipped(l.direction),
        amount: Money.of(l.amount.amount, l.amount.currency),
      })),
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      reversesId: transactionId,
    });
  }

  /** Write buffered transactions/postings and bump cached balances. */
  async flush(client: pg.PoolClient): Promise<number> {
    if (this.pending.length === 0) return 0;
    await bulkInsert(
      client,
      "ledger_transactions",
      [
        ["id", "text"],
        ["idempotency_key", "text"],
        ["fingerprint", "text"],
        ["description", "text"],
        ["reference_type", "text"],
        ["reference_id", "text"],
        ["reverses_id", "text"],
        ["livemode", "boolean"],
        ["effective_at", "timestamptz"],
        ["metadata", "jsonb"],
        ["created_at", "timestamptz"],
      ],
      this.pending.map((p) => p.txn),
    );
    await bulkInsert(
      client,
      "ledger_postings",
      [
        ["transaction_id", "text"],
        ["account_id", "text"],
        ["direction", "text"],
        ["amount", "bigint"],
        ["currency", "text"],
        ["created_at", "timestamptz"],
      ],
      this.pending.flatMap((p) => p.postings),
      20_000,
    );
    const ids = [...this.deltas.keys()];
    await client.query(
      `UPDATE ledger_balances b SET debits_total = b.debits_total + u.d, credits_total = b.credits_total + u.c, version = b.version + 1, updated_at = now()
         FROM unnest($1::text[], $2::bigint[], $3::bigint[]) AS u(id, d, c) WHERE b.account_id = u.id`,
      [ids, ids.map((i) => this.deltas.get(i)![0].toString()), ids.map((i) => this.deltas.get(i)![1].toString())],
    );
    const n = this.pending.length;
    this.pending = [];
    this.deltas = new Map();
    return n;
  }

  /** Re-read balances the settlement engine changed directly in the database. */
  async refresh(client: pg.PoolClient): Promise<void> {
    const r = await client.query<{ code: string; type: string; d: string; c: string }>(
      "SELECT a.code, a.type, b.debits_total::text AS d, b.credits_total::text AS c FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id",
    );
    for (const row of r.rows) {
      const debitNormal = row.type === "asset" || row.type === "expense";
      this.balances.set(row.code, debitNormal ? BigInt(row.d) - BigInt(row.c) : BigInt(row.c) - BigInt(row.d));
    }
  }
}
