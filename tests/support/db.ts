/** Per-file DB access for integration tests: pool, Drizzle handle, truncation, settings. */
import { inject } from "vitest";

import { type Db, loadSettings, makeDb, makePool, type Settings } from "@mintrail/shared";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export const TEST_PEPPER = "test-pepper-not-a-secret";

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
  // M2
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
];

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return loadSettings(
    {},
    {
      environment: "test",
      database_url: inject("databaseUrl"),
      api_key_pepper: TEST_PEPPER,
      junction_api_key: "test-junction-key",
      junction_callback_secret: "test-junction-callback-secret",
      junction_latency_scale: 0,
      signal_backoff_scale: 0,
      settlement_bank_delay_s: 0,
      log_json: true,
      log_level: "silent",
      ...overrides,
    },
    "/nonexistent",
  );
}

export function openDb(): { db: Db; close: () => Promise<void> } {
  const pool = makePool(inject("databaseUrl"), { max: 20 });
  return { db: makeDb(pool), close: () => pool.end() };
}

export async function truncateAll(db: Db): Promise<void> {
  await db.$client.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

/** Drizzle wraps driver errors ("Failed query: …"); the Postgres error is the cause. */
export async function pgError(p: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { cause?: { message: string; code?: string }; message: string; code?: string };
    return err.cause ?? err;
  }
  throw new Error("expected the database to reject the statement");
}
