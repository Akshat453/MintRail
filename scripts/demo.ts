/**
 * M1 demo against the running stack (``make up migrate`` first):
 * 1. Railyard admin logs in and onboards a Station (KYC verified).
 * 2. The Station makes HMAC-signed API calls: create an order, pay by UPI.
 * 3. Junction authorizes asynchronously and calls back; Platform auto-captures.
 * 4. The Station's balance reflects the capture and the ledger balances.
 */
import { randomUUID } from "node:crypto";

import { signRequest } from "@mintrail/api";
import { loadSettings, Money, parseJson, stringifyJson, type Currency } from "@mintrail/shared";

const env = loadSettings();
const baseUrl = process.env.MINTRAIL_DEMO_API_URL ?? "http://localhost:18000";

// biome-ignore lint: demo JSON
type J = any;

async function http(
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: J }> {
  const r = await fetch(baseUrl + path, { method, body: opts.body, headers: opts.headers });
  const text = await r.text();
  return { status: r.status, body: text ? parseJson(text) : undefined };
}

function step(title: string): void {
  console.log(`\n\x1b[1m▸ ${title}\x1b[0m`);
}

function show(r: { status: number; body: J }, path: string, keys?: string[]): J {
  const picked = keys ? Object.fromEntries(keys.map((k) => [k, r.body?.[k]])) : r.body;
  console.log(`  ${path} → ${r.status}`);
  console.log(`  ${stringifyJson(picked, 2).replaceAll("\n", "\n  ")}`);
  if (r.status >= 400) {
    console.error(`demo failed at ${path}`);
    process.exit(1);
  }
  return r.body;
}

function signed(keyId: string, secret: string) {
  return (method: string, path: string, payload?: unknown, extra: Record<string, string> = {}) => {
    const body = payload === undefined ? "" : stringifyJson(payload);
    const headers: Record<string, string> = { ...signRequest(secret, keyId, { method, path, body }), ...extra };
    if (body) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["Idempotency-Key"] = randomUUID();
    return http(method, path, { body: body || undefined, headers });
  };
}

const email = env.bootstrap_admin_email;
const password = env.bootstrap_admin_password;
if (!email || !password) {
  console.error("Set MINTRAIL_BOOTSTRAP_ADMIN_EMAIL/PASSWORD (see .env.example).");
  process.exit(1);
}
console.log(`MintRail API at ${baseUrl}`);
const health = await fetch(`${baseUrl}/healthz`).catch(() => null);
if (!health?.headers.get("mintrail-version")) {
  console.error(`${baseUrl} is not a MintRail API; set MINTRAIL_DEMO_API_URL.`);
  process.exit(1);
}

step("Railyard admin logs in");
const login = show(
  await http("POST", "/internal/v1/auth/login", {
    body: JSON.stringify({ email, password }),
    headers: { "Content-Type": "application/json" },
  }),
  "POST /internal/v1/auth/login",
  ["expires_in", "permissions"],
);
const staff = { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" };

step("Onboard a new Station and verify KYC");
const n = randomUUID().slice(0, 6);
const created = show(
  await http("POST", "/internal/v1/stations", {
    headers: staff,
    body: JSON.stringify({
      legal_name: `Tiffin Express ${n} Pvt Ltd`,
      display_name: `Tiffin Express ${n}`,
      email: `ops-${n}@tiffin.example`,
      business_category: "5812",
    }),
  }),
  "POST /internal/v1/stations",
  ["station"],
);
const stationId: string = created.station.id;
const key = created.test_api_key;
console.log(`  station=${stationId} key_id=${key.id} secret=${key.hint} (shown once)`);
show(await http("POST", `/internal/v1/stations/${stationId}/kyc/verify`, { headers: staff }), "POST …/kyc/verify", [
  "id",
  "kyc_status",
  "live_enabled",
]);

const api = signed(key.id, key.secret);
step("Signed request: create an order for ₹1,499.00");
const order = show(await api("POST", "/v1/orders", { amount: 149_900n, currency: "INR", receipt: `demo-${n}` }), "POST /v1/orders", [
  "id",
  "amount",
  "status",
]);

step("Signed request: pay by UPI (Junction scenario: success)");
let pay = show(
  await api(
    "POST",
    "/v1/payments",
    { order_id: order.id, method: "upi", upi: { vpa: "asha.k@okmintrail" } },
    { "MintRail-Test-Scenario": "success" },
  ),
  "POST /v1/payments",
  ["id", "status", "risk"],
);

step("Wait for Junction's callback and auto-capture");
const deadline = Date.now() + 60_000;
let status: string = pay.status;
while (status !== "captured" && status !== "failed" && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  pay = (await api("GET", `/v1/payments/${pay.id}`)).body;
  if (pay.status !== status) {
    status = pay.status;
    console.log(`  status → ${status}`);
  }
}
if (status !== "captured") {
  console.error(`payment ended ${status}: ${pay.error_code}`);
  process.exit(1);
}
console.log(`  fee ${Money.of(pay.fee, "INR").format()} + GST ${Money.of(pay.tax, "INR").format()}`);

step("Station balance");
const bal = show(await api("GET", "/v1/balance"), "GET /v1/balance");
for (const b of bal.balances) console.log(`  ${b.currency}: ${Money.of(b.balance, b.currency as Currency).format()}`);

step("Ledger health (Railyard)");
const tb = show(await http("GET", "/internal/v1/ledger/trial_balance", { headers: staff }), "GET /internal/v1/ledger/trial_balance");
const rec = show(await http("GET", "/internal/v1/ledger/reconcile", { headers: staff }), "GET /internal/v1/ledger/reconcile");
if (!(tb.balanced && rec.ok)) {
  console.error("LEDGER DOES NOT BALANCE");
  process.exit(1);
}

step("Error envelope: tampered signature");
const bad = await http("GET", "/v1/station", {
  headers: { "MintRail-Key-Id": key.id, "MintRail-Signature": `t=${Math.floor(Date.now() / 1000)},v1=00` },
});
console.log(`  ${bad.status} ${bad.body.error.code}`);

console.log("\n\x1b[1;32m✓ M1 demo passed: signed request → UPI via Junction → ledger balances\x1b[0m");
