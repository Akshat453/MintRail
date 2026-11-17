import { scenario } from "../scenario.js";

const body = (extra: Record<string, unknown> = {}) => ({
  payment_id: "pay_parity_http",
  merchant_ref: "mer_1",
  amount: 500,
  currency: "INR",
  method: "card",
  instrument: "card:411111:1111",
  livemode: false,
  // card + timeout: Junction emits no callbacks, so no deliveries to a payment Platform
  // doesn't know (whose 404-retry timing would be nondeterministic).
  scenario: "timeout",
  ...extra,
});

export default [
  scenario("junction-api/health-and-auth", async (c) => {
    await c.rjunction("health", "GET", "/healthz", undefined, false);
    await c.rjunction("no key", "POST", "/v1/authorizations", body(), false);
  }),
  scenario("junction-api/lifecycle", async (c) => {
    const r = await c.rjunction("authorize", "POST", "/v1/authorizations", body());
    const ref = (r.body as { ref: string }).ref;
    await c.rjunction("idempotent repeat", "POST", "/v1/authorizations", body());
    await c.rjunction("mismatched repeat", "POST", "/v1/authorizations", body({ amount: 1 }));
    await c.rjunction("get", "GET", `/v1/authorizations/${ref}`);
    await c.rjunction("find", "GET", "/v1/authorizations?payment_id=pay_parity_http");
    await c.rjunction("find unknown", "GET", "/v1/authorizations?payment_id=nope");
    await c.rjunction("get unknown", "GET", "/v1/authorizations/JN000000000000");
    await c.rjunction("capture pending", "POST", `/v1/authorizations/${ref}/capture`, { amount: 500 });
    await c.rjunction("void", "POST", `/v1/authorizations/${ref}/void`);
    await c.rjunction("void again", "POST", `/v1/authorizations/${ref}/void`);
  }),
  scenario("junction-api/validation", async (c) => {
    await c.rjunction("unknown scenario", "POST", "/v1/authorizations", body({ scenario: "nope" }));
    await c.rjunction("string amount", "POST", "/v1/authorizations", body({ amount: "500" }));
    await c.rjunction("bad currency", "POST", "/v1/authorizations", body({ currency: "EUR" }));
    await c.rjunction("bad method", "POST", "/v1/authorizations", body({ method: "wallet" }));
  }),
  scenario("junction-api/capture-flow", async (c) => {
    // A real manual-capture payment: Platform holds it authorized, we drive Junction directly.
    const m = await c.merchant();
    const p = await c.paid(m, "card", { extra: { capture: "manual" } });
    const ref = (await c.internalPayment(p.id)).junction_ref as string;
    await c.rjunction("authorized", "GET", `/v1/authorizations/${ref}`);
    await c.rjunction("partial capture", "POST", `/v1/authorizations/${ref}/capture`, { amount: 100 });
    await c.rjunction("capture", "POST", `/v1/authorizations/${ref}/capture`, { amount: 49_900 });
    await c.rjunction("capture again", "POST", `/v1/authorizations/${ref}/capture`, { amount: 49_900 });
    await c.rjunction("void captured", "POST", `/v1/authorizations/${ref}/void`);
    await c.rjunction("bad capture body", "POST", `/v1/authorizations/${ref}/capture`, { amount: 0 });
  }),
];
