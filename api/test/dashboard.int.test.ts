/** Merchant dashboard API + Railyard M2 ops: sessions, roles, overview, filters, keys, reports, derailments. */
import { describe, expect, test } from "vitest";

import { useHarness } from "../../tests/support/harness.js";

const { h } = useHarness();

describe("dashboard sessions", () => {
  test("login → me → logout; bad passwords lock the account; live needs KYC", async () => {
    const m = await h().merchant();
    const headers = await h().dashboardLogin(m.stationId);
    const me = await h().dash(headers, "GET", "/dashboard/v1/me");
    expect([me.status, me.body.station.id, me.body.livemode, me.body.permissions]).toEqual([
      200,
      m.stationId,
      false,
      expect.arrayContaining(["refunds", "payouts"]),
    ]);
    expect((await h().dash({ ...headers, "MintRail-Mode": "live" }, "GET", "/dashboard/v1/me")).body.error.code).toBe(
      "MR_KYC_NOT_VERIFIED",
    );
    expect((await h().dash(headers, "POST", "/dashboard/v1/auth/logout")).status).toBe(204);
    expect((await h().dash(headers, "GET", "/dashboard/v1/me")).status).toBe(401);
    const email = me.body.user.email as string;
    for (let i = 0; i < 5; i++)
      expect(
        (await h().request("POST", "/dashboard/v1/auth/login", { json: { email, password: "wrong-password-123" } })).body.error.code,
      ).toBe("MR_DASHBOARD_LOGIN_FAILED");
    expect(
      (await h().request("POST", "/dashboard/v1/auth/login", { json: { email, password: "correct-horse-battery-staple" } })).body.error
        .code,
    ).toBe("MR_STAFF_ACCOUNT_LOCKED");
    expect(
      (await h().request("POST", "/dashboard/v1/auth/login", { json: { email: "nobody@x.example", password: "whatever-123456" } })).status,
    ).toBe(401);
    expect((await h().dash({ Authorization: "Bearer mr_test_abc" }, "GET", "/dashboard/v1/me")).status).toBe(401);
  });

  test("self-serve sign-up creates a test-mode station and owner, signs in, and rejects duplicates", async () => {
    const email = `signup-${Date.now()}@new-merchant.example`;
    const json = { business_name: "Asha's Bakery", full_name: "Asha Verma", email, password: "correct-horse-battery-staple" };
    const r = await h().request("POST", "/dashboard/v1/auth/signup", { json });
    expect([r.status, r.body.user.role, r.body.station.live_enabled, r.body.station.display_name]).toEqual([
      201,
      "owner",
      false,
      "Asha's Bakery",
    ]);
    const me = await h().dash({ Authorization: `Bearer ${r.body.token}` }, "GET", "/dashboard/v1/me");
    expect([me.status, me.body.user.email, me.body.livemode]).toEqual([200, email, false]);
    const dup = await h().request("POST", "/dashboard/v1/auth/signup", { json: { ...json, email: email.toUpperCase() } });
    expect(dup.status).toBe(409);
    const weak = await h().request("POST", "/dashboard/v1/auth/signup", { json: { ...json, email: `x${email}`, password: "short" } });
    expect(weak.status).toBe(422);
    const login = await h().request("POST", "/dashboard/v1/auth/login", { json: { email, password: json.password } });
    expect(login.status).toBe(200);
  });

  test("roles: viewers read but cannot refund; developers manage keys and webhooks", async () => {
    const m = await h().merchant();
    const p = await h().paid(m);
    const viewer = await h().dashboardLogin(m.stationId, "viewer");
    expect((await h().dash(viewer, "GET", "/dashboard/v1/payments")).status).toBe(200);
    const no = await h().dash(viewer, "POST", `/dashboard/v1/payments/${p.id}/refunds`, { amount: 100n });
    expect([no.status, no.body.error.code]).toEqual([403, "MR_PERMISSION_DENIED"]);
    const dev = await h().dashboardLogin(m.stationId, "developer");
    const key = await h().dash(dev, "POST", "/dashboard/v1/api_keys", { label: "CI key" });
    expect([key.status, key.body.secret]).toEqual([201, expect.stringMatching(/^mr_test_/)]);
    const rotated = await h().dash(dev, "POST", `/dashboard/v1/api_keys/${key.body.id}/rotate`);
    expect([rotated.status, rotated.body.replaces]).toEqual([201, key.body.id]);
    expect((await h().dash(dev, "POST", `/dashboard/v1/api_keys/${key.body.id}/revoke`)).body.status).toBe("revoked");
    expect((await h().dash(dev, "GET", "/dashboard/v1/reports/payments?from=2026-01-01&to=2026-12-31")).status).toBe(403);
  });
});

