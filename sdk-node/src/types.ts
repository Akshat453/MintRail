/** Resource shapes returned by the MintRail API. Amounts are ``bigint`` minor units (paise / cents). */

export type Currency = "INR" | "USD";
export type Mode = "test" | "live";

export interface List<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

export interface ListParams {
  limit?: number;
  starting_after?: string;
}

export interface Station {
  object: "station";
  id: string;
  legal_name: string;
  display_name: string;
  email: string;
  business_category: string;
  default_currency: Currency;
  status: "active" | "suspended";
  kyc_status: "pending" | "verified" | "rejected";
  live_enabled: boolean;
  settings: Record<string, unknown>;
  created_at: string;
}

export interface Balance {
  object: "balance";
  livemode: boolean;
  balances: { currency: Currency; balance: bigint }[];
}

export interface Order {
  object: "order";
  id: string;
  livemode: boolean;
  amount: bigint;
  amount_paid: bigint;
  currency: Currency;
  receipt: string | null;
  notes: Record<string, string>;
  status: "created" | "attempted" | "paid";
  attempts: bigint;
  created_at: string;
}

export type PaymentStatus = "created" | "pending" | "authorized" | "captured" | "failed";

export interface Payment {
  object: "payment";
  id: string;
  order_id: string;
  livemode: boolean;
  amount: bigint;
  currency: Currency;
  method: "card" | "upi" | "netbanking";
  status: PaymentStatus;
  capture_mode: "automatic" | "manual";
  card: { network: string; last4: string; bin: string; expiry_month: bigint; expiry_year: bigint } | null;
  vpa: string | null;
  bank_code: string | null;
  email: string | null;
  fee: bigint | null;
  tax: bigint | null;
  error_code: string | null;
  error_description: string | null;
  risk: { decision: string; score: bigint; reasons: unknown[]; review_status: string };
  created_at: string;
  authorized_at: string | null;
  captured_at: string | null;
  failed_at: string | null;
}

export interface Refund {
  object: "refund";
  id: string;
  payment_id: string;
  livemode: boolean;
  amount: bigint;
  currency: Currency;
  status: "pending" | "processed" | "failed";
  reason: string;
  speed: "normal" | "instant";
  fee: bigint;
  tax: bigint;
  notes: Record<string, string>;
  bank_reference: string | null;
  error_code: string | null;
  error_description: string | null;
  created_at: string;
  processed_at: string | null;
  failed_at: string | null;
}

export interface DisputeEvidence {
  object: "dispute_evidence";
  id: string;
  kind: string;
  filename: string;
  content_type: string;
  size_bytes: bigint;
  sha256: string;
  created_at: string;
}

export interface Dispute {
  object: "dispute";
  id: string;
  payment_id: string;
  livemode: boolean;
  amount: bigint;
  currency: Currency;
  reason: string;
  status: "needs_response" | "under_review" | "won" | "lost";
  evidence_due_by: string;
  evidence_text: string | null;
  evidence_submitted_at: string | null;
  outcome_reason: string | null;
  network_reference: string;
  closed_at: string | null;
  created_at: string;
  evidence?: DisputeEvidence[];
}

export type PayoutMode = "IMPS" | "NEFT" | "RTGS" | "UPI";

export interface Payout {
  object: "payout";
  id: string;
  livemode: boolean;
  batch_id: string | null;
  amount: bigint;
  currency: "INR";
  mode: PayoutMode;
  purpose: string;
  beneficiary: { name: string; account_number: string | null; ifsc: string | null; vpa: string | null };
  reference: string | null;
  narration: string | null;
  status: "pending_approval" | "queued" | "processing" | "processed" | "failed" | "rejected" | "cancelled";
  utr: string | null;
  failure_reason: string | null;
  created_at: string;
  processed_at: string | null;
  failed_at: string | null;
}

export interface PayoutBatch {
  object: "payout_batch";
  id: string;
  filename: string;
  row_count: bigint;
  accepted_count: bigint;
  rejected_count: bigint;
  total_amount: bigint;
  errors: { row: bigint; code: string; message: string; param: string | null }[];
  payouts?: Payout[];
}

export interface Settlement {
  object: "settlement";
  id: string;
  livemode: boolean;
  currency: Currency;
  settlement_date: string;
  schedule: string;
  cutoff_at: string;
  entry_count: bigint;
  gross: bigint;
  fees: bigint;
  tax: bigint;
  amount: bigint;
  payout_currency: Currency;
  payout_amount: bigint;
  fx_rate: string | null;
  status: "processing" | "processed" | "failed";
  utr: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface SettlementEntry {
  kind: string;
  reference_id: string;
  occurred_at: string;
  gross: bigint;
  fee: bigint;
  tax: bigint;
  amount: bigint;
  release_on: string | null;
}

export type EventType =
  | "payment.authorized"
  | "payment.captured"
  | "payment.failed"
  | "refund.created"
  | "refund.processed"
  | "refund.failed"
  | "settlement.processed"
  | "dispute.created"
  | "dispute.closed"
  | "payout.processed"
  | "payout.failed";

export interface MintRailEvent<T = Record<string, unknown>> {
  object: "event";
  id: string;
  type: EventType;
  livemode: boolean;
  created_at: string;
  data: { object: T };
}

export interface WebhookEndpoint {
  object: "webhook_endpoint";
  id: string;
  livemode: boolean;
  url: string;
  description: string | null;
  enabled_events: string[];
  status: "enabled" | "disabled" | "deleted";
  secret_hint: string;
  secret_rotated_at: string | null;
  previous_secret_expires_at: string | null;
  created_at: string;
  /** Only on create and rotate. Store it; MintRail cannot show it again. */
  secret?: string;
}

export interface WebhookDelivery {
  object: "webhook_delivery";
  id: string;
  event_id: string;
  endpoint_id: string;
  event_type: string;
  status: "pending" | "sending" | "succeeded" | "failed";
  attempts: bigint;
  max_attempts: bigint;
  next_attempt_at: string | null;
  last_status_code: bigint | null;
  last_error: string | null;
  replay_of: string | null;
  completed_at: string | null;
  created_at: string;
  attempt_log?: { attempt: bigint; status_code: bigint | null; error: string | null; duration_ms: bigint; attempted_at: string }[];
}

export interface FxRate {
  object: "fx_rate";
  id: string;
  base: string;
  quote: string;
  rate: string;
  source: string;
  as_of: string;
}
