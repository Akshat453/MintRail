/**
 * Signal's tables (M2, ADR-0013):
 *
 *   outbox_events ──fan-out──▶ webhook_deliveries ──attempts──▶ webhook_delivery_attempts
 *                               (one per matching endpoint)
 *
 * Producers insert into ``outbox_events`` inside the same transaction as the
 * state change (transactional outbox). An AFTER INSERT trigger issues
 * ``NOTIFY mintrail_outbox`` so the worker wakes immediately; polling is the fallback.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";

import { bytea, jsonbExact } from "@mintrail/shared";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: varchar("id", { length: 40 }).notNull(),
    seq: bigint("seq", { mode: "bigint" }).notNull().generatedAlwaysAsIdentity(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    data: jsonbExact<Record<string, unknown>>("data").notNull(),
    dispatchedAt: ts("dispatched_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_outbox_events", columns: [t.id] }),
    index("ix_outbox_events_undispatched")
      .on(t.seq)
      .where(sql`dispatched_at IS NULL`),
    index("ix_outbox_events_station_mode_id").on(t.stationId, t.livemode, t.id),
  ],
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: varchar("id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    url: varchar("url", { length: 500 }).notNull(),
    description: varchar("description", { length: 200 }),
    enabledEvents: varchar("enabled_events", { length: 64 }).array().notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    secretEnc: bytea("secret_enc").notNull(),
    secretHint: varchar("secret_hint", { length: 16 }).notNull(),
    previousSecretEnc: bytea("previous_secret_enc"),
    previousSecretExpiresAt: ts("previous_secret_expires_at"),
    secretRotatedAt: ts("secret_rotated_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_webhook_endpoints", columns: [t.id] }),
    check("ck_webhook_endpoints_valid_status", sql`status IN ('enabled','disabled','deleted')`),
    index("ix_webhook_endpoints_station_mode").on(t.stationId, t.livemode),
  ],
);

export const DELIVERY_STATUSES = ["pending", "sending", "succeeded", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: varchar("id", { length: 40 }).notNull(),
    eventId: varchar("event_id", { length: 40 }).notNull(),
    endpointId: varchar("endpoint_id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    attempts: integer("attempts").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    nextAttemptAt: ts("next_attempt_at"),
    leaseUntil: ts("lease_until"),
    lastStatusCode: integer("last_status_code"),
    lastError: varchar("last_error", { length: 500 }),
    replayOf: varchar("replay_of", { length: 40 }),
    completedAt: ts("completed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_webhook_deliveries", columns: [t.id] }),
    foreignKey({ name: "fk_webhook_deliveries_event_id_outbox_events", columns: [t.eventId], foreignColumns: [outboxEvents.id] }).onDelete(
      "restrict",
    ),
    foreignKey({
      name: "fk_webhook_deliveries_endpoint_id_webhook_endpoints",
      columns: [t.endpointId],
      foreignColumns: [webhookEndpoints.id],
    }).onDelete("restrict"),
    check("ck_webhook_deliveries_valid_status", sql`status IN ('pending','sending','succeeded','failed')`),
    index("ix_webhook_deliveries_due")
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
    index("ix_webhook_deliveries_endpoint_id").on(t.endpointId, t.id),
    index("ix_webhook_deliveries_event_id").on(t.eventId),
    index("ix_webhook_deliveries_station").on(t.stationId, t.livemode, t.id),
  ],
);

export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    id: bigint("id", { mode: "bigint" }).notNull().generatedByDefaultAsIdentity(),
    deliveryId: varchar("delivery_id", { length: 40 }).notNull(),
    attempt: integer("attempt").notNull(),
    statusCode: integer("status_code"),
    error: varchar("error", { length: 500 }),
    durationMs: integer("duration_ms").notNull(),
    responseExcerpt: varchar("response_excerpt", { length: 500 }),
    attemptedAt: ts("attempted_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_webhook_delivery_attempts", columns: [t.id] }),
    foreignKey({
      name: "fk_webhook_delivery_attempts_delivery_id_webhook_deliveries",
      columns: [t.deliveryId],
      foreignColumns: [webhookDeliveries.id],
    }).onDelete("restrict"),
    index("ix_webhook_delivery_attempts_delivery_id").on(t.deliveryId),
  ],
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type WebhookDeliveryAttempt = typeof webhookDeliveryAttempts.$inferSelect;
