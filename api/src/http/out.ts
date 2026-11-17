/** Response shapes — field-for-field the M1 Pydantic models (docs/contract/openapi-m1.json). */
import { apiTime } from "@mintrail/shared";
import type { BlocklistEntry } from "@mintrail/conductor";

import type { ApiKey, Order, Payment, PaymentEvent, StaffAuditEntry, StaffUser, Station } from "../schema/index.js";
import { liveEnabled } from "../schema/index.js";
import type {
  DashboardUser,
  Derailment,
  DerailmentNote,
  Dispute,
  DisputeEvidence,
  FxRate,
  Payout,
  PayoutBatch,
  ReconciliationItem,
  ReconciliationReport,
  Refund,
  Settlement,
  SettlementEntry,
  StationPolicy,
} from "../schema/index.js";

export const list = <T>(data: T[], hasMore: boolean) => ({ object: "list", data, has_more: hasMore });

const settings = (s: Station) => ({
  settlement_schedule: s.settlementSchedule,
  fee_plan: s.feePlan,
  webhook_url: s.webhookUrl,
  auto_capture: s.autoCapture,
  max_payment_amount: s.maxPaymentAmount,
  rate_limit_per_sec: s.rateLimitPerSec,
  rate_limit_burst: s.rateLimitBurst,
});

export const stationOut = (s: Station) => ({
  object: "station",
  id: s.id,
  legal_name: s.legalName,
  display_name: s.displayName,
  email: s.email,
  business_category: s.businessCategory,
  country: s.country,
  default_currency: s.defaultCurrency,
  status: s.status,
  kyc_status: s.kycStatus,
  live_enabled: liveEnabled(s),
  settings: settings(s),
  created_at: apiTime(s.createdAt),
});

export const internalStationOut = (s: Station) => ({
  ...stationOut(s),
  suspended_reason: s.suspendedReason,
  kyc_rejection_reason: s.kycRejectionReason,
  kyc_reviewed_by: s.kycReviewedBy,
  kyc_reviewed_at: apiTime(s.kycReviewedAt),
});

export const apiKeyOut = (k: ApiKey) => ({
  object: "api_key",
  id: k.id,
  station_id: k.stationId,
  mode: k.mode,
  label: k.label,
  scopes: k.scopes,
  hint: k.hint,
  status: k.status,
  created_at: apiTime(k.createdAt),
  last_used_at: apiTime(k.lastUsedAt),
  revoked_at: apiTime(k.revokedAt),
});

export const orderOut = (o: Order) => ({
  object: "order",
  id: o.id,
  livemode: o.livemode,
  amount: o.amount,
  amount_paid: o.amountPaid,
  currency: o.currency,
  receipt: o.receipt,
  notes: o.notes,
  status: o.status,
  attempts: o.attempts,
  created_at: apiTime(o.createdAt),
});

export const paymentOut = (p: Payment) => ({
  object: "payment",
  id: p.id,
  order_id: p.orderId,
  livemode: p.livemode,
  amount: p.amount,
  currency: p.currency,
  method: p.method,
  status: p.status,
  capture_mode: p.captureMode,
  card:
    p.method === "card"
      ? { network: p.cardNetwork, last4: p.cardLast4, bin: p.cardBin, expiry_month: p.cardExpiryMonth, expiry_year: p.cardExpiryYear }
      : null,
  vpa: p.vpa,
  bank_code: p.bankCode,
  email: p.customerEmail,
  fee: p.fee,
  tax: p.tax,
  error_code: p.errorCode,
  error_description: p.errorDescription,
  risk: { decision: p.riskDecision, score: p.riskScore, reasons: p.riskReasons, review_status: p.riskReviewStatus },
  created_at: apiTime(p.createdAt),
  authorized_at: apiTime(p.authorizedAt),
  captured_at: apiTime(p.capturedAt),
  failed_at: apiTime(p.failedAt),
});

