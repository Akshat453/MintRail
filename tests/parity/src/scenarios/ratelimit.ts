import { scenario } from "../scenario.js";

export default [
  scenario("ratelimit/burst-then-429", async (c) => {
    c.recordRemaining = true;
    const m = await c.merchant();
    await c.sql("UPDATE stations SET rate_limit_per_sec = 1, rate_limit_burst = 3 WHERE id = $1", [m.stationId]);
    for (let i = 1; i <= 5; i++) await c.rcall(`request ${i}`, m, "GET", "/v1/station");
  }),
  scenario("ratelimit/headers-and-isolation", async (c) => {
    c.recordRemaining = true;
    const a = await c.merchant();
    const b = await c.merchant();
    await c.rcall("station a", a, "GET", "/v1/station");
    await c.rcall("station b", b, "GET", "/v1/station");
  }),
  scenario("ratelimit/test-and-live-buckets", async (c) => {
    c.recordRemaining = true;
    const live = await c.liveMerchant();
    const test = await c.testKeyFor(live.stationId);
    await c.sql("UPDATE stations SET rate_limit_per_sec = 1, rate_limit_burst = 1 WHERE id = $1", [live.stationId]);
    await c.rcall("test 1", test, "GET", "/v1/station");
    await c.rcall("test 2 limited", test, "GET", "/v1/station");
    await c.rcall("live has its own bucket", live, "GET", "/v1/station", undefined, { signed: true });
  }),
];
