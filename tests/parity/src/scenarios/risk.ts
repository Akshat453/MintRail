import { scenario } from "../scenario.js";

export default [
  scenario("risk/blocklist-vpa-lifecycle", async (c) => {
    const r = await c.rstaff(
      "add",
      "POST",
      "/internal/v1/risk/blocklist",
      { kind: "vpa", value: "Mule@OkBank", reason: "money mule" },
      "security",
    );
    const entry = (r.body as { id: string }).id;
    const m = await c.merchant();
    const o = await c.order(m);
    await c.rcall("blocked payment", m, "POST", "/v1/payments", { order_id: o.id, method: "upi", upi: { vpa: "mule@okbank" } });
    await c.rstaff(
      "duplicate entry",
      "POST",
      "/internal/v1/risk/blocklist",
      { kind: "vpa", value: "mule@okbank", reason: "again" },
      "security",
    );
    await c.rstaff("list", "GET", "/internal/v1/risk/blocklist", undefined, "security");
    await c.rstaff("deactivate", "POST", `/internal/v1/risk/blocklist/${entry}/deactivate`, undefined, "security");
    await c.rstaff(
      "deactivate unknown",
      "POST",
      "/internal/v1/risk/blocklist/blk_00000000000000000000000000/deactivate",
      undefined,
      "security",
    );
    const o2 = await c.order(m);
    await c.rcall(
      "allowed again",
      m,
      "POST",
      "/v1/payments",
      { order_id: o2.id, method: "upi", upi: { vpa: "mule@okbank" } },
      { headers: { "MintRail-Test-Scenario": "success" } },
    );
  }),
  scenario("risk/blocked-bin", async (c) => {
    await c.rstaff("add bin", "POST", "/internal/v1/risk/blocklist", { kind: "card_bin", value: "411111", reason: "BIN attack" });
    const m = await c.merchant();
    const o = await c.order(m);
    await c.rcall("blocked card", m, "POST", "/v1/payments", {
      order_id: o.id,
      method: "card",
      card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2030, cvv: "123" },
    });
  }),
  scenario("risk/upi-limit", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m, 1_00_000_01n);
    await c.rcall("over upi cap", m, "POST", "/v1/payments", { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } });
  }),
  scenario("risk/upi-at-cap-allowed", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m, 1_00_000_00n);
    await c.rcall("at upi cap", m, "POST", "/v1/payments", { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } });
  }),
  scenario("risk/card-over-limit", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m, 5_00_000_01n);
    await c.rcall("over card cap", m, "POST", "/v1/payments", {
      order_id: o.id,
      method: "card",
      card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2030, cvv: "123" },
    });
  }),
  scenario("risk/station-limit", async (c) => {
    const m = await c.merchant({ settings: { max_payment_amount: 10_000 } });
    const o = await c.order(m, 10_001n);
    await c.rcall("over station limit", m, "POST", "/v1/payments", { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } });
  }),
  scenario("risk/high-value-review-approve", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m, 2_50_000_00n);
    const r = await c.rcall("high value", m, "POST", "/v1/payments", {
      order_id: o.id,
      method: "card",
      card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2030, cvv: "123" },
    });
    const id = (r.body as { id: string }).id;
    await c.settle();
    await c.rcall("authorized, held", m, "GET", `/v1/payments/${id}`);
    await c.rstaff("review queue", "GET", "/internal/v1/payments/review_queue", undefined, "ops");
    await c.rcall("merchant capture blocked", m, "POST", `/v1/payments/${id}/capture`, {});
    await c.rstaff(
      "approve",
      "POST",
      `/internal/v1/payments/${id}/risk_review`,
      { action: "approve", note: "known corporate buyer" },
      "ops",
    );
    await c.settle();
    await c.rcall("captured", m, "GET", `/v1/payments/${id}`);
    await c.rstaff("second review", "POST", `/internal/v1/payments/${id}/risk_review`, { action: "reject" }, "ops");
    await c.rstaff("queue empty", "GET", "/internal/v1/payments/review_queue", undefined, "ops");
  }),
  scenario("risk/high-value-review-reject", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m, 2_50_000_00n);
    const r = await c.pay(m, o.id, "card");
    const id = (r.body as { id: string }).id;
    await c.settle();
    await c.rstaff("reject", "POST", `/internal/v1/payments/${id}/risk_review`, { action: "reject" });
    await c.settle();
    await c.rcall("failed risk_rejected", m, "GET", `/v1/payments/${id}`);
  }),
  scenario("risk/review-invalid-action", async (c) => {
    await c.rstaff("bad action", "POST", "/internal/v1/payments/pay_00000000000000000000000000/risk_review", { action: "maybe" });
    await c.rstaff("unknown payment", "POST", "/internal/v1/payments/pay_00000000000000000000000000/risk_review", { action: "approve" });
  }),
  scenario("risk/velocity", async (c) => {
    const m = await c.merchant();
    for (let i = 1; i <= 5; i++) {
      const o = await c.order(m);
      await c.rcall(
        `attempt ${i}`,
        m,
        "POST",
        "/v1/payments",
        { order_id: o.id, method: "upi", upi: { vpa: "rapid@okbank" } },
        { headers: { "MintRail-Test-Scenario": "timeout" } },
      );
    }
  }),
  scenario("risk/bad-blocklist-values", async (c) => {
    await c.rstaff("bad bin", "POST", "/internal/v1/risk/blocklist", { kind: "card_bin", value: "41x", reason: "bad" });
    await c.rstaff("bad vpa", "POST", "/internal/v1/risk/blocklist", { kind: "vpa", value: "nope", reason: "bad" });
    await c.rstaff("bad kind", "POST", "/internal/v1/risk/blocklist", { kind: "email", value: "x@y.z", reason: "bad" });
  }),
];
