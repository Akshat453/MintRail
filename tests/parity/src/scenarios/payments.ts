import { TEST_CARD } from "../ctx.js";
import { scenario } from "../scenario.js";

const card = (number: string, extra: Record<string, unknown> = {}) => ({
  card: { number, expiry_month: 1, expiry_year: 2031, cvv: "111", ...extra },
});

export default [
  scenario("payments/upi-success", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m, 49_900n);
    const r = await c.rcall(
      "pay",
      m,
      "POST",
      "/v1/payments",
      { order_id: o.id, method: "upi", upi: { vpa: "asha@okaxis" } },
      { headers: { "MintRail-Test-Scenario": "success" } },
    );
    await c.settle();
    const id = (r.body as { id: string }).id;
    await c.rcall("captured", m, "GET", `/v1/payments/${id}`);
    await c.rcall("order paid", m, "GET", `/v1/orders/${o.id}`);
    await c.rcall("balance", m, "GET", "/v1/balance");
    await c.rstaff("internal view with events", "GET", `/internal/v1/payments/${id}`);
  }),
  scenario("payments/card-success", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const r = await c.rcall("pay card", m, "POST", "/v1/payments", {
      order_id: o.id,
      method: "card",
      card: { ...TEST_CARD, number: "4111 1111 1111 1111", name: "Asha K" },
      email: "asha@example.com",
    });
    await c.settle();
    await c.rcall("captured", m, "GET", `/v1/payments/${(r.body as { id: string }).id}`);
  }),
  scenario("payments/netbanking-success", async (c) => {
    const m = await c.merchant();
    const p = await c.paid(m, "netbanking");
    c.note("payment", p);
  }),
  scenario("payments/netbanking-real-bank-with-scenario", async (c) => {
    const m = await c.merchant();
    const p = await c.paid(m, "netbanking", { details: { netbanking: { bank_code: "hdfc" } }, scenario: "success" });
    c.note("payment", p);
  }),
  scenario("payments/usd-card", async (c) => {
    const m = await c.merchant();
    const o = await c.rcall("usd order", m, "POST", "/v1/orders", { amount: 10_000, currency: "USD" });
    const r = await c.pay(m, (o.body as { id: string }).id, "card");
    await c.settle();
    await c.rcall("captured", m, "GET", `/v1/payments/${(r.body as { id: string }).id}`);
    await c.rcall("balances", m, "GET", "/v1/balance");
    await c.rcall("balance usd", m, "GET", "/v1/balance?currency=USD");
    await c.rcall("balance eur", m, "GET", "/v1/balance?currency=EUR");
  }),
  scenario("payments/usd-requires-card", async (c) => {
    const m = await c.merchant();
    const o = await c.call(m, "POST", "/v1/orders", { amount: 10_000, currency: "USD" });
    await c.rcall("upi for usd", m, "POST", "/v1/payments", {
      order_id: (o.body as { id: string }).id,
      method: "upi",
      upi: { vpa: "success@mintrail" },
    });
  }),
  ...(
    [
      ["missing-method-object", { method: "card" }],
      ["unknown-method", { method: "wallet" }],
      ["bad-card-number", { method: "card", ...card("4111111111111112") }],
      ["short-card-number", { method: "card", card: { number: "41111", expiry_month: 1, expiry_year: 2031, cvv: "111" } }],
      ["expired-card", { method: "card", ...card("4111111111111111", { expiry_month: 1, expiry_year: 2020 }) }],
      ["bad-month", { method: "card", ...card("4111111111111111", { expiry_month: 13 }) }],
      ["bad-cvv", { method: "card", ...card("4111111111111111", { cvv: "12a" }) }],
      ["amex-cvv-length", { method: "card", ...card("378282246310005", { cvv: "123" }) }],
      ["bad-vpa", { method: "upi", upi: { vpa: "x@1bank" } }],
      ["unknown-bank", { method: "netbanking", netbanking: { bank_code: "ZZZZ" } }],
      ["bad-email", { method: "upi", upi: { vpa: "success@mintrail" }, email: "nope" }],
      ["bad-capture", { method: "upi", upi: { vpa: "success@mintrail" }, capture: "later" }],
      ["extra-field", { method: "upi", upi: { vpa: "success@mintrail" }, tip: 5 }],
    ] as [string, Record<string, unknown>][]
  ).map(([name, body]) =>
    scenario(`payments/validation/${name}`, async (c) => {
      const m = await c.merchant();
      const o = await c.order(m);
      await c.rcall(name, m, "POST", "/v1/payments", { order_id: o.id, ...body });
    }),
  ),
  scenario("payments/unknown-and-malformed-order", async (c) => {
    const m = await c.merchant();
    await c.rcall("unknown order", m, "POST", "/v1/payments", {
      order_id: "ord_00000000000000000000000000",
      method: "upi",
      upi: { vpa: "success@mintrail" },
    });
    await c.rcall("malformed order id", m, "POST", "/v1/payments", { order_id: "pay_x", method: "upi", upi: { vpa: "success@mintrail" } });
  }),
  ...[
    "insufficient_funds",
    "card_declined",
    "do_not_honor",
    "expired_card",
    "incorrect_cvv",
    "upi_collect_declined",
    "upi_collect_expired",
    "upi_invalid_vpa",
    "bank_unavailable",
    "netbanking_cancelled",
    "risk_declined_by_issuer",
  ].map((code) =>
    scenario(`payments/decline/${code}`, async (c) => {
      const m = await c.merchant();
      const method = code.startsWith("upi") ? "upi" : code.startsWith("netbanking") ? "netbanking" : "card";
      c.note("payment", await c.paid(m, method, { scenario: `decline:${code}` }));
    }),
  ),
  ...(
    [
      ["upi-failure", "upi", { upi: { vpa: "failure@mintrail" } }],
      ["upi-expired", "upi", { upi: { vpa: "expired@mintrail" } }],
      ["card-declined", "card", card("4000000000000002")],
      ["card-insufficient", "card", card("4000000000009995")],
      ["card-expired", "card", card("4000000000000069")],
      ["card-cvv", "card", card("4000000000000127")],
      ["nb-fail", "netbanking", { netbanking: { bank_code: "MRFAIL" } }],
    ] as [string, "upi" | "card" | "netbanking", Record<string, unknown>][]
  ).map(([name, method, details]) =>
    scenario(`payments/magic-instrument/${name}`, async (c) => {
      const m = await c.merchant();
      c.note("payment", await c.paid(m, method, { details }));
    }),
  ),
  scenario("payments/retry-after-failure", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    await c.rcall(
      "declined",
      m,
      "POST",
      "/v1/payments",
      { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } },
      { headers: { "MintRail-Test-Scenario": "decline:upi_collect_declined" } },
    );
    await c.settle();
    await c.rcall("retry", m, "POST", "/v1/payments", { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } });
    await c.settle();
    await c.rcall("order", m, "GET", `/v1/orders/${o.id}`);
    await c.rcall("order payments", m, "GET", `/v1/orders/${o.id}/payments`);
    await c.rcall("failed filter", m, "GET", "/v1/payments?status=failed");
    await c.rcall("bad status filter", m, "GET", "/v1/payments?status=weird");
    await c.rcall("list", m, "GET", "/v1/payments?limit=1");
  }),
  scenario("payments/one-in-flight", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    await c.rcall("first", m, "POST", "/v1/payments", { order_id: o.id, method: "upi", upi: { vpa: "timeout@mintrail" } });
    await c.rcall("second while first pending", m, "POST", "/v1/payments", {
      order_id: o.id,
      method: "upi",
      upi: { vpa: "success@mintrail" },
    });
  }),
  scenario("payments/paid-order", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    await c.pay(m, o.id);
    await c.settle();
    await c.rcall("pay again", m, "POST", "/v1/payments", { order_id: o.id, method: "upi", upi: { vpa: "success@mintrail" } });
  }),
  scenario("payments/isolation", async (c) => {
    const a = await c.merchant();
    const b = await c.merchant();
    const p = await c.paid(a, "card");
    await c.rcall("other station reads", b, "GET", `/v1/payments/${p.id}`);
    await c.rcall("other station captures", b, "POST", `/v1/payments/${p.id}/capture`, {});
    await c.rcall("malformed payment id", a, "GET", "/v1/payments/ord_00000000000000000000000000");
  }),
];
