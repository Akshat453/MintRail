/** Ported from api/tests/test_stations_integration.py. */
import { describe, expect, test } from "vitest";

import { useHarness } from "../../tests/support/harness.js";

const { h } = useHarness();
const base = { legal_name: "Nilgiri Books LLP", display_name: "Nilgiri Books", email: "hello@nilgiri.example", business_category: "5942" };

describe("onboarding", () => {
  test("create station", async () => {
    const { station, test_api_key: key } = await h().createStation({ default_currency: "INR" });
    expect(station.id).toMatch(/^mer_/);
    expect([station.kyc_status, station.live_enabled]).toEqual(["pending", false]);
    expect(station.settings).toEqual({
      settlement_schedule: "T+2",
      fee_plan: "standard",
      webhook_url: null,
      auto_capture: true,
      max_payment_amount: null,
      rate_limit_per_sec: 25n,
      rate_limit_burst: 50n,
    });
    expect([key.mode, key.scopes]).toEqual(["test", ["*"]]);
    expect(key.secret).toMatch(/^mr_test_/);
  });

  test("create with settings", async () => {
    const d = await h().createStation({ settings: { fee_plan: "growth", settlement_schedule: "T+1", auto_capture: false } });
    expect([d.station.settings.fee_plan, d.station.settings.auto_capture]).toEqual(["growth", false]);
  });

  test("secret is never listed", async () => {
    const d = await h().createStation();
    const r = await h().staff("GET", `/internal/v1/stations/${d.station.id}/api_keys`);
    expect(r.text).not.toContain(d.test_api_key.secret);
    expect(r.body.data[0]).not.toHaveProperty("secret");
  });

  test("duplicate email is case-insensitive", async () => {
    await h().createStation({ email: "dup@nilgiri.example" });
    const r = await h().staff("POST", "/internal/v1/stations", { ...base, email: "DUP@nilgiri.example" });
    expect([r.status, r.body.error.code]).toEqual([409, "MR_STATION_ALREADY_EXISTS"]);
  });

  test.each([
    [{ email: "not-an-email" }, "email"],
    [{ business_category: "58" }, "business_category"],
    [{ default_currency: "XYZ" }, "default_currency"],
    [{ unexpected: 1 }, "unexpected"],
  ])("validation %j", async (patch, param) => {
    const r = await h().staff("POST", "/internal/v1/stations", { ...base, ...patch });
    expect([r.status, r.body.error.code, r.body.error.param]).toEqual([422, "MR_VALIDATION_FAILED", param]);
  });

  test("list, search, filter, paginate", async () => {
    const a = await h().createStation({ display_name: "Zara Cloud Kitchen" });
    await h().createStation();
    expect((await h().staff("GET", "/internal/v1/stations?q=zara")).body.data.map((s: { id: string }) => s.id)).toEqual([a.station.id]);
    expect((await h().staff("GET", "/internal/v1/stations?kyc_status=verified")).body.data).toEqual([]);
    const page = (await h().staff("GET", "/internal/v1/stations?limit=1")).body;
    expect(page.has_more).toBe(true);
    expect((await h().staff("GET", `/internal/v1/stations?limit=5&starting_after=${page.data[0].id}`)).body.has_more).toBe(false);
  });

  test("bad cursor and unknown station", async () => {
    expect((await h().staff("GET", "/internal/v1/stations?starting_after=pay_x")).status).toBe(400);
    expect((await h().staff("GET", "/internal/v1/stations/mer_00000000000000000000000000")).body.error.code).toBe("MR_STATION_NOT_FOUND");
  });
});

describe("KYC", () => {
  test("verify enables live keys", async () => {
    const m = await h().merchant();
    let r = await h().staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, { mode: "live" }, "security");
    expect([r.status, r.body.error.code]).toEqual([403, "MR_KYC_NOT_VERIFIED"]);
    r = await h().staff("POST", `/internal/v1/stations/${m.stationId}/kyc/verify`, undefined, "ops");
    expect(r.body.kyc_status).toBe("verified");
    expect(r.body.kyc_reviewed_by).toMatch(/^stf_/);
    r = await h().staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, { mode: "live" }, "security");
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^mr_live_/);
  });

  test("reject and reopen", async () => {
    const m = await h().merchant();
    const k = `/internal/v1/stations/${m.stationId}/kyc`;
    let r = await h().staff("POST", `${k}/reject`, { reason: "PAN mismatch" }, "ops");
    expect([r.body.kyc_status, r.body.kyc_rejection_reason]).toEqual(["rejected", "PAN mismatch"]);
    r = await h().staff("POST", `${k}/verify`, undefined, "ops");
    expect([r.status, r.body.error.code]).toEqual([409, "MR_INVALID_KYC_TRANSITION"]);
    expect((await h().staff("POST", `${k}/reopen`, undefined, "ops")).body.kyc_status).toBe("pending");
    expect((await h().staff("POST", `${k}/verify`, undefined, "ops")).status).toBe(200);
    expect((await h().staff("POST", `${k}/reopen`, undefined, "ops")).status).toBe(409);
  });
});

