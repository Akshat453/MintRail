/** Refunds (M2): partials, limits, instant fee + GST, Junction outcomes, ledger effects, idempotency. */
import { describe, expect, test } from "vitest";
import fc from "fast-check";

import { LedgerService } from "@mintrail/ledger";

import type { Merchant } from "../src/testing.js";
import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();

const balance = async (m: Merchant): Promise<bigint> => {
  const r = await h().call(m, "GET", "/v1/balance?currency=INR");
  return r.body.balances[0].balance as bigint;
};
/** A second captured payment so the balance covers refunds of the gross amount (MDR is not returned). */
const fund = (m: Merchant) => h().paid(m, "upi", { amount: 200_000n });
const refund = (m: Merchant, paymentId: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}, key?: string) =>
  h().call(m, "POST", `/v1/payments/${paymentId}/refunds`, body, { headers, ...(key ? { idempotencyKey: key } : {}) });

describe("refunds", () => {
  test("full refund: pending → processed; balance and ledger move; events emitted", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card");
    await fund(m);
    const before = await balance(m);
    const r = await refund(m, p.id, { reason: "requested_by_customer" });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ object: "refund", status: "pending", amount: 49_900n, speed: "normal", fee: 0n, tax: 0n });
    expect(await balance(m)).toBe(before - 49_900n);
    await h().drain();
    const done = (await h().call(m, "GET", `/v1/refunds/${r.body.id}`)).body;
    expect(done.status).toBe("processed");
    expect(done.bank_reference).toMatch(/^RFN\d{12}$/);
    const txns = await new LedgerService(db()).transactionsForReference("refund", r.body.id);
    expect(txns.map((t) => t.idempotencyKey)).toEqual([`refund_initiated:${r.body.id}`, `refund_paid:${r.body.id}`]);
    const events = (await h().call(m, "GET", "/v1/events?limit=10")).body.data.map((e: { type: string }) => e.type);
    expect(events).toEqual(expect.arrayContaining(["refund.created", "refund.processed", "payment.captured"]));
  });

  test("multiple partials up to the captured amount, then MR_REFUND_AMOUNT_EXCEEDED", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "upi", { amount: 10_000n });
    await fund(m);
    expect((await refund(m, p.id, { amount: 3_000n })).status).toBe(201);
    expect((await refund(m, p.id, { amount: 4_000n })).status).toBe(201);
    const over = await refund(m, p.id, { amount: 3_001n });
    expect([over.status, over.body.error.code, over.body.error.details.refundable]).toEqual([422, "MR_REFUND_AMOUNT_EXCEEDED", 3_000n]);
    const rest = await refund(m, p.id, {});
    expect(rest.body.amount).toBe(3_000n);
    const none = await refund(m, p.id, {});
    expect([none.status, none.body.error.code]).toEqual([409, "MR_PAYMENT_NOT_REFUNDABLE"]);
    const list = (await h().call(m, "GET", `/v1/payments/${p.id}/refunds`)).body.data;
    expect(list.reduce((a: bigint, r: { amount: bigint }) => a + r.amount, 0n)).toBe(10_000n);
  });

  test("instant refunds charge fee + 18% GST to the merchant; netbanking cannot be instant", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card", { amount: 100_000n });
    const before = await balance(m);
    const r = await refund(m, p.id, { amount: 40_000n, speed: "instant" });
    // 50 bps of ₹400 = ₹2.00 fee, GST 18% = ₹0.36
    expect([r.body.fee, r.body.tax]).toEqual([200n, 36n]);
    expect(await balance(m)).toBe(before - 40_236n);
    const nb = await h().paid(m, "netbanking");
    const bad = await refund(m, nb.id, { speed: "instant" });
    expect([bad.status, bad.body.error.param]).toEqual([400, "speed"]);
  });

  test("a refund the bank fails returns the money (and the fee)", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card");
    await fund(m);
    const before = await balance(m);
    const r = await refund(m, p.id, { speed: "instant" }, { "MintRail-Test-Scenario": "refund_fail:account_closed" });
    await h().drain();
    const done = (await h().call(m, "GET", `/v1/refunds/${r.body.id}`)).body;
    expect([done.status, done.error_code]).toEqual(["failed", "account_closed"]);
    expect(await balance(m)).toBe(before);
    // and the amount is refundable again
    expect((await refund(m, p.id, {})).status).toBe(201);
  });

  test("only captured payments, only test-mode scenarios, idempotent replays", async () => {
    const m = await h().merchant();
    const o = await h().order(m);
    const pending = (await h().pay(m, o.id, "upi")).body;
    expect((await refund(m, pending.id)).body.error.code).toBe("MR_PAYMENT_NOT_REFUNDABLE");
    const p = await h().paid(m);
    const a = await refund(m, p.id, { amount: 100n }, {}, "rf-1");
    const b = await refund(m, p.id, { amount: 100n }, {}, "rf-1");
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.body.id).toBe(a.body.id);
    const other = await h().merchant();
    expect((await refund(other, p.id)).status).toBe(404);
  });

  test("refunds debit the gross amount: a lone payment cannot be fully refunded from its net", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card");
    const r = await refund(m, p.id);
    expect([r.status, r.body.error.code, r.body.error.details.available]).toEqual([422, "MR_INSUFFICIENT_BALANCE", 48_722n]);
  });

  test("insufficient balance blocks a refund instead of overdrawing", async () => {
    const m = await h().merchant();
    const p = await h().paid(m, "card", { amount: 10_000n });
    // a payout drains the balance below the refund amount
    const bal = await balance(m);
    const po = await h().call(m, "POST", "/v1/payouts", {
      amount: bal - 50n,
      mode: "IMPS",
      beneficiary: { name: "Supplier Co", account_number: "123456789012", ifsc: "HDFC0001234" },
    });
    expect(po.status).toBe(201);
    const r = await refund(m, p.id, { amount: 5_000n });
    expect([r.status, r.body.error.code]).toEqual([422, "MR_INSUFFICIENT_BALANCE"]);
  });
});

describe("property: refund totals never exceed the captured amount", () => {
  test("random sequences of refund requests", async () => {
    const m = await h().merchant();
    await h().paid(m, "upi", { amount: 900_000n });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.option(fc.bigInt({ min: 1n, max: 6_000n }), { nil: null }), { minLength: 1, maxLength: 6 }),
        async (amounts) => {
          const p = await h().paid(m, "card", { amount: 10_000n });
          let accepted = 0n;
          for (const a of amounts) {
            const r = await refund(m, p.id, a === null ? {} : { amount: a });
            if (r.status === 201) accepted += r.body.amount as bigint;
            else expect(["MR_REFUND_AMOUNT_EXCEEDED", "MR_PAYMENT_NOT_REFUNDABLE"]).toContain(r.body.error.code);
          }
          expect(accepted <= 10_000n).toBe(true);
        },
      ),
      { numRuns: 8 },
    );
  });
});
