/** fast-check (ported from Hypothesis): any sequence of transfers keeps the books whole. */
import fc from "fast-check";
import { expect, test } from "vitest";

import { Money } from "@mintrail/shared";

import { InsufficientBalanceError } from "../src/errors.js";
import { credit, debit, LedgerService } from "../src/service.js";
import { truncateAll } from "../../tests/support/db.js";
import { useLedgerDb } from "../../tests/support/ledger.js";

const { db } = useLedgerDb();
const N = 5;

test("every journal balances; cached balances match postings; wallets never go negative", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc
          .tuple(fc.integer({ min: 0, max: N - 1 }), fc.integer({ min: 0, max: N - 1 }), fc.bigInt({ min: 1n, max: 5_000n }))
          .filter(([a, b]) => a !== b),
        { minLength: 1, maxLength: 25 },
      ),
      async (ops) => {
        await truncateAll(db());
        const setup = await db().transaction(async (tx) => {
          const l = new LedgerService(tx);
          const source = await l.createAccount({
            code: "prop:equity",
            name: "eq",
            type: "equity",
            currency: "INR",
            livemode: false,
            allowNegative: true,
          });
          const wallets = [];
          for (let i = 0; i < N; i++)
            wallets.push(await l.createAccount({ code: `prop:w${i}`, name: `w${i}`, type: "liability", currency: "INR", livemode: false }));
          await l.post({
            idempotencyKey: "seed",
            description: "seed",
            lines: [debit(source, Money.of(5_000n * BigInt(N), "INR")), ...wallets.map((w) => credit(w, Money.of(5_000n, "INR")))],
          });
          return wallets;
        });
        const model = Array.from({ length: N }, () => 5_000n);
        for (const [n, [src, dst, amt]] of ops.entries()) {
          try {
            await db().transaction((tx) =>
              new LedgerService(tx).post({
                idempotencyKey: `op-${n}`,
                description: "op",
                lines: [debit(setup[src]!, Money.of(amt, "INR")), credit(setup[dst]!, Money.of(amt, "INR"))],
              }),
            );
            model[src]! -= amt;
            model[dst]! += amt;
          } catch (e) {
            if (!(e instanceof InsufficientBalanceError)) throw e;
            expect(model[src]! < amt).toBe(true);
          }
        }
        const ledger = new LedgerService(db());
        const actual = await Promise.all(setup.map(async (w) => (await ledger.balance(w.id)).balance.amount));
        expect(actual).toEqual(model);
        expect(actual.every((b) => b >= 0n)).toBe(true);
        expect((await ledger.trialBalance("INR", false)).isBalanced).toBe(true);
        expect(await ledger.reconcile()).toEqual([]);
      },
    ),
    { numRuns: 30 },
  );
});
