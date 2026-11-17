/** Ledger rules that don't need a database (ported from test_ledger_unit.py). */
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { InvalidAmountError, InvalidRequestError, Money } from "@mintrail/shared";

import { UnbalancedTransactionError } from "../src/errors.js";
import { pyJsonDumps } from "../src/pyjson.js";
import { computeCaptureBreakdown } from "../src/recipes.js";
import {
  credit,
  debit,
  fingerprint,
  flipped,
  normalBalance,
  type PostingLine,
  type TransactionRequest,
  validateShape,
} from "../src/service.js";

const INR = "INR";
const req = (lines: PostingLine[], key = "k1", description = "test"): TransactionRequest => ({ idempotencyKey: key, description, lines });

describe("shape validation", () => {
  test("balanced ok", () => {
    validateShape(req([debit("a", Money.of(100n, INR)), credit("b", Money.of(100n, INR))]));
  });
  test("single line rejected", () => {
    expect(() => validateShape(req([debit("a", Money.of(100n, INR))]))).toThrow(UnbalancedTransactionError);
  });
  test("unbalanced rejected with details", () => {
    try {
      validateShape(req([debit("a", Money.of(100n, INR)), credit("b", Money.of(99n, INR))]));
      expect.unreachable();
    } catch (e) {
      expect((e as UnbalancedTransactionError).details).toEqual({ net_by_currency: { INR: 1n } });
    }
  });
  test("balanced overall but not per currency", () => {
    expect(() => validateShape(req([debit("a", Money.of(100n, INR)), credit("b", Money.of(100n, "USD"))]))).toThrow(
      UnbalancedTransactionError,
    );
  });
  test.each([0n, -5n])("non-positive amounts rejected: %s", (amount) => {
    expect(() => validateShape(req([debit("a", Money.of(amount, INR)), credit("b", Money.of(amount, INR))]))).toThrow(InvalidAmountError);
  });
  test.each(["", "x".repeat(256)])("idempotency key length", (key) => {
    expect(() => validateShape(req([debit("a", Money.of(1n, INR)), credit("b", Money.of(1n, INR))], key))).toThrow(InvalidRequestError);
  });
  test("description required", () => {
    expect(() => validateShape(req([debit("a", Money.of(1n, INR)), credit("b", Money.of(1n, INR))], "k", "  "))).toThrow(
      InvalidRequestError,
    );
  });
  test("too many lines", () => {
    const lines = Array.from({ length: 101 }, (_, i) => (i % 2 ? credit("b", Money.of(1n, INR)) : debit("a", Money.of(1n, INR))));
    expect(() => validateShape(req(lines))).toThrow(/at most 100 postings/);
  });
});

describe("fingerprint", () => {
  test("line order does not matter", () => {
    const a = req([debit("a", Money.of(1n, INR)), credit("b", Money.of(1n, INR))]);
    const b = req([credit("b", Money.of(1n, INR)), debit("a", Money.of(1n, INR))]);
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
  test("amount changes fingerprint", () => {
    expect(fingerprint(req([debit("a", Money.of(1n, INR)), credit("b", Money.of(1n, INR))]))).not.toBe(
      fingerprint(req([debit("a", Money.of(2n, INR)), credit("b", Money.of(2n, INR))])),
    );
  });
  test("metadata ignored", () => {
    const lines = [debit("a", Money.of(1n, INR)), credit("b", Money.of(1n, INR))];
    expect(fingerprint({ ...req(lines), metadata: { x: 1 } })).toBe(fingerprint({ ...req(lines), metadata: { x: 2 } }));
  });
  test("byte-identical to M1 (values computed by the Python implementation)", () => {
    const lines = [credit("lac_b", Money.of(1000n, INR)), debit("lac_a", Money.of(1000n, INR))];
    expect(
      fingerprint({ idempotencyKey: "capture:pay_x", description: "Capture pay_x", lines, referenceType: "payment", referenceId: "pay_x" }),
    ).toBe("92d77ac4292f067bc09a8cd3f87b7a39966839bee97e3a9edd16e200e9b180f4");
    const multi = [
      debit("lac_a", Money.of(5n, "USD")),
      credit("lac_b", Money.of(5n, "USD")),
      debit("lac_a", Money.of(7n, INR)),
      credit("lac_c", Money.of(7n, INR)),
    ];
    expect(fingerprint({ idempotencyKey: "k", description: 'Réversal ✓ "q"', lines: multi, reversesId: "ltx_1" })).toBe(
      "484ce74f0a508ad09050b6046664f4bfe778ec5389660733b6bcf7a8bb8836a2",
    );
    expect(pyJsonDumps({ b: [1n, "é"], a: null, c: true })).toBe('{"a":null,"b":[1,"\\u00e9"],"c":true}');
  });
});

test("normal balance sides", () => {
  expect(normalBalance("asset", 100n, 30n)).toBe(70n);
  expect(normalBalance("expense", 100n, 30n)).toBe(70n);
  expect(normalBalance("liability", 100n, 30n)).toBe(-70n);
  expect(normalBalance("revenue", 0n, 30n)).toBe(30n);
});

test("direction flip", () => {
  expect(flipped("debit")).toBe("credit");
  expect(flipped("credit")).toBe("debit");
});

describe("capture breakdown", () => {
  test("standard MDR with GST", () => {
    const b = computeCaptureBreakdown(Money.of(100_000n, INR), { feeBps: 200n });
    expect([b.fee.amount, b.tax.amount, b.net.amount]).toEqual([2000n, 360n, 97640n]);
  });
  test("fixed fee", () => {
    const b = computeCaptureBreakdown(Money.of(10_000n, INR), { feeBps: 0n, fixedFee: Money.of(300n, INR) });
    expect([b.fee.amount, b.tax.amount]).toEqual([300n, 54n]);
  });
  test("fee rounds half up", () => {
    expect(computeCaptureBreakdown(Money.of(125n, INR), { feeBps: 200n }).fee.amount).toBe(3n);
  });
  test("fees exceeding gross rejected", () => {
    expect(() => computeCaptureBreakdown(Money.of(100n, INR), { feeBps: 0n, fixedFee: Money.of(100n, INR) })).toThrow(InvalidAmountError);
  });
  test.each([-1n, 10_001n])("bps bounds %s", (bps) => {
    expect(() => computeCaptureBreakdown(Money.of(100n, INR), { feeBps: bps })).toThrow(InvalidAmountError);
  });
  test("non-positive gross", () => {
    expect(() => computeCaptureBreakdown(Money.of(0n, INR), { feeBps: 200n })).toThrow(InvalidAmountError);
  });
  test("matches every M1 vector", async () => {
    const { vectors } = await import("../../packages/shared/test/vectors.js");
    for (const v of vectors.capture_breakdown!) {
      const b = computeCaptureBreakdown(Money.of(BigInt(v.gross), INR), { feeBps: BigInt(v.fee_bps) });
      expect([b.fee.amount, b.tax.amount, b.net.amount].map(String)).toEqual([v.fee, v.tax, v.net]);
    }
  });
  test("property: components always sum to gross", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.bigInt({ min: 0n, max: 5_000n }), (gross, bps) => {
        const b = computeCaptureBreakdown(Money.of(gross, INR), { feeBps: bps });
        return b.net.add(b.fee).add(b.tax).equals(b.gross) && !b.net.isNegative() && !b.fee.isNegative();
      }),
    );
  });
});
