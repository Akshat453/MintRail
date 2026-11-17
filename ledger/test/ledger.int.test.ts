/** Ported from test_ledger_integration.py. */
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { ConflictError, CurrencyMismatchError, InvalidRequestError, Money } from "@mintrail/shared";

import {
  AccountExistsError,
  AccountNotFoundError,
  AlreadyReversedError,
  IdempotencyConflictError,
  InsufficientBalanceError,
  TransactionNotFoundError,
} from "../src/errors.js";
import { credit, debit, LedgerService, type TransactionRequest } from "../src/service.js";
import { pgError } from "../../tests/support/db.js";
import { useLedgerDb } from "../../tests/support/ledger.js";

const { db, ledger, account } = useLedgerDb();
const INR = "INR";

const transfer = (src: { id: string; currency: string }, dst: { id: string }, amount: bigint, key: string): TransactionRequest => ({
  idempotencyKey: key,
  description: `transfer ${key}`,
  // Liability wallets: debiting src lowers its balance, crediting dst raises it.
  lines: [debit(src.id, Money.of(amount, src.currency)), credit(dst.id, Money.of(amount, src.currency))],
});

const post = (req: TransactionRequest) => db().transaction((tx) => new LedgerService(tx).post(req));

async function funded() {
  const equity = await account("equity", { allowNegative: true });
  const wallet = await account("liability");
  await post({
    idempotencyKey: "fund-1",
    description: "opening funds",
    lines: [debit(equity, Money.of(10_000n, INR)), credit(wallet, Money.of(10_000n, INR))],
  });
  return { equity, wallet };
}

describe("accounts", () => {
  test("create and duplicate", async () => {
    const a = await account("asset", { code: "dup:code" });
    expect(a.id.startsWith("lac_")).toBe(true);
    await expect(account("asset", { code: "dup:code" })).rejects.toThrow(AccountExistsError);
  });
  test("ensure is get-or-create", async () => {
    const spec = { code: "x:1", name: "x", type: "asset" as const, currency: "INR" as const, livemode: false };
    const a = await ledger().ensureAccount(spec);
    const b = await ledger().ensureAccount(spec);
    expect(a.id).toBe(b.id);
  });
  test("ensure rejects conflicting definition", async () => {
    await ledger().ensureAccount({ code: "x:2", name: "x", type: "asset", currency: "INR", livemode: false });
    await expect(ledger().ensureAccount({ code: "x:2", name: "x", type: "liability", currency: "INR", livemode: false })).rejects.toThrow(
      ConflictError,
    );
  });
  test("ensure is safe under concurrent callers", async () => {
    const spec = { code: "race:1", name: "x", type: "asset" as const, currency: "INR" as const, livemode: false };
    const ids = await Promise.all(Array.from({ length: 8 }, () => db().transaction((tx) => new LedgerService(tx).ensureAccount(spec))));
    expect(new Set(ids.map((a) => a.id)).size).toBe(1);
  });
  test("new account has zero balance; unknown account", async () => {
    const a = await account();
    expect((await ledger().balance(a.id)).balance.isZero()).toBe(true);
    await expect(ledger().balance("lac_doesnotexist")).rejects.toThrow(AccountNotFoundError);
  });
});

