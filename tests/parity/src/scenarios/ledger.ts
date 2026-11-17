import { scenario } from "../scenario.js";

export default [
  scenario("ledger/mixed-traffic-reconciles", async (c) => {
    const m = await c.merchant();
    await c.paid(m, "upi", { scenario: "success" });
    await c.paid(m, "card", { scenario: "decline:card_declined" });
    await c.paid(m, "card", { scenario: "duplicate_callbacks" });
    await c.paid(m, "upi", { scenario: "out_of_order" });
    await c.rstaff("trial balance", "GET", "/internal/v1/ledger/trial_balance", undefined, "finance");
    await c.rstaff("trial balance live", "GET", "/internal/v1/ledger/trial_balance?livemode=true", undefined, "finance");
    await c.rstaff("trial balance usd", "GET", "/internal/v1/ledger/trial_balance?currency=USD", undefined, "finance");
    await c.rstaff("reconcile", "GET", "/internal/v1/ledger/reconcile", undefined, "finance");
    await c.rcall("balance", m, "GET", "/v1/balance");
  }),
  scenario("ledger/fee-plans", async (c) => {
    for (const plan of ["standard", "growth", "enterprise"]) {
      const m = await c.merchant({ settings: { fee_plan: plan } });
      for (const method of ["upi", "card", "netbanking"] as const) {
        c.note(`${plan}/${method}`, await c.paid(m, method, { amount: 1_23_457n }));
      }
    }
  }),
  scenario("ledger/reconcile-detects-drift", async (c) => {
    const m = await c.merchant();
    await c.paid(m);
    await c.sql(
      "UPDATE ledger_balances SET debits_total = debits_total + 1 WHERE account_id IN (SELECT id FROM ledger_accounts WHERE owner_id = $1)",
      [m.stationId],
    );
    await c.rstaff("drift", "GET", "/internal/v1/ledger/reconcile", undefined, "finance");
  }),
  scenario("ledger/append-only", async (c) => {
    const m = await c.merchant();
    await c.paid(m);
    for (const [name, q] of [
      ["update posting", "UPDATE ledger_postings SET amount = amount + 1"],
      ["delete transaction", "DELETE FROM ledger_transactions"],
      ["update audit", "UPDATE staff_audit_log SET action = 'x'"],
    ] as const) {
      try {
        await c.sql(q);
        c.note(name, "allowed");
      } catch (e) {
        c.note(name, (e as { code?: string }).code);
      }
    }
  }),
];
