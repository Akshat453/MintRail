/** Ported from api/tests/test_auth_integration.py: plumbing, bearer, signing, rate limits, idempotency. */
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { signRequest } from "../src/signing.js";
import { API_VERSION } from "../src/version.js";
import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();
const now = () => Math.floor(Date.now() / 1000);

describe("plumbing", () => {
  test("health", async () => {
    expect((await h().request("GET", "/healthz")).body).toEqual({ status: "ok", version: API_VERSION });
    expect((await h().request("GET", "/readyz")).status).toBe(200);
  });
  test("request id and version headers", async () => {
    let r = await h().request("GET", "/healthz");
    expect(r.headers["x-request-id"]).toMatch(/^req_/);
    expect(r.headers["mintrail-version"]).toBe(API_VERSION);
    expect(r.headers["content-type"]).toBe("application/json");
    r = await h().request("GET", "/healthz", { headers: { "X-Request-Id": "trace-abc-12345" } });
    expect(r.headers["x-request-id"]).toBe("trace-abc-12345");
    r = await h().request("GET", "/healthz", { headers: { "X-Request-Id": "bad id" } });
    expect(r.headers["x-request-id"]).toMatch(/^req_/);
  });
  test("unknown route, wrong method, trailing slash, openapi", async () => {
    expect((await h().request("GET", "/v1/nope")).body.error.code).toBe("MR_RESOURCE_NOT_FOUND");
    expect((await h().request("DELETE", "/healthz")).body.error.code).toBe("MR_METHOD_NOT_ALLOWED");
    const redirect = await h().request("GET", "/v1/orders/?limit=1");
    expect([redirect.status, redirect.headers.location]).toEqual([307, "/v1/orders?limit=1"]);
    const doc = await h().request("GET", "/openapi.json");
    expect(doc.body.openapi).toBe("3.1.0");
    expect(Object.keys(doc.body.paths)).toContain("/v1/payments");
  });
  test("security headers (helmet) and body limit", async () => {
    const r = await h().request("GET", "/healthz");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-powered-by"]).toBeUndefined();
    const m = await h().merchant();
    const big = await h().call(m, "POST", "/v1/orders", undefined, {
      raw: JSON.stringify({ amount: 1000, receipt: "x".repeat(2_000_000) }),
    });
    expect([big.status, big.body.error.code]).toEqual([413, "MR_INVALID_REQUEST"]);
  });
});

describe("bearer", () => {
  test("ok", async () => {
    const m = await h().merchant();
    const r = await h().call(m, "GET", "/v1/station");
    expect([r.status, r.body.id]).toEqual([200, m.stationId]);
  });
  test.each([
    [{}, "MR_AUTHENTICATION_REQUIRED"],
    [{ Authorization: "Basic abc" }, "MR_AUTHENTICATION_REQUIRED"],
    [{ Authorization: "Bearer " }, "MR_AUTHENTICATION_REQUIRED"],
    [{ Authorization: "Bearer sk_test_123" }, "MR_INVALID_API_KEY"],
    [{ Authorization: `Bearer mr_test_${"a".repeat(40)}` }, "MR_INVALID_API_KEY"],
  ])("failure %j", async (headers, code) => {
    const r = await h().request("GET", "/v1/station", { headers });
    expect([r.status, r.body.error.code, r.headers["www-authenticate"]]).toEqual([401, code, "Bearer"]);
  });
  test("live keys must sign", async () => {
    const live = await h().liveMerchant();
    const r = await h().call(live, "GET", "/v1/station");
    expect([r.status, r.body.error.code]).toEqual([401, "MR_SIGNATURE_REQUIRED"]);
    const signed = await h().call(live, "GET", "/v1/balance", undefined, { signed: true });
    expect([signed.status, signed.body.livemode]).toEqual([200, true]);
  });
});

