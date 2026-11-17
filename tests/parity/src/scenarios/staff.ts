import { STAFF_PASSWORD } from "../config.js";
import { type Role, staffEmail, staffId } from "../db.js";
import { scenario } from "../scenario.js";

const login = (email: string, password: string) => ({ json: { email, password } });

export default [
  scenario("staff/login-me-logout", async (c) => {
    const r = await c.rapi(
      "login (case-insensitive email)",
      "POST",
      "/internal/v1/auth/login",
      login("OPS@parity.mintrail.example", STAFF_PASSWORD),
    );
    const h = { Authorization: `Bearer ${(r.body as { token: string }).token}` };
    await c.rapi("me", "GET", "/internal/v1/auth/me", { headers: h });
    await c.rapi("logout", "POST", "/internal/v1/auth/logout", { headers: h });
    await c.rapi("me after logout", "GET", "/internal/v1/auth/me", { headers: h });
  }),
  scenario("staff/bad-password", async (c) => {
    await c.rapi("wrong password", "POST", "/internal/v1/auth/login", login(staffEmail("ops"), "wrong-password!!"));
  }),
  scenario("staff/unknown-email", async (c) => {
    await c.rapi("unknown email", "POST", "/internal/v1/auth/login", login("nobody@mintrail.example", "wrong-password!!"));
  }),
  scenario("staff/lockout", async (c) => {
    for (let i = 0; i < 5; i++) {
      await c.rapi(`failure ${i + 1}`, "POST", "/internal/v1/auth/login", login(staffEmail("finance"), "nope-nope-nope"));
    }
    await c.rapi("correct password while locked", "POST", "/internal/v1/auth/login", login(staffEmail("finance"), STAFF_PASSWORD));
  }),
  scenario("staff/login-validation", async (c) => {
    await c.rapi("not an email", "POST", "/internal/v1/auth/login", login("not-an-email", "x"));
    await c.rapi("missing password", "POST", "/internal/v1/auth/login", { json: { email: staffEmail("ops") } });
  }),
  scenario("staff/missing-token", async (c) => {
    await c.rapi("no token", "GET", "/internal/v1/stations");
    await c.rapi("garbage token", "GET", "/internal/v1/stations", { headers: { Authorization: "Bearer rys_nope" } });
    await c.rapi("wrong scheme", "GET", "/internal/v1/stations", { headers: { Authorization: "Basic abc" } });
  }),
  scenario("staff/merchant-key-cannot-reach-railyard", async (c) => {
    const m = await c.merchant();
    await c.rapi("merchant key on internal route", "GET", "/internal/v1/stations", {
      headers: { Authorization: `Bearer ${m.secret}` },
    });
  }),
  scenario("staff/create-and-disable", async (c) => {
    const r = await c.rstaff("create staff", "POST", "/internal/v1/staff", {
      email: "meera@mintrail.example",
      full_name: "Meera",
      role: "security",
      password: STAFF_PASSWORD,
    });
    const id = (r.body as { id: string }).id;
    const l = await c.rapi("new staff logs in", "POST", "/internal/v1/auth/login", login("meera@mintrail.example", STAFF_PASSWORD));
    const h = { Authorization: `Bearer ${(l.body as { token: string }).token}` };
    await c.rstaff("disable", "POST", `/internal/v1/staff/${id}/disable`);
    await c.rapi("session dies with account", "GET", "/internal/v1/auth/me", { headers: h });
    await c.rapi("disabled cannot log in", "POST", "/internal/v1/auth/login", login("meera@mintrail.example", STAFF_PASSWORD));
    await c.rstaff("list staff", "GET", "/internal/v1/staff");
  }),
  scenario("staff/create-validation-and-duplicates", async (c) => {
    await c.rstaff("weak password", "POST", "/internal/v1/staff", {
      email: "dev@contractor.example",
      full_name: "Dev",
      role: "ops",
      password: "short",
    });
    await c.rstaff("bad role", "POST", "/internal/v1/staff", {
      email: "dev@contractor.example",
      full_name: "Dev",
      role: "intern",
      password: STAFF_PASSWORD,
    });
    await c.rstaff("duplicate email", "POST", "/internal/v1/staff", {
      email: staffEmail("ops").toUpperCase(),
      full_name: "Dup",
      role: "ops",
      password: STAFF_PASSWORD,
    });
    await c.rstaff("disable unknown", "POST", "/internal/v1/staff/stf_zzzzzzzzzzzzzzzzzzzzzzzzzz/disable");
  }),
  ...(
    [
      ["finance", "GET", "/internal/v1/ledger/trial_balance"],
      ["ops", "GET", "/internal/v1/ledger/trial_balance"],
      ["security", "GET", "/internal/v1/audit_log"],
      ["ops", "GET", "/internal/v1/audit_log"],
      ["ops", "GET", "/internal/v1/staff"],
      ["admin", "GET", "/internal/v1/staff"],
      ["finance", "GET", "/internal/v1/risk/blocklist"],
      ["security", "GET", "/internal/v1/risk/blocklist"],
      ["finance", "GET", "/internal/v1/payments/review_queue"],
      ["ops", "GET", "/internal/v1/payments/review_queue"],
      ["security", "GET", "/internal/v1/ledger/reconcile"],
      ["finance", "POST", "/internal/v1/staff"],
    ] as [Role, string, string][]
  ).map(([role, method, path]) =>
    scenario(`staff/rbac/${role}-${method}-${path.replaceAll("/", "_")}`, async (c) => {
      await c.rstaff(`${role} ${method} ${path}`, method, path, method === "POST" ? {} : undefined, role);
    }),
  ),
  scenario("staff/rbac-station-actions", async (c) => {
    const m = await c.merchant();
    await c.rstaff("ops cannot suspend", "POST", `/internal/v1/stations/${m.stationId}/suspend`, { reason: "xxxxx" }, "ops");
    await c.rstaff("ops cannot issue keys", "POST", `/internal/v1/stations/${m.stationId}/api_keys`, {}, "ops");
    await c.rstaff("security cannot verify kyc", "POST", `/internal/v1/stations/${m.stationId}/kyc/verify`, undefined, "security");
    await c.rstaff(
      "finance can change settings",
      "PATCH",
      `/internal/v1/stations/${m.stationId}/settings`,
      { fee_plan: "growth" },
      "finance",
    );
    c.note("staff ids", { admin: staffId("admin") });
  }),
];
