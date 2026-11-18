/**
 * M2 demo against the running stack (``make up``, after ``make seed``):
 *
 *   1. Railyard onboards a fresh test merchant (staff API) and issues a test key.
 *   2. The @mintrail/node SDK example runs: payment → partial refund → three webhooks,
 *      each verified with the endpoint's signing secret (Signal delivers to this host).
 *   3. Depot reconciles every settlement against the ledger (seeded data included).
 *
 * Env: MINTRAIL_DEMO_API_URL (default http://localhost:18000), MINTRAIL_DEPOT_PORT (18300).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getSettings, parseJson, stringifyJson } from "@mintrail/shared";

const settings = getSettings();
const apiUrl = process.env.MINTRAIL_DEMO_API_URL ?? "http://localhost:18000";
const depotUrl = `http://localhost:${process.env.MINTRAIL_DEPOT_PORT ?? "18300"}`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function http(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : stringifyJson(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? parseJson(text) : undefined;
}

console.log(bold("\n▸ Railyard: onboard a test merchant"));
const login = await http("POST", `${apiUrl}/internal/v1/auth/login`, {
  email: settings.bootstrap_admin_email,
  password: settings.bootstrap_admin_password,
});
const staff = { Authorization: `Bearer ${login.token}` };
const n = Date.now().toString(36);
const created = await http(
  "POST",
  `${apiUrl}/internal/v1/stations`,
  {
    legal_name: `Chai Sutta Stores ${n} Pvt Ltd`,
    display_name: `Chai Sutta ${n}`,
    email: `ops-${n}@chai-sutta.example`,
    business_category: "5814",
  },
  staff,
);
console.log(`  station ${created.station.id}  test key ${created.test_api_key.hint}`);

console.log(bold("\n▸ SDK example: payment → refund → verified webhooks"));
const sdk = spawnSync("pnpm", ["--filter", "@mintrail/node", "example"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
  env: { ...process.env, MINTRAIL_API_KEY: created.test_api_key.secret, MINTRAIL_API_URL: apiUrl },
});
if (sdk.status !== 0) {
  console.error("✗ SDK example failed");
  process.exit(1);
}

console.log(bold("\n▸ Depot: reconcile settlements against the ledger"));
const report = await http("POST", `${depotUrl}/internal/depot/v1/reconciliations`, undefined, {
  Authorization: `Bearer ${settings.depot_api_key}`,
});
console.log(
  `  ${report.status}: ${report.mismatch_count} mismatches · ${report.stations_checked} merchants · ${report.settlements_checked} settlements checked`,
);
if (report.mismatch_count !== 0n) {
  console.error(report.mismatches);
  process.exit(1);
}
const recent = await http("GET", `${apiUrl}/internal/v1/settlements?limit=3`, undefined, staff);
for (const s of recent.data)
  console.log(`  ${s.settlement_date}  ${s.id}  ${s.status}  net ${s.payout_currency} ${s.payout_amount}  utr ${s.utr ?? "—"}`);

console.log(bold("\n\x1b[32m✓ M2 demo passed: SDK payment + refund + webhook verification; reconciliation clean\x1b[0m"));
