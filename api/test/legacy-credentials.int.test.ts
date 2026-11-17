/**
 * Credentials created under M1 (Python) keep working on Node: rows recorded
 * from the M1 implementation (tests/parity/fixtures/m1-legacy-rows.json) are
 * inserted verbatim, then used — bearer key, signed request with the M1
 * AES-GCM-encrypted signing key, and staff login with the M1 scrypt hash.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { useHarness } from "../../tests/support/harness.js";

// biome-ignore lint: fixture
const legacy = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../tests/parity/fixtures/m1-legacy-rows.json", import.meta.url)), "utf8"),
) as any;
const { h, db } = useHarness({ api_key_pepper: legacy.settings.api_key_pepper, secrets_key: legacy.settings.secrets_key });

const literal = (v: unknown): string => {
  if (v === null) return "NULL";
  if (typeof v === "object" && v && "$bytes" in v) return `'\\x${(v as { $bytes: string }).$bytes}'::bytea`;
  if (typeof v === "object" && v && "$ts" in v) return `'${(v as { $ts: string }).$ts}'::timestamptz`;
  if (Array.isArray(v)) return `ARRAY[${v.map((x) => `'${x}'`).join(",")}]::varchar[]`;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
};

async function insertLegacyRows(): Promise<void> {
  for (const table of ["staff_users", "stations", "api_keys", "ledger_accounts", "ledger_balances"]) {
    for (const row of legacy.rows[table]) {
      const cols = Object.keys(row);
      await db().$client.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => literal(row[c])).join(",")})`);
    }
  }
}

test("M1 test key (bearer), M1 live key (signed, M1-encrypted signing key) and M1 staff password all work", async () => {
  await insertLegacyRows();
  const s = legacy.secrets;
  const test_ = { stationId: s.station_id, keyId: s.test_key_id, secret: s.test_key };
  const live = { stationId: s.station_id, keyId: s.live_key_id, secret: s.live_key };

  const station = await h().call(test_, "GET", "/v1/station");
  expect(station.status, station.text).toBe(200);
  expect(station.body.id).toBe(s.station_id);

  const signedTest = await h().call(test_, "GET", "/v1/balance", undefined, { signed: true });
  expect(signedTest.status, signedTest.text).toBe(200);

  const signedLive = await h().call(live, "GET", "/v1/station", undefined, { signed: true });
  expect(signedLive.status, signedLive.text).toBe(200);
  expect(signedLive.body.live_enabled).toBe(true);
  // Scopes recorded under M1 are enforced.
  expect((await h().call(live, "GET", "/v1/balance", undefined, { signed: true })).body.error.code).toBe("MR_INSUFFICIENT_SCOPE");

  const login = await h().request("POST", "/internal/v1/auth/login", { json: { email: s.staff_email, password: s.staff_password } });
  expect(login.status, login.text).toBe(200);
  expect(login.body.staff.role).toBe("admin");
});
