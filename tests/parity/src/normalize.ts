/**
 * Make recorded output comparable across runs and implementations.
 *
 * Volatile tokens become numbered placeholders in order of first appearance
 * (so cross-references survive): `mer_01…` → `<mer:1>`. Tokens first seen in
 * the unordered DB snapshot are replaced generically (`<ltx:?>`) so row sort
 * order doesn't depend on randomness.
 */
const TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const ID =
  /\b(mer|key|ord|pay|stf|ses|blk|ltx|lac|req|evt|stl|pout|rfd|dsp|whk|whd|pbat|usr|dss|drl|file|rcn|fxr)_[0-9a-hjkmnp-tv-z]{26}\b/g;
const JN = /(?<![0-9])JN\d{12}(?![0-9])/g; // also inside jev_JN…_2 (no \b after "_")
const SECRET = /\bmr_(test|live)_[A-Za-z0-9]{40}\b/g;
const STAFF_TOKEN = /\brys_[A-Za-z0-9]{40}\b/g;
// M2: bank references, UTRs, webhook secrets, dashboard sessions, the harness's webhook receiver, business dates.
const BANK_REF = /(?<![0-9A-Z])(RFN|DSP|PYT)\d{12}(?![0-9])/g;
const UTR = /\b(JUNC|MRSTL)\d{6}\d{9,10}\b/g;
const WHSEC = /\bwhsec_[A-Za-z0-9]{32}\b/g;
const DASH_TOKEN = /\bdss_[A-Za-z0-9]{40}\b/g;
const RECEIVER = /\/\/[a-z0-9.-]+:\d+\/parity-hook/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Business dates depend on the day the harness runs (M2 settlements). */
const DATE_KEYS = new Set(["settlement_date", "release_on", "date"]);
const HINT = /(mr_(?:test|live)_…)[A-Za-z0-9]{4}/g;

// Harness-created staff ids are deterministic; keep them verbatim.
const STABLE_IDS = /^stf_0{25}\d$/;

export class Normalizer {
  private readonly seen = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  frozen = false;

  private token(kind: string, value: string): string {
    if (STABLE_IDS.test(value)) return value;
    const hit = this.seen.get(value);
    if (hit) return hit;
    if (this.frozen) return `<${kind}:?>`;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const placeholder = `<${kind}:${n}>`;
    this.seen.set(value, placeholder);
    return placeholder;
  }

  string(s: string): string {
    if (TS.test(s)) return "<ts>";
    return s
      .replace(WHSEC, (m) => this.token("whsec", m))
      .replace(DASH_TOKEN, (m) => this.token("dss_token", m))
      .replace(RECEIVER, "//<receiver>/parity-hook")
      .replace(BANK_REF, (m, kind: string) => this.token(kind, m))
      .replace(UTR, (_m, kind: string) => `<utr:${kind}>`)
      .replace(SECRET, (m, mode: string) => this.token(`mr_${mode}_secret`, m))
      .replace(STAFF_TOKEN, (m) => this.token("rys", m))
      .replace(HINT, "$1****")
      .replace(ID, (m, prefix: string) => this.token(prefix, m))
      .replace(JN, (m) => this.token("JN", m));
  }

  value(v: unknown): unknown {
    if (v instanceof Date) return "<ts>";
    if (typeof v === "string") return this.string(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v !== null && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        // Client IPs depend on the network path (Docker NAT vs localhost), not the implementation.
        out[key] =
          key === "ip" && typeof obj[key] === "string"
            ? "<ip>"
            : key === "secret_hint" && typeof obj[key] === "string"
              ? "<hint>"
              : DATE_KEYS.has(key) && typeof obj[key] === "string" && DATE.test(obj[key] as string)
                ? "<date>"
                : this.value(obj[key]);
      }
      // Payment-event ids are identity values; duplicate callbacks burn values (ON CONFLICT DO
      // NOTHING) at a point that depends on worker interleaving, so only their order is contractual.
      if ("applied" in obj && "source" in obj && typeof obj.id === "number") out.id = "<event-id>";
      // Validation messages come from the framework (Pydantic vs Zod); code + param must match.
      if (out.code === "MR_VALIDATION_FAILED" && typeof out.message === "string") {
        out.message = "<validation message>";
      }
      return out;
    }
    return v;
  }
}

export function sortRows(rows: unknown[]): unknown[] {
  return [...rows].sort((a, b) => {
    const x = JSON.stringify(a);
    const y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
