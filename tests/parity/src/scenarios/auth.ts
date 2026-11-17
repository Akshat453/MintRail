import { nowSeconds, signHeaders } from "../http.js";
import { scenario } from "../scenario.js";

export default [
  scenario("auth/bearer-ok", async (c) => {
    const m = await c.merchant();
    await c.rcall("station", m, "GET", "/v1/station");
    await c.rstaff("last_used recorded", "GET", `/internal/v1/stations/${m.stationId}/api_keys`);
  }),
  ...(
    [
      ["none", {}],
      ["basic", { Authorization: "Basic abc" }],
      ["empty-bearer", { Authorization: "Bearer " }],
      ["foreign-prefix", { Authorization: "Bearer sk_test_123" }],
      ["unknown-key", { Authorization: `Bearer mr_test_${"a".repeat(40)}` }],
      ["short-key", { Authorization: `Bearer mr_test_${"a".repeat(39)}` }],
      ["bad-chars", { Authorization: `Bearer mr_test_${"!".repeat(40)}` }],
    ] as [string, Record<string, string>][]
  ).map(([name, headers]) =>
    scenario(`auth/bearer-failure/${name}`, async (c) => {
      await c.rapi(name, "GET", "/v1/station", { headers });
    }),
  ),
  scenario("auth/live-keys-must-sign", async (c) => {
    const live = await c.liveMerchant();
    await c.rcall("bearer live key", live, "GET", "/v1/station");
    await c.rcall("signed live balance", live, "GET", "/v1/balance", undefined, { signed: true });
    await c.rcall("signed live station", live, "GET", "/v1/station", undefined, { signed: true });
  }),
  scenario("auth/signed-get-post", async (c) => {
    const m = await c.merchant();
    await c.rcall("signed GET with query", m, "GET", "/v1/orders?limit=5", undefined, { signed: true });
    await c.rcall("signed POST", m, "POST", "/v1/orders", { amount: 5000 }, { signed: true });
  }),
  scenario("auth/bad-signature", async (c) => {
    const m = await c.merchant();
    await c.rcall("wrong secret", { ...m, secret: `mr_test_${"Z".repeat(40)}` }, "GET", "/v1/station", undefined, { signed: true });
  }),
  scenario("auth/tampered-body", async (c) => {
    const m = await c.merchant();
    const headers = signHeaders(m.secret, m.keyId, "POST", "/v1/orders", '{"amount": 100}', nowSeconds());
    await c.rapi("body changed after signing", "POST", "/v1/orders", {
      raw: '{"amount": 999999}',
      headers: { ...headers, "Idempotency-Key": "t1" },
    });
  }),
  scenario("auth/tampered-path-and-query", async (c) => {
    const m = await c.merchant();
    const h1 = signHeaders(m.secret, m.keyId, "GET", "/v1/orders?limit=5", "", nowSeconds());
    await c.rapi("query changed", "GET", "/v1/orders?limit=50", { headers: h1 });
    const h2 = signHeaders(m.secret, m.keyId, "GET", "/v1/station", "", nowSeconds());
    await c.rapi("path changed", "GET", "/v1/balance", { headers: h2 });
    const h3 = signHeaders(m.secret, m.keyId, "POST", "/v1/station", "", nowSeconds());
    await c.rapi("method changed", "GET", "/v1/station", { headers: h3 });
  }),
  ...[-3600, -301, 301, 3600].map((skew) =>
    scenario(`auth/clock-skew-rejected/${skew}`, async (c) => {
      const m = await c.merchant();
      await c.rcall(`skew ${skew}s`, m, "GET", "/v1/station", undefined, { signed: true, timestamp: nowSeconds() + skew });
    }),
  ),
  ...[-290, 0, 290].map((skew) =>
    scenario(`auth/clock-skew-accepted/${skew}`, async (c) => {
      const m = await c.merchant();
      await c.rcall(`skew ${skew}s`, m, "GET", "/v1/station", undefined, { signed: true, timestamp: nowSeconds() + skew });
    }),
  ),
  ...(
    [
      ["key-id-only", { "MintRail-Key-Id": "key_x" }],
      ["signature-only", { "MintRail-Signature": "t=1,v1=00" }],
      ["malformed-key-id", { "MintRail-Key-Id": "nope", "MintRail-Signature": "t=1,v1=00" }],
      ["unknown-key-id", { "MintRail-Key-Id": "key_01m7jw1n47vd107r0dmr0hdamb", "MintRail-Signature": "garbage" }],
    ] as [string, Record<string, string>][]
  ).map(([name, headers]) =>
    scenario(`auth/signed-malformed/${name}`, async (c) => {
      await c.rapi(name, "GET", "/v1/station", { headers });
    }),
  ),
  scenario("auth/signed-malformed-header-for-real-key", async (c) => {
    const m = await c.merchant();
    const h = { "MintRail-Key-Id": m.keyId };
    await c.rapi("no timestamp", "GET", "/v1/station", { headers: { ...h, "MintRail-Signature": "v1=00" } });
    await c.rapi("no v1", "GET", "/v1/station", { headers: { ...h, "MintRail-Signature": `t=${nowSeconds()}` } });
    await c.rapi("non-numeric t", "GET", "/v1/station", { headers: { ...h, "MintRail-Signature": "t=abc,v1=00" } });
  }),
  scenario("auth/revoked-key-cannot-sign", async (c) => {
    const m = await c.merchant();
    await c.staff("POST", `/internal/v1/api_keys/${m.keyId}/revoke`);
    await c.rcall("signed with revoked key", m, "GET", "/v1/station", undefined, { signed: true });
  }),
  scenario("auth/live-key-after-suspension", async (c) => {
    const live = await c.liveMerchant();
    await c.staff("POST", `/internal/v1/stations/${live.stationId}/suspend`, { reason: "chargebacks" });
    await c.rcall("signed live key, suspended station", live, "GET", "/v1/station", undefined, { signed: true });
  }),
];
