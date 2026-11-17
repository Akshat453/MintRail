/** Ported from test_recipes_integration.py. */
import { sql } from "drizzle-orm";
import { expect, test, vi } from "vitest";

import { IdPrefix, log, Money, newId, type ClaimedJob, enqueue } from "@mintrail/shared";

import { ensureStationAccounts, ensureSystemAccounts, stationAccount, SystemAccount, systemAccount } from "../src/chart.js";
import { InsufficientBalanceError } from "../src/errors.js";
import { RECONCILE_BALANCES, reconcileBalances } from "../src/jobs.js";
import {
  computeCaptureBreakdown,
  recordCapture,
  recordRefundInitiated,
  recordRefundPaid,
  recordSettlementInitiated,
  recordSettlementPaid,
} from "../src/recipes.js";
import { LedgerService } from "../src/service.js";
import { useLedgerDb } from "../../tests/support/ledger.js";

const { db } = useLedgerDb();
const INR = "INR" as const;
const sys = (a: SystemAccount, c: "INR" | "USD" = INR, live = false) => systemAccount(a, c, live).code;
const bal = async (l: LedgerService, code: string) => (await l.balance((await l.getAccountByCode(code))!.id)).balance.amount;

test("full money flow", async () => {
  const mer = newId(IdPrefix.STATION);
  const b1 = computeCaptureBreakdown(Money.of(100_000n, INR), { feeBps: 200n });
  const b2 = computeCaptureBreakdown(Money.of(49_999n, INR), { feeBps: 200n });
  await db().transaction(async (tx) => {
    const l = new LedgerService(tx);
    await ensureStationAccounts(l, mer, INR, false);
    await recordCapture(l, { stationId: mer, paymentId: "pay_1", breakdown: b1, livemode: false });
    await recordCapture(l, { stationId: mer, paymentId: "pay_2", breakdown: b2, livemode: false });
  });
  const l = new LedgerService(db());
  const merchant = stationAccount(mer, INR, false).code;
  const net = b1.net.amount + b2.net.amount;
  expect(await bal(l, merchant)).toBe(net);
  expect(await bal(l, sys(SystemAccount.CUSTOMER_FUNDS))).toBe(149_999n);
  expect(await bal(l, sys(SystemAccount.MINTRAIL_FEES))).toBe(b1.fee.amount + b2.fee.amount);
  expect(await bal(l, sys(SystemAccount.GST_PAYABLE))).toBe(b1.tax.amount + b2.tax.amount);

  const refund = Money.of(10_000n, INR);
  const remaining = Money.of(net, INR).sub(refund);
  await db().transaction(async (tx) => {
    const t = new LedgerService(tx);
    await recordRefundInitiated(t, { stationId: mer, refundId: "rfd_1", amount: refund, livemode: false });
    expect(await bal(t, sys(SystemAccount.REFUNDS_PAYABLE))).toBe(10_000n);
    await recordRefundPaid(t, { refundId: "rfd_1", amount: refund, livemode: false });
    await recordSettlementInitiated(t, { stationId: mer, settlementId: "stl_1", amount: remaining, livemode: false });
    expect(await bal(t, sys(SystemAccount.SETTLEMENT_CLEARING))).toBe(remaining.amount);
    await recordSettlementPaid(t, { settlementId: "stl_1", amount: remaining, livemode: false });
  });
  expect(await bal(l, merchant)).toBe(0n);
  expect(await bal(l, sys(SystemAccount.REFUNDS_PAYABLE))).toBe(0n);
  expect(await bal(l, sys(SystemAccount.SETTLEMENT_CLEARING))).toBe(0n);
  // What's left in the nodal account is exactly MintRail's fees + GST owed.
  expect(await bal(l, sys(SystemAccount.CUSTOMER_FUNDS))).toBe(b1.fee.amount + b2.fee.amount + b1.tax.amount + b2.tax.amount);
  expect((await l.trialBalance(INR, false)).isBalanced).toBe(true);
  expect(await l.reconcile()).toEqual([]);
});