export const paymentEventOut = (e: PaymentEvent) => ({
  id: e.id,
  source: e.source,
  type: e.type,
  sequence: e.sequence,
  applied: e.applied,
  note: e.note,
  payload: e.payload,
  created_at: apiTime(e.createdAt),
});

export const internalPaymentOut = (p: Payment, events: PaymentEvent[]) => ({
  ...paymentOut(p),
  station_id: p.stationId,
  junction_ref: p.junctionRef,
  junction_sequence: p.junctionSequence,
  test_scenario: p.testScenario,
  events: events.map(paymentEventOut),
});

export const staffOut = (u: StaffUser) => ({
  object: "staff_user",
  id: u.id,
  email: u.email,
  full_name: u.fullName,
  role: u.role,
  status: u.status,
  last_login_at: apiTime(u.lastLoginAt),
  created_at: apiTime(u.createdAt),
});

export const auditOut = (a: StaffAuditEntry) => ({
  object: "audit_entry",
  id: a.id,
  staff_id: a.staffId,
  staff_email: a.staffEmail,
  action: a.action,
  target_type: a.targetType,
  target_id: a.targetId,
  details: a.details,
  request_id: a.requestId,
  ip: a.ip,
  created_at: apiTime(a.createdAt),
});

export const blocklistOut = (b: BlocklistEntry) => ({
  object: "blocklist_entry",
  id: b.id,
  kind: b.kind,
  value: b.value,
  reason: b.reason,
  active: b.active,
  created_by: b.createdBy,
  created_at: apiTime(b.createdAt),
});

// ================================================================ M2 shapes

export const refundOut = (r: Refund) => ({
  object: "refund",
  id: r.id,
  payment_id: r.paymentId,
  livemode: r.livemode,
  amount: r.amount,
  currency: r.currency,
  status: r.status,
  reason: r.reason,
  speed: r.speed,
  fee: r.fee,
  tax: r.tax,
  notes: r.notes,
  bank_reference: r.junctionRef,
  error_code: r.errorCode,
  error_description: r.errorDescription,
  created_at: apiTime(r.createdAt),
  processed_at: apiTime(r.processedAt),
  failed_at: apiTime(r.failedAt),
});

export const evidenceOut = (e: DisputeEvidence) => ({
  object: "dispute_evidence",
  id: e.id,
  kind: e.kind,
  filename: e.filename,
  content_type: e.contentType,
  size_bytes: e.sizeBytes,
  sha256: e.sha256,
  uploaded_by: e.uploadedBy,
  created_at: apiTime(e.createdAt),
});

export const disputeOut = (d: Dispute, evidence?: DisputeEvidence[]) => ({
  object: "dispute",
  id: d.id,
  payment_id: d.paymentId,
  livemode: d.livemode,
  amount: d.amount,
  currency: d.currency,
  reason: d.reason,
  status: d.status,
  evidence_due_by: apiTime(d.evidenceDueBy),
  evidence_text: d.evidenceText,
  evidence_submitted_at: apiTime(d.evidenceSubmittedAt),
  outcome_reason: d.outcomeReason,
  network_reference: d.junctionRef,
  closed_at: apiTime(d.closedAt),
  created_at: apiTime(d.createdAt),
  ...(evidence ? { evidence: evidence.map(evidenceOut) } : {}),
});

export const payoutOut = (p: Payout) => ({
  object: "payout",
  id: p.id,
  livemode: p.livemode,
  batch_id: p.batchId,
  amount: p.amount,
  currency: p.currency,
  mode: p.mode,
  purpose: p.purpose,
  beneficiary: {
    name: p.beneficiaryName,
    account_number: p.accountNumber ? `${"•".repeat(Math.max(0, p.accountNumber.length - 4))}${p.accountNumber.slice(-4)}` : null,
    ifsc: p.ifsc,
    vpa: p.vpa,
  },
  reference: p.reference,
  narration: p.narration,
  status: p.status,
  utr: p.utr,
  failure_reason: p.failureReason,
  approved_by: p.approvedBy,
  approved_at: apiTime(p.approvedAt),
  rejected_reason: p.rejectedReason,
  processed_at: apiTime(p.processedAt),
  failed_at: apiTime(p.failedAt),
  created_at: apiTime(p.createdAt),
});

