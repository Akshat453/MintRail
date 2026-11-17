/** Freight: payouts from a Station's balance to bank accounts / VPAs (M2, ADR-0016). */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, varchar } from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

import { ts } from "./common.js";
import { stations } from "./station.js";

export const PAYOUT_STATUSES = ["pending_approval", "queued", "processing", "processed", "failed", "rejected", "cancelled"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const PAYOUT_MODES = ["IMPS", "NEFT", "RTGS", "UPI"] as const;
export type PayoutMode = (typeof PAYOUT_MODES)[number];

export const payoutBatches = pgTable(
  "payout_batches",
  {
    id: varchar("id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    filename: varchar("filename", { length: 200 }).notNull(),
    rowCount: integer("row_count").notNull(),
    acceptedCount: integer("accepted_count").notNull(),
    rejectedCount: integer("rejected_count").notNull(),
    totalAmount: bigint("total_amount", { mode: "bigint" }).notNull(),
    errors: jsonbExact<Record<string, unknown>[]>("errors")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: varchar("created_by", { length: 64 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_payout_batches", columns: [t.id] }),
    foreignKey({ name: "fk_payout_batches_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete(
      "restrict",
    ),
    index("ix_payout_batches_station_mode_id").on(t.stationId, t.livemode, t.id),
  ],
);

export const payouts = pgTable(
  "payouts",
  {
    id: varchar("id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    batchId: varchar("batch_id", { length: 40 }),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    purpose: varchar("purpose", { length: 32 }).notNull(),
    beneficiaryName: varchar("beneficiary_name", { length: 120 }).notNull(),
    accountNumber: varchar("account_number", { length: 20 }),
    ifsc: varchar("ifsc", { length: 11 }),
    vpa: varchar("vpa", { length: 256 }),
    reference: varchar("reference", { length: 40 }),
    narration: varchar("narration", { length: 30 }),
    status: varchar("status", { length: 20 }).notNull(),
    junctionRef: varchar("junction_ref", { length: 20 }),
    utr: varchar("utr", { length: 22 }),
    testScenario: varchar("test_scenario", { length: 64 }),
    failureReason: varchar("failure_reason", { length: 200 }),
    approvedBy: varchar("approved_by", { length: 40 }),
    approvedAt: ts("approved_at"),
    rejectedReason: varchar("rejected_reason", { length: 500 }),
    processedAt: ts("processed_at"),
    failedAt: ts("failed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_payouts", columns: [t.id] }),
    foreignKey({ name: "fk_payouts_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete("restrict"),
    foreignKey({ name: "fk_payouts_batch_id_payout_batches", columns: [t.batchId], foreignColumns: [payoutBatches.id] }).onDelete(
      "restrict",
    ),
    check("ck_payouts_amount_positive", sql`amount > 0`),
    check("ck_payouts_valid_currency", sql`currency = 'INR'`),
    check("ck_payouts_valid_mode", sql`mode IN ('IMPS','NEFT','RTGS','UPI')`),
    check("ck_payouts_valid_status", sql`status IN ('pending_approval','queued','processing','processed','failed','rejected','cancelled')`),
    check("ck_payouts_destination", sql`(vpa IS NOT NULL) <> (account_number IS NOT NULL AND ifsc IS NOT NULL)`),
    index("ix_payouts_station_mode_id").on(t.stationId, t.livemode, t.id),
    index("ix_payouts_station_created").on(t.stationId, t.livemode, t.createdAt),
    index("ix_payouts_status").on(t.status),
  ],
);

export type Payout = typeof payouts.$inferSelect;
export type PayoutBatch = typeof payoutBatches.$inferSelect;
