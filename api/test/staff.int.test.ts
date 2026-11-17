/** Ported from api/tests/test_staff_integration.py. */
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { ROLE_PERMISSIONS, PERMISSIONS, StaffService } from "../src/services/staff.js";
import type { StaffRole } from "../src/schema/index.js";
import { STAFF_PASSWORD } from "../src/testing.js";
import { pgError } from "../../tests/support/db.js";
import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();
const make = (email: string, role: StaffRole = "ops") =>
  db().transaction((tx) => new StaffService(tx, h().settings).createStaff({ email, fullName: "Riya", role, password: STAFF_PASSWORD }));
const login = (email: string, password: string) => h().request("POST", "/internal/v1/auth/login", { json: { email, password } });

describe("login", () => {
  test("login, me, logout", async () => {
    await make("riya@mintrail.example");
    const r = await login("RIYA@mintrail.example", STAFF_PASSWORD);
    expect(r.status, r.text).toBe(200);
    expect(r.body.token).toMatch(/^rys_/);
    expect(r.body.permissions).toContain("kyc:review");
    const hdr = { Authorization: `Bearer ${r.body.token}` };
    expect((await h().request("GET", "/internal/v1/auth/me", { headers: hdr })).body.staff.role).toBe("ops");
    expect((await h().request("POST", "/internal/v1/auth/logout", { headers: hdr })).status).toBe(204);
    expect((await h().request("GET", "/internal/v1/auth/me", { headers: hdr })).status).toBe(401);
  });

  test.each(["riya@mintrail.example", "nobody@mintrail.example"])("bad credentials are indistinguishable (%s)", async (email) => {
    await make("riya@mintrail.example");
    const r = await login(email, "wrong-password!!");
    expect([r.status, r.body.error.code]).toEqual([401, "MR_STAFF_LOGIN_FAILED"]);
  });

  test("lockout after repeated failures", async () => {
    await make("kabir@mintrail.example");
    for (let i = 0; i < h().settings.staff_max_failed_logins; i++) await login("kabir@mintrail.example", "nope-nope-nope");
    const r = await login("kabir@mintrail.example", STAFF_PASSWORD);
    expect([r.status, r.body.error.code]).toEqual([423, "MR_STAFF_ACCOUNT_LOCKED"]);
  });

  test("merchant key cannot reach Railyard", async () => {
    const m = await h().merchant();
    expect((await h().request("GET", "/internal/v1/stations", { headers: { Authorization: `Bearer ${m.secret}` } })).status).toBe(401);
  });

  test("missing token", async () => expect((await h().request("GET", "/internal/v1/stations")).status).toBe(401));
});

describe("roles", () => {
  test("permission matrix", () => {
    expect(ROLE_PERMISSIONS.admin).toEqual(new Set(PERMISSIONS));
    expect(ROLE_PERMISSIONS.finance.has("kyc:review")).toBe(false);
    expect(ROLE_PERMISSIONS.ops.has("ledger:read")).toBe(false);
    expect(ROLE_PERMISSIONS.security.has("staff:manage")).toBe(false);
  });

  test.each([
    ["finance", "GET", "/internal/v1/ledger/trial_balance", true],
    ["ops", "GET", "/internal/v1/ledger/trial_balance", false],
    ["security", "GET", "/internal/v1/audit_log", true],
    ["ops", "GET", "/internal/v1/audit_log", false],
    ["ops", "GET", "/internal/v1/staff", false],
    ["admin", "GET", "/internal/v1/staff", true],
    ["finance", "GET", "/internal/v1/risk/blocklist", false],
    ["security", "GET", "/internal/v1/risk/blocklist", true],
  ] as [StaffRole, string, string, boolean][])("%s %s %s → allowed=%s", async (role, method, path, allowed) => {
    const r = await h().staff(method, path, undefined, role);
    expect(r.status === 200, r.text).toBe(allowed);
    if (!allowed) expect(r.body.error.code).toBe("MR_PERMISSION_DENIED");
  });

  test("ops cannot suspend or issue keys", async () => {
    const m = await h().merchant();
    expect((await h().staff("POST", `/internal/v1/stations/${m.stationId}/suspend`, { reason: "xxxxx" }, "ops")).status).toBe(403);
    expect((await h().staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, {}, "ops")).status).toBe(403);
  });
});

describe("staff management", () => {
  test("admin creates and disables staff; sessions die with the account", async () => {
    const r = await h().staff("POST", "/internal/v1/staff", {
      email: "meera@mintrail.example",
      full_name: "Meera",
      role: "security",
      password: STAFF_PASSWORD,
    });
    expect(r.status, r.text).toBe(201);
    const token = (await login("meera@mintrail.example", STAFF_PASSWORD)).body.token;
    expect((await h().staff("POST", `/internal/v1/staff/${r.body.id}/disable`)).body.status).toBe("disabled");
    expect((await h().request("GET", "/internal/v1/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  test("weak password rejected", async () => {
    const r = await h().staff("POST", "/internal/v1/staff", {
      email: "dev@contractor.example",
      full_name: "Dev",
      role: "ops",
      password: "short",
    });
    expect([r.status, r.body.error.param]).toEqual([422, "password"]);
  });
});

describe("audit log", () => {
  test("actions are audited", async () => {
    const m = await h().merchant();
    await h().staff("POST", `/internal/v1/stations/${m.stationId}/suspend`, { reason: "chargeback spike" });
    const r = await h().staff("GET", `/internal/v1/audit_log?target_id=${m.stationId}`);
    expect(r.body.data.map((e: { action: string }) => e.action)).toEqual(["station.suspend", "station.create"]);
    const entry = r.body.data[0];
    expect(entry.details).toEqual({ reason: "chargeback spike" });
    expect(entry.request_id).toMatch(/^req_/);
    expect(entry.staff_email).toMatch(/^admin-/);
    expect(entry.ip).toBe("127.0.0.1");
  });

  test("failed logins are audited", async () => {
    await login("ghost@mintrail.example", "whatever-123");
    const failed = (await h().staff("GET", "/internal/v1/audit_log")).body.data.filter(
      (e: { action: string }) => e.action === "staff.login_failed",
    );
    expect(failed[0].staff_email).toBe("ghost@mintrail.example");
  });

  test("pagination", async () => {
    for (let i = 0; i < 3; i++) await h().merchant();
    const page = (await h().staff("GET", "/internal/v1/audit_log?limit=2")).body;
    expect(page.has_more).toBe(true);
    const last = page.data[1].id;
    const page2 = (await h().staff("GET", `/internal/v1/audit_log?limit=50&starting_after=${last}`)).body;
    expect(page2.data.every((e: { id: bigint }) => e.id < last)).toBe(true);
  });

  test("audit log is append-only", async () => {
    await h().merchant();
    expect((await pgError(db().execute(sql`UPDATE staff_audit_log SET action = 'tampered'`))).message).toMatch(/append-only/);
    expect((await pgError(db().execute(sql`DELETE FROM staff_audit_log`))).message).toMatch(/append-only/);
  });
});
