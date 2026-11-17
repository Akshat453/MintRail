import { nowSeconds } from "../http.js";
import { scenario } from "../scenario.js";

const CB = "/internal/junction/v1/callbacks";

export default [
  scenario("callbacks/missing-signature", async (c) => {
    await c.record("no signature", "POST", CB, await c.postCallback({ id: "x" }, { signature: null }));
  }),
  scenario("callbacks/forged-signature", async (c) => {
    await c.record("wrong secret", "POST", CB, await c.postCallback({ id: "x" }, { secret: "not-the-secret" }));
  }),
  scenario("callbacks/stale-timestamp", async (c) => {
    await c.record("hour old", "POST", CB, await c.postCallback({ id: "x" }, { ts: nowSeconds() - 3600 }));
  }),
  scenario("callbacks/garbage-signature-header", async (c) => {
    await c.record("garbage", "POST", CB, await c.postCallback({ id: "x" }, { signature: "nonsense" }));
  }),
  scenario("callbacks/missing-fields", async (c) => {
    await c.record("missing fields", "POST", CB, await c.postCallback({ id: "x" }));
  }),
  scenario("callbacks/unknown-payment", async (c) => {
    await c.record(
      "unknown payment",
      "POST",
      CB,
      await c.postCallback({
        id: "jev_x_1",
        type: "authorization.succeeded",
        sequence: 1,
        ref: "JN000000000000",
        payment_id: "pay_00000000000000000000000000",
      }),
    );
  }),
  scenario("callbacks/bank-failure-after-capture-ignored", async (c) => {
    const m = await c.merchant();
    const p = await c.paid(m);
    const ref = (await c.internalPayment(p.id)).junction_ref as string;
    await c.record(
      "failure after capture",
      "POST",
      CB,
      await c.postCallback({
        id: `jev_${ref}_9`,
        type: "authorization.failed",
        sequence: 9,
        ref,
        payment_id: p.id,
        decline_code: "card_declined",
      }),
    );
    await c.rcall("still captured", m, "GET", `/v1/payments/${p.id}`);
  }),
  scenario("callbacks/duplicate-delivery-acknowledged", async (c) => {
    const m = await c.merchant();
    const p = await c.paid(m);
    const ref = (await c.internalPayment(p.id)).junction_ref as string;
    await c.record(
      "replay of applied event",
      "POST",
      CB,
      await c.postCallback({
        id: `jev_${ref}_2`,
        type: "authorization.succeeded",
        sequence: 2,
        ref,
        payment_id: p.id,
      }),
    );
  }),
  scenario("callbacks/unknown-event-type", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const r = await c.pay(m, o.id, "upi", { scenario: "timeout" });
    await c.settle();
    const id = (r.body as { id: string }).id;
    const ref = (await c.internalPayment(id)).junction_ref as string;
    await c.record(
      "unknown type",
      "POST",
      CB,
      await c.postCallback({
        id: `jev_${ref}_5`,
        type: "authorization.teleported",
        sequence: 5,
        ref,
        payment_id: id,
      }),
    );
  }),
  scenario("callbacks/early-failure-for-created-payment", async (c) => {
    const m = await c.merchant();
    const o = await c.order(m);
    const r = await c.pay(m, o.id, "upi", { scenario: "timeout" });
    await c.settle();
    const id = (r.body as { id: string }).id;
    const ref = (await c.internalPayment(id)).junction_ref as string;
    await c.record(
      "decline via callback",
      "POST",
      CB,
      await c.postCallback({
        id: `jev_${ref}_2`,
        type: "authorization.failed",
        sequence: 2,
        ref,
        payment_id: id,
        decline_code: "insufficient_funds",
        decline_reason: "Insufficient funds in the customer's account",
      }),
    );
    await c.rcall("failed", m, "GET", `/v1/payments/${id}`);
  }),
];
