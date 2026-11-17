/** Disputes / chargebacks (M2, ADR-0015) and the evidence merchants upload for them. */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, primaryKey, unique, varchar } from "drizzle-orm/pg-core";

import { bytea } from "@mintrail/shared";

import { ts } from "./common.js";
import { payments } from "./payments.js";
import { stations } from "./station.js";

export const DISPUTE_STATUSES = ["needs_response", "under_review", "won", "lost"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const DISPUTE_REASONS = ["fraudulent", "product_not_received", "duplicate", "credit_not_processed", "general"] as const;

export const disputes = pgTable(
  "disputes",
  {
    id: varchar("id", { length: 40 }).notNull(),
    paymentId: varchar("payment_id", { length: 40 }).notNull(),
    stationId: varchar("station_id", { length: 40 }).notNull(),
    livemode: boolean("livemode").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    reason: varchar("reason", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    junctionRef: varchar("junction_ref", { length: 20 }).notNull(),
    evidenceDueBy: ts("evidence_due_by").notNull(),
    evidenceText: varchar("evidence_text", { length: 5000 }),
    evidenceSubmittedAt: ts("evidence_submitted_at"),
    outcomeReason: varchar("outcome_reason", { length: 200 }),
    closedAt: ts("closed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_disputes", columns: [t.id] }),
    foreignKey({ name: "fk_disputes_payment_id_payments", columns: [t.paymentId], foreignColumns: [payments.id] }).onDelete("restrict"),
    foreignKey({ name: "fk_disputes_station_id_stations", columns: [t.stationId], foreignColumns: [stations.id] }).onDelete("restrict"),
    unique("uq_disputes_junction_ref").on(t.junctionRef),
    check("ck_disputes_amount_positive", sql`amount > 0`),
    check("ck_disputes_valid_status", sql`status IN ('needs_response','under_review','won','lost')`),
    index("ix_disputes_station_mode_id").on(t.stationId, t.livemode, t.id),
    index("ix_disputes_payment_id").on(t.paymentId),
    index("ix_disputes_status_due").on(t.status, t.evidenceDueBy),
  ],
);

export const disputeEvidence = pgTable(
  "dispute_evidence",
  {
    id: varchar("id", { length: 40 }).notNull(),
    disputeId: varchar("dispute_id", { length: 40 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    filename: varchar("filename", { length: 200 }).notNull(),
    contentType: varchar("content_type", { length: 64 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    content: bytea("content").notNull(),
    uploadedBy: varchar("uploaded_by", { length: 64 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "pk_dispute_evidence", columns: [t.id] }),
    foreignKey({ name: "fk_dispute_evidence_dispute_id_disputes", columns: [t.disputeId], foreignColumns: [disputes.id] }).onDelete(
      "restrict",
    ),
    check("ck_dispute_evidence_valid_kind", sql`kind IN ('receipt','shipping_proof','customer_communication','refund_policy','other')`),
    check("ck_dispute_evidence_size", sql`size_bytes > 0`),
    index("ix_dispute_evidence_dispute_id").on(t.disputeId),
  ],
);

export type Dispute = typeof disputes.$inferSelect;
export type DisputeEvidence = typeof disputeEvidence.$inferSelect;