describe("dashboard data", () => {
  test("overview, filtered payments, payment detail with refunds and events, refund with idempotency, CSV reports", async () => {
    const m = await h().merchant();
    const card = await h().paid(m, "card", { amount: 120_000n });
    await h().paid(m, "upi", { amount: 80_000n });
    const o = await h().order(m);
    await h().pay(m, o.id, "card", { scenario: "decline:insufficient_funds" });
    await h().drainAll();
    const owner = await h().dashboardLogin(m.stationId);
    const ov = (await h().dash(owner, "GET", "/dashboard/v1/overview?days=7")).body;
    expect(ov.totals).toMatchObject({ volume: 200_000n, payments: 2n, failed: 1n, success_rate_bps: 6666n });
    expect(ov.series).toHaveLength(7);
    expect(ov.method_mix.map((x: { method: string }) => x.method)).toEqual(["card", "upi"]);
    expect(ov.balances.INR.merchant_balance).toBeGreaterThan(0n);

    const failed = (await h().dash(owner, "GET", "/dashboard/v1/payments?status=failed")).body.data;
    expect(failed.map((p: { error_code: string }) => p.error_code)).toEqual(["insufficient_funds"]);
    expect((await h().dash(owner, "GET", "/dashboard/v1/payments?method=upi")).body.data).toHaveLength(1);
    const pg1 = (await h().dash(owner, "GET", "/dashboard/v1/payments?limit=2")).body;
    const pg2 = (await h().dash(owner, "GET", `/dashboard/v1/payments?limit=2&starting_after=${pg1.data.at(-1).id}`)).body;
    expect([pg1.data.length, pg1.has_more, pg2.data.length, pg2.has_more]).toEqual([2, true, 1, false]);
    const ids = [...pg1.data, ...pg2.data].map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(3);
    expect((await h().dash(owner, "GET", "/dashboard/v1/payments?starting_after=nope")).status).toBe(400);
    expect(pg1.data.find((p: { id: string }) => p.id === card.id)?.amount_refunded ?? 0n).toBe(0n);
    expect((await h().dash(owner, "GET", `/dashboard/v1/payments?q=${card.id}`)).body.data.map((p: { id: string }) => p.id)).toEqual([
      card.id,
    ]);

    const key = { "Idempotency-Key": "dash-refund-1" };
    const r1 = await h().dash(
      owner,
      "POST",
      `/dashboard/v1/payments/${card.id}/refunds`,
      { amount: 20_000n, reason: "order_cancelled" },
      key,
    );
    const r2 = await h().dash(
      owner,
      "POST",
      `/dashboard/v1/payments/${card.id}/refunds`,
      { amount: 20_000n, reason: "order_cancelled" },
      key,
    );
    expect([r1.status, r2.body.id, r2.headers["idempotent-replayed"]]).toEqual([201, r1.body.id, "true"]);
    await h().drainAll();
    const detail = (await h().dash(owner, "GET", `/dashboard/v1/payments/${card.id}`)).body;
    expect(detail.refunds.map((r: { status: string }) => r.status)).toEqual(["processed"]);
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["payment.captured", "refund.created", "refund.processed"]),
    );

    const today = new Date().toISOString().slice(0, 10);
    const csv = await h().dash(owner, "GET", `/dashboard/v1/reports/payments.csv?from=2020-01-01&to=${today.slice(0, 4)}-12-31`);
    expect([csv.status, csv.headers["content-disposition"]]).toEqual([200, expect.stringContaining("payments-test-")]);
    expect(csv.text.split("\r\n").filter(Boolean)).toHaveLength(4);
    expect(csv.text).toContain("1200.00");
    expect((await h().dash(owner, "GET", "/dashboard/v1/reports/refunds?from=2020-01-01&to=2099-12-31")).text).toContain("order_cancelled");
    expect((await h().dash(owner, "GET", "/dashboard/v1/reports/nope?from=2020-01-01&to=2099-12-31")).status).toBe(404);
    expect((await h().dash(owner, "GET", "/dashboard/v1/reports/payouts?from=2021-01-01&to=2020-01-01")).status).toBe(400);

    // A payment arriving between page loads must not push page-1 rows onto page 2.
    await h().paid(m, "upi", { amount: 10_000n });
    const pg2Again = (await h().dash(owner, "GET", `/dashboard/v1/payments?limit=2&starting_after=${pg1.data.at(-1).id}`)).body;
    expect(pg2Again.data.map((p: { id: string }) => p.id)).toEqual(pg2.data.map((p: { id: string }) => p.id));
  });

  test("report export rate limit is per merchant (MR-10)", async () => {
    const a = await h().merchant();
    const b = await h().merchant();
    const ownerA = await h().dashboardLogin(a.stationId);
    const ownerB = await h().dashboardLogin(b.stationId);
    const url = "/dashboard/v1/reports/payments?from=2026-01-01&to=2026-01-01";
    let status = 200;
    for (let i = 0; i < 30 && status !== 429; i++) status = (await h().dash(ownerA, "GET", url)).status;
    expect(status).toBe(429);
    expect((await h().dash(ownerB, "GET", url)).status).toBe(200);
  });

  test("webhooks via the dashboard share the /v1 handlers", async () => {
    const m = await h().merchant();
    const owner = await h().dashboardLogin(m.stationId);
    const ep = await h().dash(owner, "POST", "/dashboard/v1/webhook_endpoints", { url: "https://hooks.kaveri.example/mintrail" });
    expect(ep.status).toBe(201);
    expect((await h().call(m, "GET", "/v1/webhook_endpoints")).body.data.map((e: { id: string }) => e.id)).toEqual([ep.body.id]);
  });
});

