import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { CurrencyMismatchError, ErrorCode, InvalidAmountError, UnsupportedCurrencyError } from "../src/errors.js";
import { CURRENCIES, type Currency, divRound, Money, ROUNDINGS, type Rounding } from "../src/money.js";
import { vectors } from "./vectors.js";

const INR = "INR";

describe("construction", () => {
  test("rejects number amounts", () => {
    expect(() => new Money(10.5 as unknown as bigint, INR)).toThrow(InvalidAmountError);
    expect(() => new Money(10 as unknown as bigint, INR)).toThrow(InvalidAmountError);
  });
  test("rejects booleans", () => {
    expect(() => new Money(true as unknown as bigint, INR)).toThrow(InvalidAmountError);
  });
  test("currency strings are parsed", () => {
    expect(new Money(100n, "inr").currency).toBe("INR");
  });
  test("unknown currency", () => {
    try {
      Money.of(1n, "XYZ");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedCurrencyError);
      expect((e as UnsupportedCurrencyError).code).toBe(ErrorCode.UNSUPPORTED_CURRENCY);
      expect((e as Error).message).toBe("Currency 'XYZ' is not supported");
    }
  });
  test("from_major rejects number", () => {
    expect(() => Money.fromMajor(0.1 as unknown as string, INR)).toThrow(InvalidAmountError);
  });
  test("from_major bigint is whole units", () => {
    expect(Money.fromMajor(25n, INR).amount).toBe(2500n);
  });
  test("matches M1 from_major vectors", () => {
    for (const v of vectors.from_major!) {
      if (v.error) {
        expect(() => Money.fromMajor(v.raw, v.currency), JSON.stringify(v)).toThrow(InvalidAmountError);
      } else {
        expect(Money.fromMajor(v.raw, v.currency).amount, JSON.stringify(v)).toBe(BigInt(v.minor));
      }
    }
  });
});

describe("arithmetic", () => {
  test("add/sub", () => {
    expect(Money.of(150n, INR).add(Money.of(50n, INR)).amount).toBe(200n);
    expect(Money.of(150n, INR).sub(Money.of(200n, INR)).amount).toBe(-50n);
  });
  test("currency mismatch", () => {
    expect(() => Money.of(1n, INR).add(Money.of(1n, "USD"))).toThrow(CurrencyMismatchError);
    expect(() => Money.of(1n, INR).lt(Money.of(1n, "USD"))).toThrow(CurrencyMismatchError);
  });
  test("comparisons", () => {
    const a = Money.of(1n, INR);
    const b = Money.of(2n, INR);
    expect(a.lt(b) && a.lte(a) && b.gt(a) && b.gte(b)).toBe(true);
  });
  test("sum", () => {
    expect(Money.sum([Money.of(1n, INR), Money.of(2n, INR)], INR).amount).toBe(3n);
    expect(Money.sum([], INR).isZero()).toBe(true);
  });
  test("apply_bps", () => {
    expect(Money.of(99999n, INR).applyBps(200n).amount).toBe(2000n);
    expect(Money.of(125n, INR).applyBps(200n, "half_even").amount).toBe(2n);
    expect(Money.of(125n, INR).applyBps(200n, "half_up").amount).toBe(3n);
  });
  test("matches M1 apply_bps vectors", () => {
    for (const [a, bps, mode, out] of vectors.apply_bps!) {
      expect(Money.of(BigInt(a), INR).applyBps(BigInt(bps), mode as Rounding).amount).toBe(BigInt(out));
    }
  });
});

describe("div_round", () => {
  test("matches every M1 vector", () => {
    for (const [n, d, mode, out] of vectors.div_round!) {
      expect(divRound(BigInt(n), BigInt(d), mode as Rounding), `${n}/${d} ${mode}`).toBe(BigInt(out));
    }
  });
  test("zero division", () => {
    expect(() => divRound(1n, 0n, "half_even")).toThrow(RangeError);
  });
  test("property: result within one of the exact quotient", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n }).filter((d) => d !== 0n),
        fc.constantFrom(...ROUNDINGS),
        (n, d, mode) => {
          const q = divRound(n, d, mode);
          const diff = q * d - n; // |q - n/d| < 1  ⇔  |q·d - n| < |d|
          return (diff < 0n ? -diff : diff) < (d < 0n ? -d : d);
        },
      ),
    );
  });
});

describe("allocate", () => {
  test("classic three-way", () => {
    expect(
      Money.of(100n, INR)
        .allocate([1n, 1n, 1n])
        .map((p) => p.amount),
    ).toEqual([34n, 33n, 33n]);
  });
  test("negative amount", () => {
    expect(
      Money.of(-100n, INR)
        .allocate([1n, 1n, 1n])
        .map((p) => p.amount),
    ).toEqual([-34n, -33n, -33n]);
  });
  test.each([[[]], [[0n, 0n]], [[-1n, 2n]]])("invalid ratios %s", (ratios) => {
    expect(() => Money.of(5n, INR).allocate(ratios as bigint[])).toThrow(/ratios/);
  });
  test("matches M1 vectors", () => {
    for (const v of vectors.allocate!) {
      const parts = Money.of(BigInt(v.amount), INR).allocate(v.ratios.map(BigInt));
      expect(parts.map((p) => p.amount.toString())).toEqual(v.parts);
    }
  });
  test("property: conserves money and is fair", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.array(fc.bigInt({ min: 0n, max: 10_000n }), { minLength: 1, maxLength: 20 }).filter((r) => r.some((x) => x > 0n)),
        (amount, ratios) => {
          const parts = Money.of(amount, INR).allocate(ratios);
          return parts.reduce((a, p) => a + p.amount, 0n) === amount && parts.length === ratios.length;
        },
      ),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.integer({ min: 1, max: 50 }), (amount, n) => {
        const v = Money.of(amount, INR)
          .split(BigInt(n))
          .map((p) => p.amount);
        const max = v.reduce((a, b) => (b > a ? b : a));
        const min = v.reduce((a, b) => (b < a ? b : a));
        return v.reduce((a, b) => a + b, 0n) === amount && max - min <= 1n;
      }),
    );
  });
});

describe("formatting", () => {
  test("matches M1 format + to_major vectors", () => {
    for (const v of vectors.money_format!) {
      const m = Money.of(BigInt(v.amount), v.currency as Currency);
      expect(m.format()).toBe(v.format);
      expect(m.toMajor()).toBe(v.major);
    }
  });
  test("property: major round trip", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.constantFrom(...CURRENCIES), (a, c) =>
        Money.fromMajor(Money.of(a, c).toMajor(), c).equals(Money.of(a, c)),
      ),
    );
  });
});
