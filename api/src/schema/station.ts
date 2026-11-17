/** Stations (merchant accounts) and their API keys. Names match docs/contract/schema-m1.sql. */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, unique, uniqueIndex, varchar } from "drizzle-orm/pg-core";

import { bytea } from "@mintrail/shared";

import { ts } from "./common.js";

export const stations = pgTable(
  "stations",
  {
    id: varchar("id", { length: 40 }).notNull(),
    legalName: varchar("legal_name", { length: 200 }).notNull(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    businessCategory: varchar("business_category", { length: 4 }).notNull(),
    country: varchar("country", { length: 2 }).notNull(),
    defaultCurrency: varchar("default_currency", { length: 3 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    suspendedReason: varchar("suspended_reason", { length: 500 }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    kycStatus: varchar("kyc_status", { length: 16 }).notNull(),
    settlementSchedule: varchar("settlement_schedule", { length: 4 }).notNull(),
    feePlan: varchar("fee_plan", { length: 16 }).notNull(),
    autoCapture: boolean("auto_capture").notNull(),
    rateLimitPerSec: integer("rate_limit_per_sec").notNull(),
    rateLimitBurst: integer("rate_limit_burst").notNull(),
    kycRejectionReason: varchar("kyc_rejection_reason", { length: 500 }),
    kycReviewedBy: varchar("kyc_reviewed_by", { length: 40 }),
    kycReviewedAt: ts("kyc_reviewed_at"),
    webhookUrl: varchar("webhook_url", { length: 500 }),
    maxPaymentAmount: bigint("max_payment_amount", { mode: "bigint" }),
  },
  (t) => [
    primaryKey({ name: "pk_stations", columns: [t.id] }),
    check("ck_stations_ck_stations_mcc_format", sql`business_category ~ '^[0-9]{4}$'`),
    check("ck_stations_ck_stations_valid_status", sql`status IN ('active','suspended')`),
    check("ck_stations_rate_limit", sql`rate_limit_per_sec > 0 AND rate_limit_burst > 0`),
    check("ck_stations_valid_fee_plan", sql`fee_plan IN ('standard','growth','enterprise')`),
    check("ck_stations_valid_kyc", sql`kyc_status IN ('pending','verified','rejected')`),
    check("ck_stations_valid_settlement_schedule", sql`settlement_schedule IN ('T+1','T+2','T+3')`),
    uniqueIndex("uq_stations_email_lower").using("btree", sql`lower((email)::text)`),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: varchar("id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    mode: varchar("mode", { length: 4 }).notNull(),
    secretHash: varchar("secret_hash", { length: 64 }).notNull(),
    hint: varchar("hint", { length: 32 }).notNull(),
    status: varchar("status", { length: 8 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    label: varchar("label", { length: 100 }),
    scopes: varchar("scopes", { length: 32 }).array().notNull(),
    signingKeyEnc: bytea("signing_key_enc"),
  },
  (t) => [
    primaryKey({ name: "pk_api_keys", columns: [t.id] }),
    unique("uq_api_keys_secret_hash").on(t.secretHash),
    foreignKey({ name: "fk_api_keys_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete("restrict"),
    check("ck_api_keys_ck_api_keys_valid_mode", sql`mode IN ('test','live')`),
    check("ck_api_keys_ck_api_keys_valid_status", sql`status IN ('active','revoked')`),
    index("ix_api_keys_station_id").on(t.stationId),
  ],
);

export type Station = typeof stations.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type KeyMode = "test" | "live";
export const SETTLEMENT_SCHEDULES = ["T+1", "T+2", "T+3"] as const;
export const KYC_STATUSES = ["pending", "verified", "rejected"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];
export const liveEnabled = (s: Station): boolean => s.kycStatus === "verified";
