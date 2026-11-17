/**
 * Depot data (M2, ADR-0014): settlement batches and their line entries, the
 * reconciliation reports that check them against the ledger, and FX snapshots.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

import { ts } from "./common.js";
import { stations } from "./station.js";

export const SETTLEMENT_STATUSES = ["processing", "processed", "failed"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** Entry kinds; ``amount`` sign: credits to the merchant are positive, deductions negative. */
export const ENTRY_KINDS = [
  "payment",
  "refund",
  "refund_reversal",
  "payout",
  "payout_reversal",
  "dispute_recovery",
  "dispute_release",
  "reserve_hold",
  "reserve_release",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const settlements = pgTable(
  "settlements",
  {
    id: varchar("id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    settlementDate: date("settlement_date", { mode: "string" }).notNull(),
    schedule: varchar("schedule", { length: 4 }).notNull(),
    cutoffAt: ts("cutoff_at").notNull(),
    entryCount: integer("entry_count").notNull(),
    gross: bigint("gross", { mode: "bigint" }).notNull(),
    fees: bigint("fees", { mode: "bigint" }).notNull(),
    tax: bigint("tax", { mode: "bigint" }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    payoutCurrency: varchar("payout_currency", { length: 3 }).notNull(),
    payoutAmount: bigint("payout_amount", { mode: "bigint" }).notNull(),
    fxRateId: varchar("fx_rate_id", { length: 40 }),
    fxRate: numeric("fx_rate", { precision: 20, scale: 10 }),
    status: varchar("status", { length: 16 }).notNull(),
    utr: varchar("utr", { length: 22 }),
    ledgerTransactionId: varchar("ledger_transaction_id", { length: 40 }),
    processedAt: ts("processed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_settlements", columns: [t.id] }),
    foreignKey({ name: "fk_settlements_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete("restrict"),
    unique("uq_settlements_batch").on(t.stationId, t.livemode, t.currency, t.settlementDate),
    check("ck_settlements_amount_identity", sql`amount = gross - fees - tax`),
    check("ck_settlements_amount_positive", sql`amount >= 0 AND payout_amount >= 0`),
    check("ck_settlements_valid_status", sql`status IN ('processing','processed','failed')`),
    index("ix_settlements_station_mode_id").on(t.stationId, t.livemode, t.id),
    index("ix_settlements_date").on(t.settlementDate),
  ],
);

export const settlementEntries = pgTable(
  "settlement_entries",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    settlementId: varchar("settlement_id", { length: 40 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    referenceId: varchar("reference_id", { length: 64 }).notNull(),
    occurredAt: ts("occurred_at").notNull(),
    gross: bigint("gross", { mode: "bigint" }).notNull(),
    fee: bigint("fee", { mode: "bigint" }).notNull(),
    tax: bigint("tax", { mode: "bigint" }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    releaseOn: date("release_on", { mode: "string" }),
  },
  (t) => [
    primaryKey({ name: "pk_settlement_entries", columns: [t.id] }),
    foreignKey({
      name: "fk_settlement_entries_settlement_id_settlements",
      columns: [t.settlementId],
      foreignColumns: [settlements.id],
    }).onDelete("restrict"),
    unique("uq_settlement_entries_item").on(t.kind, t.referenceId),
    check("ck_settlement_entries_amount_identity", sql`amount = gross - fee - tax`),
    check(
      "ck_settlement_entries_valid_kind",
      sql`kind IN ('payment','refund','refund_reversal','payout','payout_reversal','dispute_recovery','dispute_release','reserve_hold','reserve_release')`,
    ),
    index("ix_settlement_entries_settlement_id").on(t.settlementId),
  ],
);

export const reconciliationReports = pgTable(
  "reconciliation_reports",
  {
    id: varchar("id", { length: 40 }).notNull(),
    runAt: ts("run_at").notNull().defaultNow(),
    status: varchar("status", { length: 16 }).notNull(),
    stationsChecked: integer("stations_checked").notNull(),
    settlementsChecked: integer("settlements_checked").notNull(),
    mismatchCount: integer("mismatch_count").notNull(),
    totals: jsonbExact<Record<string, unknown>>("totals")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    primaryKey({ name: "pk_reconciliation_reports", columns: [t.id] }),
    check("ck_reconciliation_reports_valid_status", sql`status IN ('ok','mismatch')`),
  ],
);

export const reconciliationItems = pgTable(
  "reconciliation_items",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    reportId: varchar("report_id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }),
    livemode: boolean("livemode"),
    currency: varchar("currency", { length: 3 }),
    check: varchar("check_name", { length: 40 }).notNull(),
    referenceId: varchar("reference_id", { length: 64 }),
    expected: bigint("expected", { mode: "bigint" }),
    actual: bigint("actual", { mode: "bigint" }),
    detail: varchar("detail", { length: 500 }),
  },
  (t) => [
    primaryKey({ name: "pk_reconciliation_items", columns: [t.id] }),
    foreignKey({
      name: "fk_reconciliation_items_report_id_reconciliation_reports",
      columns: [t.reportId],
      foreignColumns: [reconciliationReports.id],
    }).onDelete("cascade"),
    index("ix_reconciliation_items_report_id").on(t.reportId),
  ],
);

export const fxRates = pgTable(
  "fx_rates",
  {
    id: varchar("id", { length: 40 }).notNull(),
    base: varchar("base", { length: 3 }).notNull(),
    quote: varchar("quote", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    source: varchar("source", { length: 40 }).notNull(),
    asOf: ts("as_of").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_fx_rates", columns: [t.id] }),
    check("ck_fx_rates_positive", sql`rate > 0`),
    index("ix_fx_rates_pair_as_of").on(t.base, t.quote, t.asOf),
  ],
);

export type Settlement = typeof settlements.$inferSelect;
export type SettlementEntry = typeof settlementEntries.$inferSelect;
export type ReconciliationReport = typeof reconciliationReports.$inferSelect;
export type ReconciliationItem = typeof reconciliationItems.$inferSelect;
export type FxRate = typeof fxRates.$inferSelect;
