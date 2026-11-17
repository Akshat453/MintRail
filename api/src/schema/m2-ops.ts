/**
 * M2 operational tables: per-Station money policies, merchant dashboard users
 * and sessions, Railyard Derailments (incident notes), and the inbox that
 * deduplicates Junction callbacks for refunds, disputes and payouts.
 */
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, primaryKey, unique, uniqueIndex, varchar } from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

import { ts } from "./common.js";
import { staffUsers } from "./staff.js";
import { stations } from "./station.js";

export const stationPolicies = pgTable(
  "station_policies",
  {
    stationId: varchar("station_id", { length: 40 }).notNull(),
    reserveBps: integer("reserve_bps").notNull(),
    reserveHoldDays: integer("reserve_hold_days").notNull(),
    payoutDailyLimit: bigint("payout_daily_limit", { mode: "bigint" }).notNull(),
    payoutApprovalThreshold: bigint("payout_approval_threshold", { mode: "bigint" }).notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_station_policies", columns: [t.stationId] }),
    foreignKey({ name: "fk_station_policies_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete(
      "cascade",
    ),
    check("ck_station_policies_reserve", sql`reserve_bps BETWEEN 0 AND 5000 AND reserve_hold_days BETWEEN 0 AND 180`),
    check("ck_station_policies_payout_limits", sql`payout_daily_limit > 0 AND payout_approval_threshold > 0`),
  ],
);

export const DASHBOARD_ROLES = ["owner", "admin", "developer", "viewer"] as const;
export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

export const dashboardUsers = pgTable(
  "dashboard_users",
  {
    id: varchar("id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    fullName: varchar("full_name", { length: 200 }).notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    passwordHash: varchar("password_hash", { length: 200 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    failedLogins: integer("failed_logins").notNull(),
    lockedUntil: ts("locked_until"),
    lastLoginAt: ts("last_login_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_dashboard_users", columns: [t.id] }),
    foreignKey({ name: "fk_dashboard_users_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete(
      "restrict",
    ),
    check("ck_dashboard_users_valid_role", sql`role IN ('owner','admin','developer','viewer')`),
    check("ck_dashboard_users_valid_status", sql`status IN ('active','disabled')`),
    uniqueIndex("uq_dashboard_users_email_lower").using("btree", sql`lower((email)::text)`),
    index("ix_dashboard_users_station_id").on(t.stationId),
  ],
);

export const dashboardSessions = pgTable(
  "dashboard_sessions",
  {
    id: varchar("id", { length: 40 }).notNull(),
    userId: varchar("user_id", { length: 40 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    ip: varchar("ip", { length: 64 }),
    userAgent: varchar("user_agent", { length: 300 }),
  },
  (t) => [
    primaryKey({ name: "pk_dashboard_sessions", columns: [t.id] }),
    unique("uq_dashboard_sessions_token_hash").on(t.tokenHash),
    foreignKey({
      name: "fk_dashboard_sessions_user_id_dashboard_users",
      columns: [t.userId],
      foreignColumns: [dashboardUsers.id],
    }).onDelete("restrict"),
    index("ix_dashboard_sessions_user_id").on(t.userId),
  ],
);

export const DERAILMENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export const DERAILMENT_STATUSES = ["investigating", "mitigated", "resolved"] as const;

export const derailments = pgTable(
  "derailments",
  {
    id: varchar("id", { length: 40 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    severity: varchar("severity", { length: 8 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    summary: varchar("summary", { length: 2000 }).notNull(),
    affected: jsonbExact<string[]>("affected")
      .notNull()
      .default(sql`'[]'::jsonb`),
    commanderId: varchar("commander_id", { length: 40 }).notNull(),
    startedAt: ts("started_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_derailments", columns: [t.id] }),
    foreignKey({ name: "fk_derailments_commander_id_staff_users", columns: [t.commanderId], foreignColumns: [staffUsers.id] }).onDelete(
      "restrict",
    ),
    check("ck_derailments_valid_severity", sql`severity IN ('sev1','sev2','sev3','sev4')`),
    check("ck_derailments_valid_status", sql`status IN ('investigating','mitigated','resolved')`),
  ],
);

export const derailmentNotes = pgTable(
  "derailment_notes",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    derailmentId: varchar("derailment_id", { length: 40 }).notNull(),
    staffId: varchar("staff_id", { length: 40 }).notNull(),
    body: varchar("body", { length: 4000 }).notNull(),
    statusChange: varchar("status_change", { length: 16 }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_derailment_notes", columns: [t.id] }),
    foreignKey({
      name: "fk_derailment_notes_derailment_id_derailments",
      columns: [t.derailmentId],
      foreignColumns: [derailments.id],
    }).onDelete("restrict"),
    foreignKey({ name: "fk_derailment_notes_staff_id_staff_users", columns: [t.staffId], foreignColumns: [staffUsers.id] }).onDelete(
      "restrict",
    ),
    index("ix_derailment_notes_derailment_id").on(t.derailmentId),
  ],
);

/** Junction callbacks for refunds/disputes/payouts, deduplicated by event id. */
export const junctionInbox = pgTable(
  "junction_inbox",
  {
    eventId: varchar("event_id", { length: 64 }).notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    outcome: varchar("outcome", { length: 16 }).notNull(),
    payload: jsonbExact<Record<string, unknown>>("payload").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "pk_junction_inbox", columns: [t.eventId] })],
);

export type StationPolicy = typeof stationPolicies.$inferSelect;
export type DashboardUser = typeof dashboardUsers.$inferSelect;
export type Derailment = typeof derailments.$inferSelect;
export type DerailmentNote = typeof derailmentNotes.$inferSelect;
