/** Junction's own state: the bank-side view of each authorization. */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, primaryKey, timestamp, unique, varchar } from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const BankStatus = {
  RECEIVED: "received",
  PENDING: "pending",
  AUTHORIZED: "authorized",
  DECLINED: "declined",
  CAPTURED: "captured",
  VOIDED: "voided",
} as const;

export const junctionAuthorizations = pgTable(
  "junction_authorizations",
  {
    ref: varchar("ref", { length: 20 }).notNull(),
    paymentId: varchar("payment_id", { length: 40 }).notNull(),
    merchantRef: varchar("merchant_ref", { length: 40 }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    method: varchar("method", { length: 16 }).notNull(),
    instrument: varchar("instrument", { length: 64 }).notNull(),
    livemode: boolean("livemode").notNull(),
    scenario: varchar("scenario", { length: 64 }),
    status: varchar("status", { length: 16 }).notNull(),
    declineCode: varchar("decline_code", { length: 64 }),
    plan: jsonbExact<Record<string, unknown>>("plan")
      .notNull()
      .default(sql`'{}'::jsonb`),
    sequence: integer("sequence").notNull(),
    requestsSeen: integer("requests_seen").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_junction_authorizations", columns: [t.ref] }),
    unique("uq_junction_authorizations_payment_id").on(t.paymentId),
    check("ck_junction_authorizations_valid_status", sql`status IN ('received','pending','authorized','declined','captured','voided')`),
    check("ck_junction_authorizations_amount_positive", sql`amount > 0`),
  ],
);

export type JunctionAuthorization = typeof junctionAuthorizations.$inferSelect;

// ---------------------------------------------------------------- M2: refunds, disputes, payouts
export const junctionRefunds = pgTable(
  "junction_refunds",
  {
    ref: varchar("ref", { length: 20 }).notNull(),
    refundId: varchar("refund_id", { length: 40 }).notNull(),
    authRef: varchar("auth_ref", { length: 20 }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    speed: varchar("speed", { length: 8 }).notNull(),
    scenario: varchar("scenario", { length: 64 }),
    status: varchar("status", { length: 16 }).notNull(),
    failureReason: varchar("failure_reason", { length: 64 }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_junction_refunds", columns: [t.ref] }),
    unique("uq_junction_refunds_refund_id").on(t.refundId),
    check("ck_junction_refunds_valid_status", sql`status IN ('pending','processed','failed')`),
    check("ck_junction_refunds_amount_positive", sql`amount > 0`),
  ],
);

export const junctionDisputes = pgTable(
  "junction_disputes",
  {
    ref: varchar("ref", { length: 20 }).notNull(),
    authRef: varchar("auth_ref", { length: 20 }).notNull(),
    paymentId: varchar("payment_id", { length: 40 }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    reason: varchar("reason", { length: 32 }).notNull(),
    scenario: varchar("scenario", { length: 64 }),
    status: varchar("status", { length: 24 }).notNull(),
    evidenceCount: integer("evidence_count").notNull(),
    dueAt: ts("due_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_junction_disputes", columns: [t.ref] }),
    check("ck_junction_disputes_valid_status", sql`status IN ('open','evidence_submitted','won','lost')`),
    check("ck_junction_disputes_amount_positive", sql`amount > 0`),
  ],
);

export const junctionPayouts = pgTable(
  "junction_payouts",
  {
    ref: varchar("ref", { length: 20 }).notNull(),
    payoutId: varchar("payout_id", { length: 40 }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    mode: varchar("mode", { length: 8 }).notNull(),
    destination: varchar("destination", { length: 64 }).notNull(),
    scenario: varchar("scenario", { length: 64 }),
    status: varchar("status", { length: 16 }).notNull(),
    utr: varchar("utr", { length: 22 }),
    failureReason: varchar("failure_reason", { length: 64 }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_junction_payouts", columns: [t.ref] }),
    unique("uq_junction_payouts_payout_id").on(t.payoutId),
    check("ck_junction_payouts_valid_status", sql`status IN ('pending','processed','failed')`),
    check("ck_junction_payouts_amount_positive", sql`amount > 0`),
  ],
);

export type JunctionRefund = typeof junctionRefunds.$inferSelect;
export type JunctionDispute = typeof junctionDisputes.$inferSelect;
export type JunctionPayout = typeof junctionPayouts.$inferSelect;
