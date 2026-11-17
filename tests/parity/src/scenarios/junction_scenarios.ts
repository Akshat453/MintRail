import { scenario } from "../scenario.js";

export default [
  scenario("junction/timeout-then-gateway-timeout", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const r = await c.rcall(
      "pay",
      m,
      "POST",
      "/v1/payments",
      { order_id: o.id, method: "card", card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2030, cvv: "123" } },
      { headers: { "MintRail-Test-Scenario": "timeout" } },
    );
    const id = (r.body as { id: string }).id;
    await c.settle();
    await c.rcall("pending", m, "GET", `/v1/payments/${id}`);
    await c.releaseJobs("payments.status_check");
    await c.settle();
    await c.rcall("still pending after first check", m, "GET", `/v1/payments/${id}`);
    await c.agePayment(id, 901);
    await c.releaseJobs("payments.status_check");
    await c.settle();
    await c.rcall("failed with gateway_timeout", m, "GET", `/v1/payments/${id}`);
  }),
  scenario("junction/timeout-magic-vpa", async (c) => {
    const m = await c.merchant();
    c.note("payment", await c.paid(m, "upi", { details: { upi: { vpa: "timeout@mintrail" } } }));
  }),
  scenario("junction/delayed", async (c) => {
    const m = await c.merchant();
    c.note("payment", await c.paid(m, "upi", { scenario: "delayed:45" }));
  }),
  scenario("junction/duplicate-callbacks", async (c) => {
    const m = await c.merchant();
    const p = await c.paid(m, "card", { scenario: "duplicate_callbacks" });
    c.note("payment", p);
    await c.rstaff("one applied event", "GET", `/internal/v1/payments/${p.id}`);
  }),
  scenario("junction/out-of-order", async (c) => {
    const m = await c.merchant();
    const p = await c.paid(m, "upi", { scenario: "out_of_order" });
    await c.rstaff("stale pending recorded", "GET", `/internal/v1/payments/${p.id}`);
  }),
  scenario("junction/flaky-bank-retried", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const r = await c.pay(m, o.id, "upi", { scenario: "flaky" });
    const id = (r.body as { id: string }).id;
    await c.settle();
    await c.rcall("still created after 503", m, "GET", `/v1/payments/${id}`);
    await c.releaseJobs("payments.submit");
    await c.settle();
    await c.rcall("captured after retry", m, "GET", `/v1/payments/${id}`);
  }),
  scenario("junction/unknown-scenario-rejected-by-bank", async (c) => {
    const m = await c.merchant();
    c.note("payment", await c.paid(m, "upi", { scenario: "meteor_strike" }));
  }),
  ...[
    ["uppercase", "Bad Scenario!"],
    ["too-long", "x".repeat(80)],
    ["bad-arg", "decline:Bad Code"],
  ].map(([name, s]) =>
    scenario(`junction/malformed-scenario/${name}`, async (c) => {
      const m = await c.merchant();
      const o = await c.order(m);
      await c.rcall(
        name!,
        m,
        "POST",
        "/v1/payments",
        { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } },
        { headers: { "MintRail-Test-Scenario": s! } },
      );
    }),
  ),
  scenario("junction/scenarios-forbidden-in-live", async (c) => {
    const live = await c.liveMerchant();
    const o = await c.call(live, "POST", "/v1/orders", { amount: 1000 }, { signed: true });
    await c.rcall(
      "live scenario header",
      live,
      "POST",
      "/v1/payments",
      { order_id: (o.body as { id: string }).id, method: "upi", upi: { vpa: "asha@okaxis" } },
      { signed: true, headers: { "MintRail-Test-Scenario": "success" } },
    );
  }),
  scenario("junction/late-authorization-voided", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const r = await c.pay(m, o.id, "upi", { scenario: "timeout" });
    const id = (r.body as { id: string }).id;
    await c.settle();
    await c.agePayment(id, 901);
    await c.releaseJobs("payments.status_check");
    await c.settle();
    const ref = (await c.internalPayment(id)).junction_ref as string;
    await c.record(
      "late succeeded callback",
      "POST",
      "/internal/junction/v1/callbacks",
      await c.postCallback({ id: `jev_${ref}_2`, type: "authorization.succeeded", sequence: 2, ref, payment_id: id }),
    );
    await c.settle();
    await c.rcall("still failed", m, "GET", `/v1/payments/${id}`);
    await c.rstaff("void recorded", "GET", `/internal/v1/payments/${id}`);
  }),
  scenario("junction/card-success-has-no-pending-event", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const r = await c.pay(m, o.id, "card", { scenario: "success" });
    const id = (r.body as { id: string }).id;
    await c.settle();
    c.note("payment", (await c.call(m, "GET", `/v1/payments/${id}`)).body);
  }),
];