export const payoutBatchOut = (b: PayoutBatch, items?: Payout[]) => ({
  object: "payout_batch",
  id: b.id,
  livemode: b.livemode,
  filename: b.filename,
  row_count: b.rowCount,
  accepted_count: b.acceptedCount,
  rejected_count: b.rejectedCount,
  total_amount: b.totalAmount,
  errors: b.errors,
  created_at: apiTime(b.createdAt),
  ...(items ? { payouts: items.map(payoutOut) } : {}),
});

export const settlementOut = (s: Settlement) => ({
  object: "settlement",
  id: s.id,
  livemode: s.livemode,
  currency: s.currency,
  settlement_date: s.settlementDate,
  schedule: s.schedule,
  cutoff_at: apiTime(s.cutoffAt),
  entry_count: s.entryCount,
  gross: s.gross,
  fees: s.fees,
  tax: s.tax,
  amount: s.amount,
  payout_currency: s.payoutCurrency,
  payout_amount: s.payoutAmount,
  fx_rate: s.fxRate,
  status: s.status,
  utr: s.utr,
  processed_at: apiTime(s.processedAt),
  created_at: apiTime(s.createdAt),
});

export const settlementEntryOut = (e: SettlementEntry) => ({
  kind: e.kind,
  reference_id: e.referenceId,
  occurred_at: apiTime(e.occurredAt),
  gross: e.gross,
  fee: e.fee,
  tax: e.tax,
  amount: e.amount,
  release_on: e.releaseOn,
});

export const fxRateOut = (f: FxRate) => ({
  object: "fx_rate",
  id: f.id,
  base: f.base,
  quote: f.quote,
  rate: f.rate,
  source: f.source,
  as_of: apiTime(f.asOf),
});

export const policyOut = (p: StationPolicy) => ({
  object: "station_policy",
  station_id: p.stationId,
  reserve_bps: p.reserveBps,
  reserve_hold_days: p.reserveHoldDays,
  payout_daily_limit: p.payoutDailyLimit,
  payout_approval_threshold: p.payoutApprovalThreshold,
});

export const dashboardUserOut = (u: DashboardUser) => ({
  object: "dashboard_user",
  id: u.id,
  station_id: u.stationId,
  email: u.email,
  full_name: u.fullName,
  role: u.role,
  status: u.status,
  last_login_at: apiTime(u.lastLoginAt),
});

export const derailmentOut = (d: Derailment, notes?: DerailmentNote[]) => ({
  object: "derailment",
  id: d.id,
  title: d.title,
  severity: d.severity,
  status: d.status,
  summary: d.summary,
  affected: d.affected,
  commander_id: d.commanderId,
  started_at: apiTime(d.startedAt),
  resolved_at: apiTime(d.resolvedAt),
  created_at: apiTime(d.createdAt),
  ...(notes
    ? {
        notes: notes.map((n) => ({
          id: n.id,
          staff_id: n.staffId,
          body: n.body,
          status_change: n.statusChange,
          created_at: apiTime(n.createdAt),
        })),
      }
    : {}),
});

export const reconciliationOut = (r: ReconciliationReport, items?: ReconciliationItem[]) => ({
  object: "reconciliation_report",
  id: r.id,
  run_at: apiTime(r.runAt),
  status: r.status,
  stations_checked: r.stationsChecked,
  settlements_checked: r.settlementsChecked,
  mismatch_count: r.mismatchCount,
  totals: r.totals,
  ...(items
    ? {
        mismatches: items.map((i) => ({
          station_id: i.stationId,
          livemode: i.livemode,
          currency: i.currency,
          check: i.check,
          reference_id: i.referenceId,
          expected: i.expected,
          actual: i.actual,
          detail: i.detail,
        })),
      }
    : {}),
});
