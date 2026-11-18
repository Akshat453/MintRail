/**
 * Process configuration from ``MINTRAIL_*`` environment variables (with ``.env``
 * as a fallback that never overrides the real environment). One settings
 * object serves every service; each reads what it needs.
 */
import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

export const DEV_SECRETS_KEY = "ZGV2LW9ubHktbm90LWEtc2VjcmV0LWtleS0zMmJ5dGU=";
const PLACEHOLDER_PREFIX = "change-me";

export const ENVIRONMENTS = ["dev", "test", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const int = (min: number) => z.coerce.number().int().min(min);
const float = (min: number, exclusive = false) => (exclusive ? z.coerce.number().gt(min) : z.coerce.number().min(min));

export const SettingsSchema = z
  .object({
    environment: z.enum(ENVIRONMENTS).default("dev"),
    database_url: z.string().default("postgres://mintrail:mintrail@localhost:5432/mintrail"),
    db_pool_size: int(1).max(100).default(10),
    db_statement_timeout_ms: int(100).default(15_000),

    api_key_pepper: z.string().default("change-me-api-key-pepper"),
    secrets_key: z.string().default(DEV_SECRETS_KEY),
    junction_api_key: z.string().default("change-me-junction-api-key"),
    junction_callback_secret: z.string().default("change-me-junction-callback-secret"),

    staff_session_ttl_s: int(60).default(8 * 3600),
    staff_max_failed_logins: int(1).default(5),
    staff_lockout_s: int(1).default(900),
    bootstrap_admin_email: z.string().optional(),
    bootstrap_admin_password: z.string().optional(),

    public_base_url: z.string().default("https://api.mintrail.example"),
    request_signature_tolerance_s: int(1).default(300),
    idempotency_lock_timeout_s: int(1).default(60),
    rate_limiting_enabled: bool.default(true),
    cors_allowed_origins: z.string().default(""),
    max_body_bytes: int(1024).default(1_048_576),

    junction_url: z.string().default("http://localhost:8100"),
    junction_timeout_s: float(0, true).default(5),
    payment_status_check_after_s: int(1).default(120),
    payment_timeout_s: int(1).default(900),
    authorization_expiry_s: int(60).default(5 * 24 * 3600),

    junction_callback_url: z.string().default("http://localhost:8000/internal/junction/v1/callbacks"),
    junction_seed: z.coerce.number().int().default(20221),
    junction_latency_scale: float(0).default(1),

    // ---- M2: refunds, disputes, payouts
    refund_instant_fee_bps: int(0).max(10_000).default(50),
    dispute_response_days: int(1).default(7),
    evidence_max_bytes: int(1024).default(5 * 1024 * 1024),
    evidence_max_files: int(1).default(5),
    payout_daily_limit: z.coerce.bigint().default(5_000_000_00n),
    payout_approval_threshold: z.coerce.bigint().default(2_00_000_00n),
    payout_csv_max_rows: int(1).default(1000),

    // ---- M2: Signal (webhooks)
    signal_url: z.string().default("http://localhost:8200"),
    signal_api_key: z.string().default("change-me-signal-api-key"),
    signal_max_attempts: int(1).max(50).default(10),
    signal_backoff_base_s: float(0).default(30),
    signal_backoff_cap_s: float(0).default(6 * 3600),
    signal_backoff_scale: float(0).default(1),
    signal_timeout_ms: int(100).default(10_000),
    signal_poll_interval_s: float(0, true).default(2),
    signal_secret_grace_s: int(0).default(24 * 3600),
    signal_concurrency: int(1).max(200).default(16),

    // ---- M2: Depot (settlements)
    depot_url: z.string().default("http://localhost:8300"),
    depot_api_key: z.string().default("change-me-depot-api-key"),
    settlement_cutoff_hour_ist: int(0).max(23).default(0),
    settlement_bank_delay_s: float(0).default(60),
    depot_tick_s: float(0, true).default(30),
    /** Off only for deterministic harness runs (parity), where settlements are triggered explicitly. */
    depot_scheduler_enabled: bool.default(true),

    /** How long a rotated API key keeps working so clients can deploy its replacement. */
    api_key_rotation_grace_s: int(0).default(24 * 3600),

    // ---- M2: dashboard sessions
    dashboard_session_ttl_s: int(60).default(12 * 3600),

    log_level: z.string().default("info"),
    log_json: bool.default(true),
    worker_poll_interval_s: float(0, true).default(1),
    worker_batch_size: int(1).max(500).default(10),
    worker_visibility_timeout_s: int(5).default(300),
  })
  .superRefine((s, ctx) => {
    if (s.environment !== "staging" && s.environment !== "production") return;
    for (const name of ["api_key_pepper", "junction_api_key", "junction_callback_secret", "signal_api_key", "depot_api_key"] as const) {
      if (s[name].startsWith(PLACEHOLDER_PREFIX)) {
        ctx.addIssue({ code: "custom", message: `MINTRAIL_${name.toUpperCase()} must be set in ${s.environment}` });
      }
    }
    if (s.secrets_key === DEV_SECRETS_KEY) {
      ctx.addIssue({ code: "custom", message: `MINTRAIL_SECRETS_KEY must be set in ${s.environment}` });
    }
  });

export type Settings = z.infer<typeof SettingsSchema>;

/** Parse a .env file (KEY=VALUE lines, # comments, optional quotes). */
export function readDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

export function loadSettings(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Settings> = {},
  dotenvPath = ".env",
): Settings {
  const merged: Record<string, string | undefined> = { ...readDotenv(dotenvPath), ...env };
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k.startsWith("MINTRAIL_") && v !== undefined) raw[k.slice("MINTRAIL_".length).toLowerCase()] = v;
  }
  return SettingsSchema.parse({ ...raw, ...overrides });
}

let cached: Settings | undefined;
export function getSettings(): Settings {
  cached ??= loadSettings();
  return cached;
}
