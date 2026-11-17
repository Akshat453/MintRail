/** Request schemas for M2 endpoints (refunds, disputes, payouts, webhooks, settlements, dashboard, Railyard ops). */
import { z } from "zod";

import {
  DERAILMENT_SEVERITIES,
  DERAILMENT_STATUSES,
  DASHBOARD_ROLES,
  DISPUTE_REASONS,
  DISPUTE_STATUSES,
  PAYOUT_MODES,
  PAYOUT_STATUSES,
  REFUND_REASONS,
  REFUND_STATUSES,
} from "../schema/index.js";
import { emailStr, laxInt, optional, strictInt } from "../http/validation.js";
import { EVIDENCE_KINDS } from "../services/disputes.js";
import { PURPOSES } from "../services/payouts.js";
import { ListQuery, Literal } from "./schemas.js";

const positive = () => strictInt().refine((v) => v > 0n, "Input should be greater than 0");
const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

// ---------------------------------------------------------------- refunds
export const RefundCreateIn = z.strictObject({
  amount: optional(positive()),
  reason: Literal(REFUND_REASONS).default("requested_by_customer"),
  speed: Literal(["normal", "instant"] as const).default("normal"),
  notes: optional(z.record(z.string(), z.unknown())),
});
export const RefundListQuery = ListQuery.extend({ payment_id: optional(z.string()), status: optional(Literal(REFUND_STATUSES)) });

// ---------------------------------------------------------------- disputes
export const DisputeListQuery = ListQuery.extend({
  status: optional(Literal(DISPUTE_STATUSES)),
  payment_id: optional(z.string()),
  station_id: optional(z.string()),
});
export const EvidenceForm = z.object({
  kind: Literal(EVIDENCE_KINDS).default("other"),
  text: optional(z.string().max(5000)),
});
export const SimulateDisputeIn = z.strictObject({
  amount: optional(positive()),
  reason: Literal(DISPUTE_REASONS).default("general"),
  outcome: optional(Literal(["win", "lose"] as const)),
});

// ---------------------------------------------------------------- payouts
export const PayoutCreateIn = z.strictObject({
  amount: positive(),
  mode: Literal(PAYOUT_MODES),
  purpose: Literal(PURPOSES).default("payout"),
  beneficiary: z.strictObject({
    name: z.string().min(3).max(120),
    account_number: optional(z.string().max(20)),
    ifsc: optional(z.string().max(11)),
    vpa: optional(z.string().max(256)),
  }),
  reference: optional(z.string().max(40)),
  narration: optional(z.string().max(30)),
});
export const PayoutListQuery = ListQuery.extend({
  status: optional(Literal(PAYOUT_STATUSES)),
  batch_id: optional(z.string()),
  station_id: optional(z.string()),
});
export const RejectIn = z.strictObject({ reason: z.string().min(3).max(500) });

// ---------------------------------------------------------------- webhooks & events
export const WebhookEndpointIn = z.strictObject({
  url: z.string().min(8).max(500),
  description: optional(z.string().max(200)),
  enabled_events: optional(z.array(z.string()).max(20)),
});
export const WebhookEndpointPatch = z.strictObject({
  url: z.string().min(8).max(500).optional(),
  description: optional(z.string().max(200)),
  enabled_events: z.array(z.string()).max(20).optional(),
  status: Literal(["enabled", "disabled"] as const).optional(),
});
export const DeliveryListQuery = ListQuery.extend({
  endpoint_id: optional(z.string()),
  event_id: optional(z.string()),
  status: optional(Literal(["pending", "sending", "succeeded", "failed"] as const)),
  station_id: optional(z.string()),
});
export const EventListQuery = ListQuery.extend({ type: optional(z.string().max(64)) });

// ---------------------------------------------------------------- settlements & fx
export const SettlementListQuery = ListQuery.extend({
  from: optional(isoDate()),
  to: optional(isoDate()),
  status: optional(Literal(["processing", "processed", "failed"] as const)),
  station_id: optional(z.string()),
});
export const FxQuery = z.object({ base: Literal(["USD"] as const).default("USD"), quote: Literal(["INR"] as const).default("INR") });
export const SettlementRunIn = z.strictObject({ date: optional(isoDate()) });

// ---------------------------------------------------------------- dashboard
export const DashboardLoginIn = z.strictObject({ email: emailStr(), password: z.string().min(1).max(200) });
export const OverviewQuery = z.object({
  days: laxInt().pipe(z.number().min(1).max(90)).default(30),
  currency: Literal(["INR", "USD"] as const).default("INR"),
});
export const DashboardPaymentQuery = ListQuery.extend({
  status: optional(Literal(["created", "pending", "authorized", "captured", "failed"] as const)),
  method: optional(Literal(["card", "upi", "netbanking"] as const)),
  q: optional(z.string().max(100)),
  from: optional(isoDate()),
  to: optional(isoDate()),
});
export const ReportQuery = z.object({ from: isoDate(), to: isoDate() });
export const DashboardKeyIn = z.strictObject({
  mode: Literal(["test", "live"] as const).default("test"),
  label: optional(z.string().max(100)),
  scopes: optional(z.array(z.string())),
});

// ---------------------------------------------------------------- Railyard
export const PolicyIn = z.strictObject({
  reserve_bps: optional(laxInt().pipe(z.number().min(0).max(5000))),
  reserve_hold_days: optional(laxInt().pipe(z.number().min(0).max(180))),
  payout_daily_limit: optional(positive()),
  payout_approval_threshold: optional(positive()),
});
export const DashboardUserIn = z.strictObject({
  email: emailStr(),
  full_name: z.string().min(2).max(200),
  role: Literal(DASHBOARD_ROLES).default("owner"),
  password: z.string().min(12).max(200),
});
export const DerailmentIn = z.strictObject({
  title: z.string().min(5).max(200),
  severity: Literal(DERAILMENT_SEVERITIES),
  summary: z.string().min(5).max(2000),
  affected: z.array(z.string().max(64)).max(20).default([]),
});
export const DerailmentNoteIn = z.strictObject({ body: z.string().min(1).max(4000), status: optional(Literal(DERAILMENT_STATUSES)) });
export const DerailmentQuery = z.object({
  status: optional(Literal(DERAILMENT_STATUSES)),
  limit: laxInt().pipe(z.number().min(1).max(200)).default(50),
});
export const StationOverviewQuery = z.object({
  livemode: z.enum(["true", "false"]).default("true"),
  days: laxInt().pipe(z.number().min(1).max(90)).default(30),
});
