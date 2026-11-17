/** M1 acceptance: merchant → signed API request → UPI payment via Junction → ledger balances. */
import { expect, test } from "vitest";

import { LedgerService } from "@mintrail/ledger";

import { useHarness } from "../support/harness.js";

const { h, db } = useHarness();

test("signed UPI payment through Junction balances the ledger", async () => {
  const m = await h().merchant();
  let r = await h().call(
    m,
    "POST",
    "/v1/orders",
    { amount: 1_49_900n, currency: "INR", receipt: "rcpt_42", notes: { sku: "beans" } },
    { signed: true },
  );
  expect(r.status, r.text).toBe(201);
  let order = r.body;

  r = await h().call(
    m,
    "POST",
    "/v1/payments",
    { order_id: order.id, method: "upi", upi: { vpa: "asha.k@okmintrail" } },
    { signed: true, headers: { "MintRail-Test-Scenario": "success" } },
  );
  expect(r.status, r.text).toBe(201);
  let payment = r.body;
  expect(payment.status).toBe("created");
  expect(payment.risk.decision).toBe("allow");

  await h().drain();

  payment = await h().payment(m, payment.id);
  expect(payment.status).toBe("captured");
  expect(payment.fee).toBe(1_499n); // standard plan, UPI 1% + 18% GST
  expect(payment.tax).toBe(270n);
  order = (await h().call(m, "GET", `/v1/orders/${order.id}`, undefined, { signed: true })).body;
  expect(order.status).toBe("paid");
  expect(order.amount_paid).toBe(1_49_900n);

  const balance = (await h().call(m, "GET", "/v1/balance", undefined, { signed: true })).body;
  expect(balance.balances).toEqual([{ currency: "INR", balance: 1_49_900n - 1_499n - 270n }]);

  const ledger = new LedgerService(db());
  expect((await ledger.trialBalance("INR", false)).isBalanced).toBe(true);
  expect(await ledger.reconcile()).toEqual([]);
  const [txn] = await ledger.transactionsForReference("payment", payment.id);
  expect(txn!.lines.filter((l) => l.direction === "debit").reduce((a, l) => a + l.amount.amount, 0n)).toBe(1_49_900n);
});
