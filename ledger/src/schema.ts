/**
 * Ledger tables (owned by @mintrail/ledger). Names match the M1 schema exactly
 * (docs/contract/schema-m1.sql), including M1's double-prefixed check names.
 * DB-level invariants (balanced postings, currency match, append-only) live in
 * triggers created by the baseline migration — see ADR-0003.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: varchar("id", { length: 40 }).notNull(),
    code: varchar("code", { length: 200 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    type: varchar("type", { length: 16 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    ownerId: varchar("owner_id", { length: 40 }),
    livemode: boolean("livemode").notNull(),
    allowNegative: boolean("allow_negative").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_ledger_accounts", columns: [t.id] }),
    unique("uq_ledger_accounts_code").on(t.code),
    check("ck_ledger_accounts_ck_ledger_accounts_valid_type", sql`type IN ('asset','liability','equity','revenue','expense')`),
    check("ck_ledger_accounts_ck_ledger_accounts_valid_status", sql`status IN ('active','frozen')`),
    index("ix_ledger_accounts_owner_id").on(t.ownerId),
  ],
);

export const ledgerBalances = pgTable(
  "ledger_balances",
  {
    accountId: varchar("account_id", { length: 40 }).notNull(),
    debitsTotal: bigint("debits_total", { mode: "bigint" }).notNull(),
    creditsTotal: bigint("credits_total", { mode: "bigint" }).notNull(),
    version: integer("version").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_ledger_balances", columns: [t.accountId] }),
    foreignKey({
      name: "fk_ledger_balances_account_id_ledger_accounts",
      columns: [t.accountId],
      foreignColumns: [ledgerAccounts.id],
    }).onDelete("restrict"),
    check("ck_ledger_balances_ck_ledger_balances_debits_non_negative", sql`debits_total >= 0`),
    check("ck_ledger_balances_ck_ledger_balances_credits_non_negative", sql`credits_total >= 0`),
  ],
);

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: varchar("id", { length: 40 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: varchar("reference_id", { length: 40 }),
    reversesId: varchar("reverses_id", { length: 40 }),
    livemode: boolean("livemode").notNull(),
    effectiveAt: ts("effective_at").notNull(),
    metadata: jsonbExact<Record<string, unknown>>("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_ledger_transactions", columns: [t.id] }),
    unique("uq_ledger_transactions_idempotency_key").on(t.idempotencyKey),
    foreignKey({ name: "fk_ledger_transactions_reverses_id_ledger_transactions", columns: [t.reversesId], foreignColumns: [t.id] }),
    index("ix_ledger_transactions_reference").on(t.referenceType, t.referenceId),
    uniqueIndex("uq_ledger_transactions_reverses_id")
      .on(t.reversesId)
      .where(sql`reverses_id IS NOT NULL`),
  ],
);

export const ledgerPostings = pgTable(
  "ledger_postings",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    transactionId: varchar("transaction_id", { length: 40 }).notNull(),
    accountId: varchar("account_id", { length: 40 }).notNull(),
    direction: varchar("direction", { length: 6 }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_ledger_postings", columns: [t.id] }),
    foreignKey({
      name: "fk_ledger_postings_transaction_id_ledger_transactions",
      columns: [t.transactionId],
      foreignColumns: [ledgerTransactions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_ledger_postings_account_id_ledger_accounts",
      columns: [t.accountId],
      foreignColumns: [ledgerAccounts.id],
    }).onDelete("restrict"),
    check("ck_ledger_postings_ck_ledger_postings_amount_positive", sql`amount > 0`),
    check("ck_ledger_postings_ck_ledger_postings_valid_direction", sql`direction IN ('debit','credit')`),
    index("ix_ledger_postings_account_id_id").on(t.accountId, t.id),
    index("ix_ledger_postings_transaction_id").on(t.transactionId),
  ],
);

export type LedgerAccountRow = typeof ledgerAccounts.$inferSelect;
export type LedgerBalanceRow = typeof ledgerBalances.$inferSelect;
export type LedgerTransactionRow = typeof ledgerTransactions.$inferSelect;
export type LedgerPostingRow = typeof ledgerPostings.$inferSelect;
