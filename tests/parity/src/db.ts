/** Database control for the harness: reset, quiescence, side-effect snapshots. */
import pg from "pg";

import { cfg, STAFF_PASSWORD_HASH } from "./config.js";

export const pool = new pg.Pool({ connectionString: cfg.dbUrl, max: 4 });

export const TABLES = [
  "payment_events",
  "payments",
  "orders",
  "idempotency_keys",
  "rate_limit_state",
  "staff_sessions",
  "staff_audit_log",
  "staff_users",
  "conductor_blocklist",
  "junction_authorizations",
  "api_keys",
  "stations",
  "ledger_postings",
  "ledger_transactions",
  "ledger_balances",
  "ledger_accounts",
  "jobs",
] as const;

/** M2 tables (truncated on reset; snapshotted only by M2 scenarios). */
export const M2_TABLES = [
  "refunds",
  "dispute_evidence",
  "disputes",
  "payouts",
  "payout_batches",
  "settlement_entries",
  "settlements",
  "reconciliation_items",
  "reconciliation_reports",
  "fx_rates",
  "station_policies",
  "dashboard_sessions",
  "dashboard_users",
  "derailment_notes",
  "derailments",
  "junction_inbox",
  "junction_refunds",
  "junction_disputes",
  "junction_payouts",
  "webhook_delivery_attempts",
  "webhook_deliveries",
  "webhook_endpoints",
  "outbox_events",
] as const;

export const ROLES = ["ops", "finance", "security", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Deterministic staff ids/emails so goldens are stable across runs and implementations. */
export const staffId = (role: Role): string => `stf_${String(ROLES.indexOf(role) + 1).padStart(26, "0")}`;
export const staffEmail = (role: Role): string => `${role}@parity.mintrail.example`;

export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(text, params)).rows;
}

export async function reset(): Promise<void> {
  await quiesce();
  await sql(`TRUNCATE ${[...TABLES, ...M2_TABLES].join(", ")} RESTART IDENTITY CASCADE`);
  for (const role of ROLES) {
    await sql(
      `INSERT INTO staff_users (id, email, full_name, role, password_hash, status, failed_logins)
       VALUES ($1, $2, $3, $4, $5, 'active', 0)`,
      [staffId(role), staffEmail(role), `Parity ${role}`, role, STAFF_PASSWORD_HASH],
    );
  }
}