describe("signed requests", () => {
  test("signed GET with query and POST with body", async () => {
    const m = await h().merchant();
    expect((await h().call(m, "GET", "/v1/orders?limit=5", undefined, { signed: true })).status).toBe(200);
    expect((await h().call(m, "POST", "/v1/orders", { amount: 5000 }, { signed: true })).status).toBe(201);
  });
  test("bad signature", async () => {
    const m = await h().merchant();
    const r = await h().call({ ...m, secret: `mr_test_${"Z".repeat(40)}` }, "GET", "/v1/station", undefined, { signed: true });
    expect([r.status, r.body.error.code]).toEqual([401, "MR_INVALID_SIGNATURE"]);
  });
  test("tampered body", async () => {
    const m = await h().merchant();
    const headers = signRequest(m.secret, m.keyId, { method: "POST", path: "/v1/orders", body: '{"amount": 100}' });
    const r = await h().request("POST", "/v1/orders", { raw: '{"amount": 999999}', headers: { ...headers, "Idempotency-Key": "t1" } });
    expect(r.body.error.code).toBe("MR_INVALID_SIGNATURE");
  });
  test.each([-301, 301, 3600])("clock skew %s rejected", async (skew) => {
    const m = await h().merchant();
    const r = await h().call(m, "GET", "/v1/station", undefined, { signed: true, timestamp: now() + skew });
    expect([r.status, r.body.error.code]).toEqual([401, "MR_REQUEST_EXPIRED"]);
  });
  test.each([-290, 0, 290])("skew %s within the window accepted", async (skew) => {
    const m = await h().merchant();
    expect((await h().call(m, "GET", "/v1/station", undefined, { signed: true, timestamp: now() + skew })).status).toBe(200);
  });
  test.each([
    { "MintRail-Key-Id": "key_x" },
    { "MintRail-Signature": "t=1,v1=00" },
    { "MintRail-Key-Id": "nope", "MintRail-Signature": "t=1,v1=00" },
    { "MintRail-Key-Id": "key_01m7jw1n47vd107r0dmr0hdamb", "MintRail-Signature": "garbage" },
  ] as Record<string, string>[])("malformed %j", async (headers) =>
    expect((await h().request("GET", "/v1/station", { headers })).status).toBe(401),
  );
  test("revoked key cannot sign", async () => {
    const m = await h().merchant();
    await h().staff("POST", `/internal/v1/api_keys/${m.keyId}/revoke`);
    expect((await h().call(m, "GET", "/v1/station", undefined, { signed: true })).body.error.code).toBe("MR_API_KEY_REVOKED");
  });
});

describe("rate limit", () => {
  test("burst then 429", async () => {
    const m = await h().merchant();
    await db().execute(sql`UPDATE stations SET rate_limit_per_sec = 1, rate_limit_burst = 3 WHERE id = ${m.stationId}`);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await h().call(m, "GET", "/v1/station")).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const r = await h().call(m, "GET", "/v1/station");
    expect(r.body.error.code).toBe("MR_RATE_LIMITED");
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
  test("headers and isolation between stations", async () => {
    const a = await h().merchant();
    const b = await h().merchant();
    const r = await h().call(a, "GET", "/v1/station");
    expect([r.headers["ratelimit-limit"], r.headers["ratelimit-remaining"]]).toEqual(["50", "49"]);
    expect((await h().call(b, "GET", "/v1/station")).headers["ratelimit-remaining"]).toBe("49");
  });
});

describe("idempotency", () => {
  test("required on POST", async () => {
    const m = await h().merchant();
    const r = await h().call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: null });
    expect([r.status, r.body.error.code]).toEqual([400, "MR_IDEMPOTENCY_KEY_REQUIRED"]);
  });
  test("replay returns the same response", async () => {
    const m = await h().merchant();
    const first = await h().call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-1" });
    const again = await h().call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-1" });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect((await h().call(m, "GET", "/v1/orders")).body.data).toHaveLength(1);
  });
  test("reuse with a different body", async () => {
    const m = await h().merchant();
    await h().call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-2" });
    const r = await h().call(m, "POST", "/v1/orders", { amount: 2000 }, { idempotencyKey: "k-2" });
    expect([r.status, r.body.error.code]).toEqual([409, "MR_IDEMPOTENCY_KEY_REUSED"]);
  });
  test("keys are scoped per station", async () => {
    const a = await h().merchant();
    const b = await h().merchant();
    const ra = await h().call(a, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "shared" });
    const rb = await h().call(b, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "shared" });
    expect(ra.body.id).not.toBe(rb.body.id);
  });
  test("client errors are replayed", async () => {
    const m = await h().merchant();
    const body = { order_id: "ord_00000000000000000000000000", method: "upi", upi: { vpa: "asha@okbank" } };
    const r1 = await h().call(m, "POST", "/v1/payments", body, { idempotencyKey: "k-3" });
    const r2 = await h().call(m, "POST", "/v1/payments", body, { idempotencyKey: "k-3" });
    expect([r1.status, r2.status]).toEqual([404, 404]);
    expect(r2.body).toEqual(r1.body);
    expect(r2.headers["idempotent-replayed"]).toBe("true");
  });
  test("in-progress conflict and stale takeover", async () => {
    const m = await h().merchant();
    await h().call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-4" });
    await db().execute(sql`UPDATE idempotency_keys SET status='in_progress', response_body=NULL, locked_at=now() WHERE key='k-4'`);
    expect((await h().call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-4" })).body.error.code).toBe(
      "MR_IDEMPOTENCY_KEY_IN_PROGRESS",
    );
    await db().execute(sql`UPDATE idempotency_keys SET locked_at = now() - interval '10 minutes' WHERE key='k-4'`);
    expect((await h().call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-4" })).status).toBe(201);
  });
  test.each(["has space", "x".repeat(256), "tab\there"])("malformed key %j", async (key) => {
    const m = await h().merchant();
    expect((await h().call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: key })).status).toBe(400);
  });
});
