import { scenario } from "../scenario.js";

export default [
  scenario("orders/create-get-list", async (c) => {
    const m = await c.merchant();
    const r = await c.rcall("create", m, "POST", "/v1/orders", {
      amount: 2500,
      currency: "INR",
      receipt: "rcpt_1",
      notes: { customer: "C-17", n: 3, vip: true },
    });
    const id = (r.body as { id: string }).id;
    await c.rcall("get", m, "GET", `/v1/orders/${id}`);
    await c.rcall("create second", m, "POST", "/v1/orders", { amount: 3000 });
    const p = await c.rcall("page 1", m, "GET", "/v1/orders?limit=1");
    const first = (p.body as { data: { id: string }[] }).data[0]!.id;
    await c.rcall("page 2", m, "GET", `/v1/orders?starting_after=${first}`);
    await c.rcall("order payments (none)", m, "GET", `/v1/orders/${id}/payments`);
  }),
  ...(
    [
      ["amount-below-min", { amount: 99 }],
      ["amount-at-min", { amount: 100 }],
      ["amount-above-max", { amount: 100_000_000_001 }],
      ["currency-eur", { amount: 1000, currency: "EUR" }],
      ["amount-string", { amount: "1000" }],
      ["amount-float", { amount: 10.5 }],
      ["amount-missing", {}],
      ["amount-negative", { amount: -5 }],
      ["amount-bool", { amount: true }],
      ["receipt-too-long", { amount: 1000, receipt: "x".repeat(41) }],
      ["note-value-too-long", { amount: 1000, notes: { k: "v".repeat(300) } }],
      ["note-nested", { amount: 1000, notes: { k: { nested: 1 } } }],
      ["notes-too-many", { amount: 1000, notes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"])) }],
      ["note-key-empty", { amount: 1000, notes: { "": "v" } }],
      ["extra-field", { amount: 1000, colour: "red" }],
      ["usd", { amount: 10_000, currency: "USD" }],
    ] as [string, Record<string, unknown>][]
  ).map(([name, body]) =>
    scenario(`orders/validation/${name}`, async (c) => {
      const m = await c.merchant();
      await c.rcall(name, m, "POST", "/v1/orders", body);
    }),
  ),
  scenario("orders/amount-float-literal-10.0", async (c) => {
    const m = await c.merchant();
    await c.rcall("10.0 is not an integer", m, "POST", "/v1/orders", undefined, { raw: '{"amount": 1000.0}' });
  }),
  scenario("orders/isolation-between-stations-and-modes", async (c) => {
    const a = await c.merchant();
    const b = await c.merchant();
    const o = await c.order(a);
    await c.rcall("other station", b, "GET", `/v1/orders/${o.id}`);
    const live = await c.liveMerchant();
    const test = await c.testKeyFor(live.stationId);
    const testOrder = await c.order(test);
    await c.rcall("live key cannot see test order", live, "GET", `/v1/orders/${testOrder.id}`, undefined, { signed: true });
    await c.rcall("bad order id", a, "GET", "/v1/orders/not-an-id");
    await c.rcall("bad cursor", a, "GET", "/v1/orders?starting_after=pay_x");
  }),
];
