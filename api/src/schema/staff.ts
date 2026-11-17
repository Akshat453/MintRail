/**
 * Railyard staff: users, sessions and the append-only audit log (UPDATE/DELETE
 * rejected by a trigger in the baseline migration). Separate from merchant auth.
 */
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, primaryKey, unique, uniqueIndex, varchar } from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

import { ts } from "./common.js";

export const STAFF_ROLES = ["ops", "finance", "security", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const staffUsers = pgTable(
  "staff_users",
  {
    id: varchar("id", { length: 40 }).notNull(),
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
    primaryKey({ name: "pk_staff_users", columns: [t.id] }),
    check("ck_staff_users_valid_role", sql`role IN ('ops','finance','security','admin')`),
    check("ck_staff_users_valid_status", sql`status IN ('active','disabled')`),
    uniqueIndex("uq_staff_users_email_lower").using("btree", sql`lower((email)::text)`),
  ],
);

export const staffSessions = pgTable(
  "staff_sessions",
  {
    id: varchar("id", { length: 40 }).notNull(),
    staffId: varchar("staff_id", { length: 40 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    ip: varchar("ip", { length: 64 }),
    userAgent: varchar("user_agent", { length: 300 }),
  },
  (t) => [
    primaryKey({ name: "pk_staff_sessions", columns: [t.id] }),
    unique("uq_staff_sessions_token_hash").on(t.tokenHash),
    foreignKey({ name: "fk_staff_sessions_staff_id_staff_users", columns: [t.staffId], foreignColumns: [staffUsers.id] }).onDelete(
      "restrict",
    ),
    index("ix_staff_sessions_staff_id").on(t.staffId),
  ],
);

export const staffAuditLog = pgTable(
  "staff_audit_log",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    staffId: varchar("staff_id", { length: 40 }),
    staffEmail: varchar("staff_email", { length: 320 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 40 }),
    targetId: varchar("target_id", { length: 64 }),
    details: jsonbExact<Record<string, unknown>>("details")
      .notNull()
      .default(sql`'{}'::jsonb`),
    requestId: varchar("request_id", { length: 64 }),
    ip: varchar("ip", { length: 64 }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_staff_audit_log", columns: [t.id] }),
    index("ix_staff_audit_log_target").on(t.targetType, t.targetId),
    index("ix_staff_audit_log_staff_id").on(t.staffId),
  ],
);

export type StaffUser = typeof staffUsers.$inferSelect;
export type StaffSession = typeof staffSessions.$inferSelect;
export type StaffAuditEntry = typeof staffAuditLog.$inferSelect;