describe("posting", () => {
  test("post updates both sides", async () => {
    const { equity, wallet } = await funded();
    expect((await ledger().balance(wallet.id)).balance.amount).toBe(10_000n);
    expect((await ledger().balance(equity.id)).balance.amount).toBe(-10_000n);
  });
  test("posted transaction shape", async () => {
    const { wallet } = await funded();
    const other = await account("liability");
    const posted = await post(transfer(wallet, other, 2_500n, "t1"));
    expect(posted.id.startsWith("ltx_")).toBe(true);
    expect(posted.replayed).toBe(false);
    expect(posted.lines).toHaveLength(2);
    expect((await ledger().getTransaction(posted.id)).lines).toEqual(posted.lines);
    await expect(ledger().getTransaction("ltx_missing")).rejects.toThrow(TransactionNotFoundError);
  });
  test("insufficient balance", async () => {
    const { wallet } = await funded();
    const other = await account("liability");
    try {
      await post(transfer(wallet, other, 10_001n, "too-much"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientBalanceError);
      expect((e as InsufficientBalanceError).details.available).toBe(10_000n);
    }
    expect((await ledger().balance(wallet.id)).balance.amount).toBe(10_000n);
  });
  test("exact balance can be spent", async () => {
    const { wallet } = await funded();
    await post(transfer(wallet, await account("liability"), 10_000n, "all-of-it"));
    expect((await ledger().balance(wallet.id)).balance.isZero()).toBe(true);
  });
  test("currency mismatch", async () => {
    const a = await account("equity", { allowNegative: true });
    const b = await account("liability", { currency: "USD" });
    await expect(
      post({ idempotencyKey: "cm", description: "x", lines: [debit(a, Money.of(1n, INR)), credit(b, Money.of(1n, INR))] }),
    ).rejects.toThrow(CurrencyMismatchError);
  });
  test("mixing modes rejected", async () => {
    const a = await account("equity", { allowNegative: true });
    const b = await account("liability", { livemode: true });
    await expect(
      post({ idempotencyKey: "mm", description: "x", lines: [debit(a, Money.of(1n, INR)), credit(b, Money.of(1n, INR))] }),
    ).rejects.toThrow(/test-mode and live-mode/);
  });
  test("frozen account rejected", async () => {
    const { wallet } = await funded();
    await ledger().setAccountStatus(wallet.id, "frozen");
    await expect(post(transfer(wallet, await account("liability"), 1n, "frozen"))).rejects.toThrow(/frozen/);
  });
  test("unknown account in posting", async () => {
    const a = await account("equity", { allowNegative: true });
    await expect(
      post({ idempotencyKey: "ua", description: "x", lines: [debit(a, Money.of(1n, INR)), credit("lac_nope", Money.of(1n, INR))] }),
    ).rejects.toThrow(AccountNotFoundError);
  });
  test("trial balance and reference lookup", async () => {
    const { wallet } = await funded();
    const other = await account("liability");
    await post({ ...transfer(wallet, other, 5n, "ref-1"), referenceType: "payment", referenceId: "pay_x" });
    const tb = await ledger().trialBalance(INR, false);
    expect(tb.isBalanced).toBe(true);
    expect(tb.debits.amount).toBe(10_005n);
    expect((await ledger().transactionsForReference("payment", "pay_x")).map((t) => t.idempotencyKey)).toEqual(["ref-1"]);
  });
});

describe("idempotency", () => {
  test("replay returns the same transaction", async () => {
    const { wallet } = await funded();
    const other = await account("liability");
    const first = await post(transfer(wallet, other, 100n, "idem"));
    const second = await post(transfer(wallet, other, 100n, "idem"));
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    expect((await ledger().balance(other.id)).balance.amount).toBe(100n);
  });
  test("key reuse with a different body", async () => {
    const { wallet } = await funded();
    const other = await account("liability");
    await post(transfer(wallet, other, 100n, "idem2"));
    await expect(post(transfer(wallet, other, 101n, "idem2"))).rejects.toThrow(IdempotencyConflictError);
  });
  test("concurrent same-key writes apply once", async () => {
    const { wallet } = await funded();
    const other = await account("liability");
    const results = await Promise.all(Array.from({ length: 6 }, () => post(transfer(wallet, other, 700n, "race-key"))));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await ledger().balance(other.id)).balance.amount).toBe(700n);
  });
});

describe("reversal", () => {
  const reverse = (id: string, key: string) => db().transaction((tx) => new LedgerService(tx).reverse(id, { idempotencyKey: key }));
  test("reverse restores balances", async () => {
    const { wallet } = await funded();
    const other = await account("liability");
    const posted = await post(transfer(wallet, other, 400n, "to-reverse"));
    const rev = await reverse(posted.id, "rev-1");
    expect(rev.reversesId).toBe(posted.id);
    expect((await ledger().balance(wallet.id)).balance.amount).toBe(10_000n);
    expect((await ledger().balance(other.id)).balance.isZero()).toBe(true);
  });
  test("reverse twice", async () => {
    const { wallet } = await funded();
    const posted = await post(transfer(wallet, await account("liability"), 400n, "rr"));
    const first = await reverse(posted.id, "rev-a");
    expect((await reverse(posted.id, "rev-a")).id).toBe(first.id);
    await expect(reverse(posted.id, "rev-b")).rejects.toThrow(AlreadyReversedError);
  });
  test("cannot reverse a reversal", async () => {
    const { wallet } = await funded();
    const posted = await post(transfer(wallet, await account("liability"), 1n, "rrr"));
    const rev = await reverse(posted.id, "rev-x");
    await expect(reverse(rev.id, "rev-y")).rejects.toThrow(InvalidRequestError);
  });
  test("reverse respects funds", async () => {
    const { wallet } = await funded();
    const other = await account("liability");
    const third = await account("liability");
    const posted = await post(transfer(wallet, other, 500n, "in"));
    await post(transfer(other, third, 500n, "onward"));
    await expect(reverse(posted.id, "rev-in")).rejects.toThrow(InsufficientBalanceError);
  });
  test("reverse unknown", async () => {
    await expect(reverse("ltx_missing", "k")).rejects.toThrow(TransactionNotFoundError);
  });
});