/** Wait until no job is running or due; must hold for two consecutive polls. */
export async function quiesce(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let calm = 0;
  while (Date.now() < deadline) {
    // Jobs, plus Signal's outbox fan-out and webhook deliveries (M2).
    const [row] = await sql<{ n: string }>(
      `SELECT (SELECT count(*) FROM jobs WHERE status = 'running' OR (status = 'queued' AND run_at <= now()))
            + (SELECT count(*) FROM outbox_events WHERE dispatched_at IS NULL)
            + (SELECT count(*) FROM webhook_deliveries WHERE status = 'sending' OR (status = 'pending' AND next_attempt_at <= now())) AS n`,
    );
    if (row && Number(row.n) === 0) {
      calm += 1;
      if (calm >= 3) return;
    } else {
      calm = 0;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("workers did not go idle");
}

/** Side effects of a scenario: everything in the tables M1 writes. */
export async function snapshot(): Promise<Record<string, unknown[]>> {
  const q = sql;
  return {
    stations: await q(`SELECT id, legal_name, display_name, email, business_category, country,
        default_currency, status, suspended_reason, kyc_status, kyc_rejection_reason,
        kyc_reviewed_by, kyc_reviewed_at IS NOT NULL AS kyc_reviewed, settlement_schedule,
        fee_plan, webhook_url, auto_capture, max_payment_amount, rate_limit_per_sec,
        rate_limit_burst FROM stations`),
    api_keys: await q(`SELECT id, station_id, mode, label, scopes, hint, status,
        signing_key_enc IS NOT NULL AS has_signing_key, last_used_at IS NOT NULL AS used,
        revoked_at IS NOT NULL AS revoked FROM api_keys`),
    staff_users: await q(`SELECT email, role, status, failed_logins,
        locked_until IS NOT NULL AS locked, last_login_at IS NOT NULL AS logged_in
        FROM staff_users`),
    staff_sessions: await q(`SELECT staff_id, revoked_at IS NOT NULL AS revoked,
        expires_at > now() AS live FROM staff_sessions`),
    staff_audit_log: await q(`SELECT staff_id, staff_email, action, target_type, target_id,
        details, request_id IS NOT NULL AS has_request_id, ip IS NOT NULL AS has_ip
        FROM staff_audit_log ORDER BY id`),
    orders: await q(`SELECT id, station_id, livemode, amount, currency, receipt, notes, status,
        amount_paid, attempts FROM orders`),
    payments: await q(`SELECT id, order_id, station_id, livemode, amount, currency, method,
        capture_mode, status, card_network, card_bin, card_last4, card_expiry_month,
        card_expiry_year, vpa, bank_code, customer_email, junction_ref, junction_sequence,
        test_scenario, error_code, error_description, risk_decision, risk_score, risk_reasons,
        risk_review_status, risk_reviewed_by, fee, tax, authorized_at IS NOT NULL AS authorized,
        captured_at IS NOT NULL AS captured, failed_at IS NOT NULL AS failed FROM payments`),
    payment_events: await q(`SELECT payment_id, source, type, junction_event_id, sequence,
        applied, note, payload FROM payment_events ORDER BY payment_id, id`),
    idempotency_keys: await q(`SELECT station_id, livemode, key, method, path, status,
        response_status, response_body FROM idempotency_keys`),
    rate_limit_state: await q(`SELECT bucket FROM rate_limit_state`),
    conductor_blocklist: await q(`SELECT id, kind, value, reason, active, created_by,
        deactivated_at IS NOT NULL AS deactivated FROM conductor_blocklist`),
    junction_authorizations: await q(`SELECT ref, payment_id, merchant_ref, amount, currency,
        method, instrument, livemode, scenario, status, decline_code, plan, sequence,
        requests_seen FROM junction_authorizations`),
    jobs: await q(`SELECT queue, kind, payload, status, attempts, max_attempts, dedupe_key,
        last_error IS NOT NULL AS errored FROM jobs`),
    ledger_accounts: await q(`SELECT a.code, a.name, a.type, a.currency, a.owner_id, a.livemode,
        a.allow_negative, a.status, b.debits_total, b.credits_total, b.version
        FROM ledger_accounts a JOIN ledger_balances b ON b.account_id = a.id`),
    ledger_transactions: await q(`SELECT t.idempotency_key, t.description, t.reference_type,
        t.reference_id, t.reverses_id IS NOT NULL AS is_reversal, t.livemode, t.metadata,
        (SELECT json_agg(json_build_object('account', a.code, 'direction', p.direction,
                 'amount', p.amount::text, 'currency', p.currency) ORDER BY a.code, p.direction)
           FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id
          WHERE p.transaction_id = t.id) AS postings
        FROM ledger_transactions t`),
  };
}

/** M2 side effects (stable columns only; volatile ones become booleans). */
export async function snapshotM2(): Promise<Record<string, unknown[]>> {
  const q = sql;
  return {
    refunds: await q(`SELECT id, payment_id, station_id, livemode, amount, currency, status, reason, speed, fee, tax, notes,
        junction_ref, test_scenario, error_code, error_description, processed_at IS NOT NULL AS processed,
        failed_at IS NOT NULL AS failed FROM refunds`),
    disputes: await q(`SELECT id, payment_id, station_id, livemode, amount, currency, reason, status, junction_ref,
        evidence_text, outcome_reason, evidence_submitted_at IS NOT NULL AS submitted, closed_at IS NOT NULL AS closed
        FROM disputes`),
    dispute_evidence: await q(`SELECT dispute_id, kind, filename, content_type, size_bytes, sha256, uploaded_by FROM dispute_evidence`),
    payouts: await q(`SELECT id, station_id, livemode, batch_id, amount, currency, mode, purpose, beneficiary_name,
        account_number, ifsc, vpa, reference, narration, status, junction_ref, utr IS NOT NULL AS has_utr, test_scenario,
        failure_reason, approved_by, rejected_reason FROM payouts`),
    payout_batches: await q(`SELECT id, station_id, filename, row_count, accepted_count, rejected_count, total_amount,
        errors, created_by FROM payout_batches`),
    settlements: await q(`SELECT id, station_id, livemode, currency, schedule, entry_count, gross, fees, tax, amount,
        payout_currency, payout_amount, fx_rate, status, utr IS NOT NULL AS has_utr FROM settlements`),
    settlement_entries: await q(`SELECT settlement_id, kind, reference_id, gross, fee, tax, amount,
        release_on IS NOT NULL AS has_release FROM settlement_entries`),
    station_policies: await q(`SELECT station_id, reserve_bps, reserve_hold_days, payout_daily_limit,
        payout_approval_threshold FROM station_policies`),
    outbox_events: await q(`SELECT id, station_id, livemode, type, data, dispatched_at IS NOT NULL AS dispatched FROM outbox_events`),
    webhook_endpoints: await q(`SELECT id, station_id, livemode, url, description, enabled_events, status,
        previous_secret_enc IS NOT NULL AS rotated FROM webhook_endpoints`),
    webhook_deliveries: await q(`SELECT event_id, endpoint_id, event_type, status, attempts, max_attempts,
        last_status_code, replay_of IS NOT NULL AS is_replay FROM webhook_deliveries`),
    junction_refunds: await q(
      `SELECT ref, refund_id, auth_ref, amount, currency, speed, scenario, status, failure_reason FROM junction_refunds`,
    ),
    junction_disputes: await q(
      `SELECT ref, auth_ref, payment_id, amount, currency, reason, scenario, status, evidence_count FROM junction_disputes`,
    ),
    junction_payouts: await q(`SELECT ref, payout_id, amount, mode, destination, scenario, status, utr IS NOT NULL AS has_utr,
        failure_reason FROM junction_payouts`),
    junction_inbox: await q(`SELECT event_id, type, outcome FROM junction_inbox`),
    dashboard_users: await q(
      `SELECT station_id, email, role, status, failed_logins, last_login_at IS NOT NULL AS logged_in FROM dashboard_users`,
    ),
    derailments: await q(
      `SELECT id, title, severity, status, summary, affected, commander_id, resolved_at IS NOT NULL AS resolved FROM derailments`,
    ),
    derailment_notes: await q(`SELECT derailment_id, staff_id, body, status_change FROM derailment_notes ORDER BY id`),
    reconciliation_reports: await q(`SELECT status, stations_checked, settlements_checked, mismatch_count FROM reconciliation_reports`),
  };
}