describe("railyard M2", () => {
  test("merchant lookup: overview, payments, policy, dashboard users; permissions enforced", async () => {
    const m = await h().merchant();
    await h().paid(m);
    const ov = await h().staff("GET", `/internal/v1/stations/${m.stationId}/overview?livemode=false&days=3`, undefined, "ops");
    expect(ov.body.totals.payments).toBe(1n);
    expect((await h().staff("GET", `/internal/v1/stations/${m.stationId}/payments`, undefined, "ops")).body.data).toHaveLength(1);
    expect((await h().staff("GET", `/internal/v1/stations/${m.stationId}/policy`, undefined, "security")).body.reserve_bps).toBe(0n);
    expect((await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/policy`, { reserve_bps: 9000 }, "admin")).status).toBe(422);
    expect((await h().staff("PATCH", `/internal/v1/stations/${m.stationId}/policy`, { reserve_bps: 500 }, "security")).status).toBe(403);
    await h().dashboardLogin(m.stationId);
    expect((await h().staff("GET", `/internal/v1/stations/${m.stationId}/dashboard_users`, undefined, "ops")).body.data).toHaveLength(1);
  });

  test("dispute handling, webhook replay, settlement run request, reconciliation, derailments", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card");
    expect((await h().staff("POST", `/internal/v1/payments/${p.id}/simulate_dispute`, { reason: "fraudulent" }, "ops")).status).toBe(202);
    await h().drainAll();
    const ds = (await h().staff("GET", "/internal/v1/disputes?status=needs_response", undefined, "ops")).body.data;
    expect(ds.map((d: { station_id: string }) => d.station_id)).toEqual([m.stationId]);
    const acc = await h().staff("POST", `/internal/v1/disputes/${ds[0].id}/accept`, undefined, "ops");
    expect(acc.body.status).toBe("lost");
    expect((await h().staff("GET", `/internal/v1/disputes/${ds[0].id}`, undefined, "finance")).body.evidence).toEqual([]);

    await h().call(m, "POST", "/v1/webhook_endpoints", { url: "http://127.0.0.1:9/never" });
    await h().paid(m, "card");
    await h().drainAll();
    const failed = (
      await h().staff("GET", `/internal/v1/webhook_deliveries?station_id=${m.stationId}&status=failed`, undefined, "security")
    ).body.data;
    expect(failed.length).toBeGreaterThan(0);
    const rep = await h().staff("POST", `/internal/v1/webhook_deliveries/${failed[0].id}/replay`, undefined, "ops");
    expect([rep.status, rep.body.replay_of]).toEqual([201, failed[0].id]);
    expect(
      (await h().staff("GET", `/internal/v1/webhook_deliveries/${failed[0].id}`, undefined, "ops")).body.attempt_log.length,
    ).toBeGreaterThan(0);

    expect((await h().staff("POST", "/internal/v1/settlements/run", {}, "ops")).status).toBe(403);
    expect((await h().staff("POST", "/internal/v1/settlements/run", { date: "2026-11-20" }, "finance")).body).toEqual({
      object: "settlement_run",
      date: "2026-11-20",
      status: "queued",
    });
    expect((await h().staff("POST", "/internal/v1/reconciliation/run", {}, "finance")).status).toBe(202);
    expect((await h().staff("GET", "/internal/v1/reconciliation/latest", undefined, "finance")).body.status).toBe("never_run");
    expect((await h().staff("GET", "/internal/v1/settlements", undefined, "finance")).body.data).toEqual([]);

    const d = await h().staff(
      "POST",
      "/internal/v1/derailments",
      { title: "UPI success rate dip", severity: "sev2", summary: "Collect requests timing out at one PSP", affected: ["junction", "upi"] },
      "ops",
    );
    expect([d.status, d.body.status, d.body.notes.length]).toEqual([201, "investigating", 0]);
    const n = await h().staff(
      "POST",
      `/internal/v1/derailments/${d.body.id}/notes`,
      { body: "PSP confirmed; failing over", status: "mitigated" },
      "security",
    );
    expect([n.body.status, n.body.notes.map((x: { status_change: string | null }) => x.status_change)]).toEqual([
      "mitigated",
      ["investigating", "mitigated"],
    ]);
    const r = await h().staff("POST", `/internal/v1/derailments/${d.body.id}/notes`, { body: "Recovered", status: "resolved" }, "finance");
    expect(r.body.resolved_at).not.toBeNull();
    expect((await h().staff("POST", `/internal/v1/derailments/${d.body.id}/notes`, { body: "late note" }, "ops")).status).toBe(409);
    expect((await h().staff("GET", "/internal/v1/derailments?status=resolved", undefined, "finance")).body.data).toHaveLength(1);
  });
});
