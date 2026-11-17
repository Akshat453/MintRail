/** Request-handling infrastructure: idempotency records and rate-limit (GCRA) state. */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, primaryKey, unique, varchar } from "drizzle-orm/pg-core";

import { jsonbExact } from "@mintrail/shared";

import { ts } from "./common.js";

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    method: varchar("method", { length: 8 }).notNull(),
    path: varchar("path", { length: 500 }).notNull(),
    requestDigest: varchar("request_digest", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonbExact<Record<string, unknown>>("response_body"),
    lockedAt: ts("locked_at").notNull().defaultNow(),
    createdAt: ts("created_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
  },
  (t) => [
    primaryKey({ name: "pk_idempotency_keys", columns: [t.id] }),
    unique("uq_idempotency_keys_scope").on(t.stationId, t.livemode, t.key),
    check("ck_idempotency_keys_valid_status", sql`status IN ('in_progress','completed')`),
  ],
);

export const rateLimitState = pgTable(
  "rate_limit_state",
  {
    bucket: varchar("bucket", { length: 120 }).notNull(),
    tat: ts("tat").notNull(),
  },
  (t) => [primaryKey({ name: "pk_rate_limit_state", columns: [t.bucket] })],
);
