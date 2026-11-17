/**
 * Orders, payments and the per-payment event log. Card data: only BIN, last 4,
 * network, expiry and a keyed fingerprint — never the PAN or CVV.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, unique, uniqueIndex, varchar } from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

import { ts } from "./common.js";
import { stations } from "./station.js";

export const orders = pgTable(
  "orders",
  {
    id: varchar("id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    receipt: varchar("receipt", { length: 40 }),
    notes: jsonbExact<Record<string, unknown>>("notes")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar("status", { length: 16 }).notNull(),
    amountPaid: bigint("amount_paid", { mode: "bigint" }).notNull(),
    attempts: integer("attempts").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_orders", columns: [t.id] }),
    foreignKey({ name: "fk_orders_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete("restrict"),
    check("ck_orders_amount_positive", sql`amount > 0`),
    check("ck_orders_valid_currency", sql`currency IN ('INR','USD')`),
    check("ck_orders_valid_status", sql`status IN ('created','attempted','paid')`),
    index("ix_orders_station_mode_id").on(t.stationId, t.livemode, t.id),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: varchar("id", { length: 40 }).notNull(),
    orderId: varchar("order_id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    method: varchar("method", { length: 16 }).notNull(),
    captureMode: varchar("capture_mode", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    cardNetwork: varchar("card_network", { length: 16 }),
    cardBin: varchar("card_bin", { length: 8 }),
    cardLast4: varchar("card_last4", { length: 4 }),
    cardExpiryMonth: integer("card_expiry_month"),
    cardExpiryYear: integer("card_expiry_year"),
    vpa: varchar("vpa", { length: 256 }),
    bankCode: varchar("bank_code", { length: 16 }),
    instrumentFingerprint: varchar("instrument_fingerprint", { length: 64 }).notNull(),
    customerEmail: varchar("customer_email", { length: 320 }),
    junctionRef: varchar("junction_ref", { length: 20 }),
    junctionSequence: integer("junction_sequence").notNull(),
    testScenario: varchar("test_scenario", { length: 64 }),
    errorCode: varchar("error_code", { length: 64 }),
    errorDescription: varchar("error_description", { length: 300 }),
    riskDecision: varchar("risk_decision", { length: 8 }).notNull(),
    riskScore: integer("risk_score").notNull(),
    riskReasons: jsonbExact<Record<string, unknown>[]>("risk_reasons")
      .notNull()
      .default(sql`'[]'::jsonb`),
    riskReviewStatus: varchar("risk_review_status", { length: 16 }).notNull(),
    riskReviewedBy: varchar("risk_reviewed_by", { length: 40 }),
    riskReviewedAt: ts("risk_reviewed_at"),
    fee: bigint("fee", { mode: "bigint" }),
    tax: bigint("tax", { mode: "bigint" }),
    authorizedAt: ts("authorized_at"),
    capturedAt: ts("captured_at"),
    failedAt: ts("failed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_payments", columns: [t.id] }),
    foreignKey({ name: "fk_payments_order_id_orders", columns: [t.orderId], foreignColumns: [orders.id] }).onDelete("restrict"),
    foreignKey({ name: "fk_payments_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete("restrict"),
    check("ck_payments_amount_positive", sql`amount > 0`),
    check("ck_payments_valid_capture_mode", sql`capture_mode IN ('automatic','manual')`),
    check("ck_payments_valid_currency", sql`currency IN ('INR','USD')`),
    check("ck_payments_valid_method", sql`method IN ('card','upi','netbanking')`),
    check("ck_payments_valid_risk_decision", sql`risk_decision IN ('allow','review','block')`),
    check("ck_payments_valid_risk_review_status", sql`risk_review_status IN ('not_required','pending','approved','rejected')`),
    check("ck_payments_valid_status", sql`status IN ('created','pending','authorized','captured','failed')`),
    index("ix_payments_fingerprint_created").on(t.instrumentFingerprint, t.createdAt),
    index("ix_payments_junction_ref").on(t.junctionRef),
    index("ix_payments_order_id").on(t.orderId),
    index("ix_payments_station_mode_id").on(t.stationId, t.livemode, t.id),
    // M2 (Depot): unsettled captured payments by capture time.
    index("ix_payments_station_captured")
      .on(t.stationId, t.livemode, t.capturedAt)
      .where(sql`status = 'captured'`),
    uniqueIndex("uq_payments_order_in_flight")
      .on(t.orderId)
      .where(sql`status <> 'failed'`),
  ],
);

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    paymentId: varchar("payment_id", { length: 40 }).notNull(),
    source: varchar("source", { length: 16 }).notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    junctionEventId: varchar("junction_event_id", { length: 64 }),
    sequence: integer("sequence"),
    applied: boolean("applied").notNull(),
    note: varchar("note", { length: 300 }),
    payload: jsonbExact<Record<string, unknown>>("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_payment_events", columns: [t.id] }),
    unique("uq_payment_events_junction_event_id").on(t.junctionEventId),
    foreignKey({ name: "fk_payment_events_payment_id_payments", columns: [t.paymentId], foreignColumns: [payments.id] }).onDelete(
      "restrict",
    ),
    index("ix_payment_events_payment_id").on(t.paymentId),
  ],
);

export type Order = typeof orders.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type PaymentStatus = "created" | "pending" | "authorized" | "captured" | "failed";
export const PAYMENT_STATUSES = ["created", "pending", "authorized", "captured", "failed"] as const;
export type PaymentMethod = "card" | "upi" | "netbanking";
export type CaptureMode = "automatic" | "manual";
