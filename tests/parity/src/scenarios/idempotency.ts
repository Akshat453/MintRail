import { scenario } from "../scenario.js";

export default [
  scenario("idempotency/required", async (c) => {
    const m = await c.merchant();
    await c.rcall("orders without key", m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: null });
    const o = await c.order(m);
    await c.rcall(
      "payments without key",
      m,
      "POST",
      "/v1/payments",
      { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } },
      { idempotencyKey: null },
    );
  }),
  scenario("idempotency/replay", async (c) => {
    const m = await c.merchant();
    await c.rcall("first", m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-1" });
    await c.rcall("replay", m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-1" });
    await c.rcall("only one order", m, "GET", "/v1/orders");
  }),
  scenario("idempotency/reuse-different-body", async (c) => {
    const m = await c.merchant();
    await c.rcall("first", m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-2" });
    await c.rcall("different amount", m, "POST", "/v1/orders", { amount: 2000 }, { idempotencyKey: "k-2" });
  }),
  scenario("idempotency/reuse-different-path", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    await c.rcall("order with key", m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-3" });
    await c.rcall(
      "payment with same key",
      m,
      "POST",
      "/v1/payments",
      { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } },
      { idempotencyKey: "k-3" },
    );
  }),
  scenario("idempotency/scoped-per-station", async (c) => {
    const a = await c.merchant();
    const b = await c.merchant();
    await c.rcall("station a", a, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "shared" });
    await c.rcall("station b", b, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "shared" });
  }),
  scenario("idempotency/client-errors-replayed", async (c) => {
    const m = await c.merchant();
    const body = { order_id: "ord_00000000000000000000000000", method: "upi", upi: { vpa: "asha@okbank" } };
    await c.rcall("first 404", m, "POST", "/v1/payments", body, { idempotencyKey: "k-4" });
    await c.rcall("replayed 404", m, "POST", "/v1/payments", body, { idempotencyKey: "k-4" });
  }),
  scenario("idempotency/payment-replay-after-capture", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const body = { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } };
    await c.rcall("pay", m, "POST", "/v1/payments", body, { idempotencyKey: "pay-1" });
    await c.settle();
    await c.rcall("replay returns the original (created) response", m, "POST", "/v1/payments", body, { idempotencyKey: "pay-1" });
  }),
  scenario("idempotency/in-progress-and-stale-takeover", async (c) => {
    const m = await c.merchant();
    await c.call(m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-5" });
    await c.sql("UPDATE idempotency_keys SET status='in_progress', response_body=NULL, locked_at=now() WHERE key='k-5'");
    await c.rcall("in progress", m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-5" });
    await c.sql("UPDATE idempotency_keys SET locked_at = now() - interval '10 minutes' WHERE key='k-5'");
    await c.rcall("stale lock taken over", m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k-5" });
  }),
  ...(
    [
      ["space", "has space"],
      ["too-long", "x".repeat(256)],
      ["non-ascii", "clé-ü"],
    ] as [string, string][]
  ).map(([name, key]) =>
    scenario(`idempotency/malformed-key/${name}`, async (c) => {
      const m = await c.merchant();
      await c.rcall(name, m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: key });
    }),
  ),
  scenario("idempotency/max-length-key-ok", async (c) => {
    const m = await c.merchant();
    await c.rcall("255 chars", m, "POST", "/v1/orders", { amount: 1000 }, { idempotencyKey: "k".repeat(255) });
  }),
];