describe("database invariants (enforced even if application code is bypassed)", () => {
  const rawTxn = (txnId: string) =>
    sql`INSERT INTO ledger_transactions (id, idempotency_key, fingerprint, description, livemode, effective_at) VALUES (${txnId}, ${txnId}, 'f', 'raw', false, now())`;
  const rawPosting = (txnId: string, accountId: string, direction: string, amount: bigint, currency = "INR") =>
    sql`INSERT INTO ledger_postings (transaction_id, account_id, direction, amount, currency) VALUES (${txnId}, ${accountId}, ${direction}, ${amount}, ${currency})`;

  test("unbalanced rejected at commit", async () => {
    const a = await account();
    const b = await account();
    const e = await pgError(
      db().transaction(async (tx) => {
        await tx.execute(rawTxn("ltx_raw1"));
        await tx.execute(rawPosting("ltx_raw1", a.id, "debit", 100n));
        await tx.execute(rawPosting("ltx_raw1", b.id, "credit", 90n));
      }),
    );
    expect(e.message).toMatch(/MR_UNBALANCED_TRANSACTION/);
  });
  test("transaction without postings rejected", async () => {
    expect((await pgError(db().transaction((tx) => tx.execute(rawTxn("ltx_raw2"))))).message).toMatch(/MR_UNBALANCED_TRANSACTION/);
  });
  test("posting currency must match account", async () => {
    const a = await account();
    const e = await pgError(
      db().transaction(async (tx) => {
        await tx.execute(rawTxn("ltx_raw3"));
        await tx.execute(rawPosting("ltx_raw3", a.id, "debit", 100n, "USD"));
      }),
    );
    expect(e.message).toMatch(/MR_CURRENCY_MISMATCH/);
  });
  test("postings are immutable", async () => {
    await funded();
    expect((await pgError(db().execute(sql`UPDATE ledger_postings SET amount = amount + 1`))).message).toMatch(/append-only/);
    expect((await pgError(db().execute(sql`DELETE FROM ledger_transactions`))).message).toMatch(/append-only/);
  });
  test("reconcile detects cache drift", async () => {
    expect(await ledger().reconcile()).toEqual([]);
    const { wallet } = await funded();
    await db().execute(sql`UPDATE ledger_balances SET credits_total = credits_total + 1 WHERE account_id = ${wallet.id}`);
    const [drift] = await ledger().reconcile();
    expect(drift!.account_id).toBe(wallet.id);
    expect(drift!.cached_credits).toBe(drift!.actual_credits + 1n);
  });
});

test("concurrent spends never overdraw: 20 × ₹10 from ₹100 → exactly 10 succeed", async () => {
  const { wallet } = await funded();
  const sinks = await Promise.all([1, 2, 3, 4].map(() => account("liability")));
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => post(transfer(wallet, sinks[i % 4]!, 1_000n, `spend-${i}`))),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  const refused = results.filter((r) => r.status === "rejected");
  expect(refused).toHaveLength(10);
  expect(refused.every((r) => (r as PromiseRejectedResult).reason instanceof InsufficientBalanceError)).toBe(true);
  expect((await ledger().balance(wallet.id)).balance.isZero()).toBe(true);
  expect((await ledger().trialBalance(INR, false)).isBalanced).toBe(true);
  expect(await ledger().reconcile()).toEqual([]);
});