test("recipes are idempotent", async () => {
  const mer = newId(IdPrefix.STATION);
  const b = computeCaptureBreakdown(Money.of(10_000n, INR), { feeBps: 200n });
  const first = await db().transaction((tx) =>
    recordCapture(new LedgerService(tx), { stationId: mer, paymentId: "pay_x", breakdown: b, livemode: false }),
  );
  const again = await db().transaction((tx) =>
    recordCapture(new LedgerService(tx), { stationId: mer, paymentId: "pay_x", breakdown: b, livemode: false }),
  );
  expect(again.id).toBe(first.id);
  expect(again.replayed).toBe(true);
});

test("zero-fee capture omits zero lines", async () => {
  const b = computeCaptureBreakdown(Money.of(10_000n, INR), { feeBps: 0n });
  const posted = await db().transaction((tx) =>
    recordCapture(new LedgerService(tx), { stationId: newId(IdPrefix.STATION), paymentId: "pay_free", breakdown: b, livemode: false }),
  );
  expect(posted.lines).toHaveLength(2);
});

test("cannot refund more than merchant balance", async () => {
  const mer = newId(IdPrefix.STATION);
  await expect(
    db().transaction(async (tx) => {
      const l = new LedgerService(tx);
      await ensureStationAccounts(l, mer, INR, false);
      await recordRefundInitiated(l, { stationId: mer, refundId: "rfd_x", amount: Money.of(1n, INR), livemode: false });
    }),
  ).rejects.toThrow(InsufficientBalanceError);
});

test("USD and INR are separate books", async () => {
  const mer = newId(IdPrefix.STATION);
  const usd = computeCaptureBreakdown(Money.of(5_000n, "USD"), { feeBps: 300n });
  await db().transaction((tx) =>
    recordCapture(new LedgerService(tx), { stationId: mer, paymentId: "pay_usd", breakdown: usd, livemode: false }),
  );
  const l = new LedgerService(db());
  expect(await bal(l, stationAccount(mer, "USD", false).code)).toBe(usd.net.amount);
  expect((await l.trialBalance("USD", false)).isBalanced).toBe(true);
  expect((await l.trialBalance(INR, false)).debits.isZero()).toBe(true);
});

test("test and live money are separate", async () => {
  const mer = newId(IdPrefix.STATION);
  const b = computeCaptureBreakdown(Money.of(10_000n, INR), { feeBps: 200n });
  await db().transaction((tx) =>
    recordCapture(new LedgerService(tx), { stationId: mer, paymentId: "pay_t", breakdown: b, livemode: false }),
  );
  const l = new LedgerService(db());
  const live = await l.ensureAccount(stationAccount(mer, INR, true));
  expect((await l.balance(live.id)).balance.isZero()).toBe(true);
  expect(await l.balancesForOwner(mer, false)).toHaveLength(1);
});

test("chart provisioning", async () => {
  const l = new LedgerService(db());
  const accounts = await ensureSystemAccounts(l, INR, true);
  expect(Object.keys(accounts).sort()).toEqual(Object.values(SystemAccount).sort());
  expect(accounts.customer_funds.code).toBe("platform:live:customer_funds:INR");
  const mer = newId(IdPrefix.STATION);
  const station = await ensureStationAccounts(l, mer, INR, true);
  expect(station.merchant_balance.code).toBe(`station:${mer}:live:merchant_balance:INR`);
});

test("reconcile job flags a Derailment", async () => {
  const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
  const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
  const mer = newId(IdPrefix.STATION);
  const b = computeCaptureBreakdown(Money.of(10_000n, INR), { feeBps: 200n });
  await db().transaction(async (tx) => {
    await recordCapture(new LedgerService(tx), { stationId: mer, paymentId: "pay_rc", breakdown: b, livemode: false });
    await enqueue(tx, RECONCILE_BALANCES, {}, { queue: "ledger" });
  });
  const job: ClaimedJob = { id: 1n, queue: "ledger", kind: RECONCILE_BALANCES, payload: {}, attempts: 1, maxAttempts: 10 };
  await reconcileBalances(db(), job);
  expect(info).toHaveBeenCalledWith(expect.anything(), "ledger balances reconciled");
  expect(error).not.toHaveBeenCalled();
  // Someone "fixes" a balance by hand, bypassing the ledger.
  await db().execute(sql`UPDATE ledger_balances SET debits_total = debits_total + 1`);
  await reconcileBalances(db(), job);
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ derailment: "ledger_balance_drift" }),
    "DERAILMENT: ledger balance cache drift detected",
  );
});
