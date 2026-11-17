/** Refunds (M2, ADR-0012): many partial refunds per captured payment, never more than captured in total. */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, pgTable, primaryKey, varchar } from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

import { ts } from "./common.js";
import { payments } from "./payments.js";
import { stations } from "./station.js";

export const REFUND_STATUSES = ["pending", "processed", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const REFUND_REASONS = ["requested_by_customer", "duplicate", "fraudulent", "order_cancelled", "other"] as const;
export const REFUND_SPEEDS = ["normal", "instant"] as const;

export const refunds = pgTable(
  "refunds",
  {
    id: varchar("id", { length: 40 }).notNull(),
    paymentId: varchar("payment_id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    reason: varchar("reason", { length: 32 }).notNull(),
    speed: varchar("speed", { length: 8 }).notNull(),
    fee: bigint("fee", { mode: "bigint" }).notNull(),
    tax: bigint("tax", { mode: "bigint" }).notNull(),
    notes: jsonbExact<Record<string, unknown>>("notes")
      .notNull()
      .default(sql`'{}'::jsonb`),
    junctionRef: varchar("junction_ref", { length: 20 }),
    testScenario: varchar("test_scenario", { length: 64 }),
    errorCode: varchar("error_code", { length: 64 }),
    errorDescription: varchar("error_description", { length: 300 }),
    processedAt: ts("processed_at"),
    failedAt: ts("failed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_refunds", columns: [t.id] }),
    foreignKey({ name: "fk_refunds_payment_id_payments", columns: [t.paymentId], foreignColumns: [payments.id] }).onDelete("restrict"),
    foreignKey({ name: "fk_refunds_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete("restrict"),
    check("ck_refunds_amount_positive", sql`amount > 0`),
    check("ck_refunds_fee_non_negative", sql`fee >= 0 AND tax >= 0`),
    check("ck_refunds_valid_status", sql`status IN ('pending','processed','failed')`),
    check("ck_refunds_valid_speed", sql`speed IN ('normal','instant')`),
    check("ck_refunds_valid_currency", sql`currency IN ('INR','USD')`),
    index("ix_refunds_payment_id").on(t.paymentId),
    index("ix_refunds_station_mode_id").on(t.stationId, t.livemode, t.id),
    index("ix_refunds_station_created").on(t.stationId, t.livemode, t.createdAt),
  ],
);

export type Refund = typeof refunds.$inferSelect;
