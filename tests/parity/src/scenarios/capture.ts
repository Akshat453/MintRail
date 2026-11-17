import { scenario } from "../scenario.js";

export default [
  scenario("capture/manual-flow", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const r = await c.rcall("pay manual", m, "POST", "/v1/payments", {
      order_id: o.id,
      method: "card",
      card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2030, cvv: "123" },
      capture: "manual",
    });
    const id = (r.body as { id: string }).id;
    await c.settle();
    await c.rcall("authorized", m, "GET", `/v1/payments/${id}`);
    await c.rcall("balance zero", m, "GET", "/v1/balance");
    await c.rcall("partial capture", m, "POST", `/v1/payments/${id}/capture`, { amount: 100 });
    await c.rcall("string amount", m, "POST", `/v1/payments/${id}/capture`, { amount: "49900" });
    await c.rcall("capture", m, "POST", `/v1/payments/${id}/capture`, {});
    await c.rcall("capture again", m, "POST", `/v1/payments/${id}/capture`, {});
    await c.rcall("exact amount capture is idempotent", m, "POST", `/v1/payments/${id}/capture`, { amount: 49_900 });
    await c.rcall("balance", m, "GET", "/v1/balance");
  }),
  scenario("capture/station-default-manual", async (c) => {
    const m = await c.merchant({ settings: { auto_capture: false } });
    c.note("payment", await c.paid(m, "card"));
  }),
  scenario("capture/explicit-automatic-overrides-station", async (c) => {
    const m = await c.merchant({ settings: { auto_capture: false } });
    c.note("payment", await c.paid(m, "card", { extra: { capture: "automatic" } }));
  }),
  scenario("capture/cannot-capture-failed-or-pending", async (c) => {
    const m = await c.merchant();
    const failed = await c.paid(m, "card", { scenario: "decline:card_declined" });
    await c.rcall("failed", m, "POST", `/v1/payments/${failed.id}/capture`, {});
    const pending = await c.paid(m, "upi", { details: { upi: { vpa: "timeout@mintrail" } } });
    await c.rcall("pending", m, "POST", `/v1/payments/${pending.id}/capture`, {});
  }),
  scenario("capture/authorization-expiry", async (c) => {
    const m = await c.merchant();
    const p = await c.paid(m, "card", { extra: { capture: "manual" } });
    await c.releaseJobs("payments.expire_authorization");
    await c.settle();
    await c.rcall("expired", m, "GET", `/v1/payments/${p.id}`);
  }),
];