describe("settings", () => {
  test("staff settings are audited with before/after", async () => {
    const m = await h().merchant();
    const r = await h().staff(
      "PATCH",
      `/internal/v1/stations/${m.stationId}/settings`,
      { fee_plan: "enterprise", max_payment_amount: 5_000_000 },
      "finance",
    );
    expect(r.status, r.text).toBe(200);
    expect(r.body.settings.fee_plan).toBe("enterprise");
    const audit = (await h().staff("GET", `/internal/v1/audit_log?target_id=${m.stationId}`)).body.data[0];
    expect(audit.details.before).toEqual({ fee_plan: "standard", max_payment_amount: null });
  });

  test.each([{ fee_plan: "platinum" }, { settlement_schedule: "T+0" }, { rate_limit_burst: 0 }])(
    "invalid staff setting %j",
    async (patch) => {
      const m = await h().merchant();
      expect((await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/settings`, patch)).status).toBe(422);
    },
  );

  test("merchant settings", async () => {
    const m = await h().merchant();
    const r = await h().call(m, "PATCH", "/v1/station/settings", {
      webhook_url: "https://hooks.kaveri.example/mintrail",
      auto_capture: false,
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.settings.webhook_url).toBe("https://hooks.kaveri.example/mintrail");
  });

  test.each([{ webhook_url: "http://hooks.example/x" }, { webhook_url: "ftp://x" }, { fee_plan: "growth" }])(
    "merchant cannot set %j",
    async (patch) => {
      const m = await h().merchant();
      expect([400, 403, 422]).toContain((await h().call(m, "PATCH", "/v1/station/settings", patch)).status);
    },
  );

  test("suspension blocks the API", async () => {
    const m = await h().merchant();
    await h().staff("POST", `/internal/v1/stations/${m.stationId}/suspend`, { reason: "fraud review" }, "security");
    const r = await h().call(m, "GET", "/v1/station");
    expect([r.status, r.body.error.code]).toEqual([403, "MR_STATION_SUSPENDED"]);
    await h().staff("POST", `/internal/v1/stations/${m.stationId}/reactivate`, undefined, "security");
    expect((await h().call(m, "GET", "/v1/station")).status).toBe(200);
  });
});

describe("API keys", () => {
  test("scoped key", async () => {
    const m = await h().merchant();
    const r = await h().staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, { scopes: ["orders:read"], label: "reporting" });
    expect(r.body.scopes).toEqual(["orders:read"]);
    const ro = { stationId: m.stationId, keyId: r.body.id, secret: r.body.secret };
    expect((await h().call(ro, "GET", "/v1/orders")).status).toBe(200);
    const denied = await h().call(ro, "POST", "/v1/orders", { amount: 1000 });
    expect([denied.status, denied.body.error.code]).toEqual([403, "MR_INSUFFICIENT_SCOPE"]);
  });

  test("unknown scope", async () => {
    const m = await h().merchant();
    expect((await h().staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, { scopes: ["teleport:write"] })).status).toBe(400);
    // M2 made refunds:write a real scope (it was M1's example of an unknown one).
    expect((await h().staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, { scopes: ["refunds:write"] })).status).toBe(201);
  });

  test("rotate: a replacement is issued and the old key keeps working during the grace window", async () => {
    const m = await h().merchant();
    const r = await h().staff("POST", `/internal/v1/api_keys/${m.keyId}/rotate`, undefined, "security");
    expect([r.status, r.body.replaces, r.body.secret]).toEqual([201, m.keyId, expect.stringMatching(/^mr_test_/)]);
    expect(Date.parse(r.body.replaced_key_expires_at) - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    const fresh = { ...m, keyId: r.body.id, secret: r.body.secret };
    expect((await h().call(fresh, "GET", "/v1/station")).status).toBe(200);
    expect((await h().call(m, "GET", "/v1/station")).status).toBe(200);
    expect((await h().staff("POST", `/internal/v1/api_keys/${m.keyId}/rotate`, undefined, "security")).status).toBe(409);
    expect((await h().staff("POST", `/internal/v1/api_keys/${m.keyId}/rotate`, undefined, "ops")).status).toBe(403);
    const audit = (await h().staff("GET", "/internal/v1/audit_log?limit=5")).body.data.map((a: { action: string }) => a.action);
    expect(audit).toContain("api_key.rotate");
  });

  test("revoke", async () => {
    const m = await h().merchant();
    expect((await h().staff("POST", `/internal/v1/api_keys/${m.keyId}/revoke`)).body.status).toBe("revoked");
    expect((await h().call(m, "GET", "/v1/station")).body.error.code).toBe("MR_API_KEY_REVOKED");
  });

  test("key limit", async () => {
    const m = await h().merchant();
    for (let i = 0; i < 4; i++) expect((await h().staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, {})).status).toBe(201);
    expect((await h().staff("POST", `/internal/v1/stations/${m.stationId}/api_keys`, {})).status).toBe(409);
  });
});
