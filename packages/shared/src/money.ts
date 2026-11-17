/**
 * Money as integer minor units, carried as ``bigint`` end to end.
 *
 * MintRail never represents money with JS ``number``. Every operation that
 * could produce a fraction of a minor unit takes an explicit ``Rounding``.
 * Behaviour is byte-for-byte compatible with the M1 Python implementation
 * (verified against recorded vectors). See docs/adr/0002.
 */
import { CurrencyMismatchError, InvalidAmountError, UnsupportedCurrencyError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";

export const BPS_DENOMINATOR = 10_000n;

export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "SGD", "AED", "JPY"] as const;
export type Currency = (typeof CURRENCIES)[number];

const EXPONENTS: Record<Currency, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SGD: 2,
  AED: 2,
  JPY: 0,
};
const SYMBOLS: Record<Currency, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  SGD: "S$",
  AED: "AED ",
  JPY: "¥",
};

export const exponentOf = (c: Currency): number => EXPONENTS[c];
export const isCurrency = (v: unknown): v is Currency => typeof v === "string" && (CURRENCIES as readonly string[]).includes(v);

export function parseCurrency(value: string): Currency {
  const up = value.trim().toUpperCase();
  if (isCurrency(up)) return up;
  throw new UnsupportedCurrencyError(`Currency ${pyRepr(value)} is not supported`, { param: "currency" });
}

export const ROUNDINGS = ["half_even", "half_up", "down", "up", "floor", "ceiling"] as const;
export type Rounding = (typeof ROUNDINGS)[number];

function requireBigint(value: unknown, what: string): bigint {
  if (typeof value !== "bigint") {
    const kind = value === null ? "NoneType" : typeof value === "number" ? (Number.isInteger(value) ? "int" : "float") : typeof value;
    throw new InvalidAmountError(`${what} must be an integer number of minor units, got ${kind}`, { param: what });
  }
  return value;
}

/** Floor-division remainder that is always >= 0 for a positive divisor. */
function floorDivMod(n: bigint, d: bigint): [bigint, bigint] {
  let q = n / d;
  let r = n % d;
  if (r !== 0n && r < 0n !== d < 0n) {
    q -= 1n;
    r += d;
  }
  return [q, r];
}

/** Integer ``numerator / denominator`` rounded with ``rounding``. Exact for any size. */
export function divRound(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator === 0n) throw new RangeError("division by zero");
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const [floorQ, rem] = floorDivMod(n, d);
  if (rem === 0n) return floorQ;
  const ceilQ = floorQ + 1n;
  const positive = n > 0n;
  switch (rounding) {
    case "floor":
      return floorQ;
    case "ceiling":
      return ceilQ;
    case "down":
      return positive ? floorQ : ceilQ;
    case "up":
      return positive ? ceilQ : floorQ;
    case "half_up":
    case "half_even": {
      const twice = 2n * rem;
      if (twice < d) return floorQ;
      if (twice > d) return ceilQ;
      if (rounding === "half_up") return positive ? ceilQ : floorQ;
      return floorQ % 2n === 0n ? floorQ : ceilQ;
    }
  }
}

const DECIMAL_RE = /^([+-])?((?:\d(?:_?\d)*)?)(?:\.((?:\d(?:_?\d)*)?))?(?:[eE]([+-]?\d(?:_?\d)*))?$/;

export class Money {
  readonly amount: bigint;
  readonly currency: Currency;

  constructor(amount: bigint, currency: Currency | string) {
    this.amount = requireBigint(amount, "amount");
    this.currency = isCurrency(currency) ? currency : parseCurrency(currency);
  }

  static of(amount: bigint, currency: Currency | string): Money {
    return new Money(amount, currency);
  }

  static zero(currency: Currency | string): Money {
    return new Money(0n, currency);
  }

  /**
   * Parse a major-unit amount ("1499.50" INR → 149950n). Values with more
   * decimal places than the currency allows are rejected, not rounded.
   */
  static fromMajor(value: string | bigint, currency: Currency | string): Money {
    const cur = isCurrency(currency) ? currency : parseCurrency(currency);
    const exp = EXPONENTS[cur];
    if (typeof value === "bigint") return new Money(value * 10n ** BigInt(exp), cur);
    if (typeof value !== "string") {
      throw new InvalidAmountError("floats are not accepted for money", { param: "amount" });
    }
    if (/^[+-]?(nan|snan|inf|infinity)$/i.test(value.trim())) {
      throw new InvalidAmountError("amount must be finite", { param: "amount" });
    }
    const m = DECIMAL_RE.exec(value.trim());
    if (!m || (!m[2] && !m[3])) {
      throw new InvalidAmountError(`${pyRepr(value)} is not a valid amount`, { param: "amount" });
    }
    const sign = m[1] === "-" ? -1n : 1n;
    const intDigits = (m[2] ?? "").replaceAll("_", "");
    const fracDigits = (m[3] ?? "").replaceAll("_", "");
    const e = Number((m[4] ?? "0").replaceAll("_", ""));
    // value = digits × 10^(e - len(frac)); minor = value × 10^exp
    const digits = BigInt(intDigits + fracDigits || "0");
    const scale = e - fracDigits.length + exp;
    if (scale >= 0) return new Money(sign * digits * 10n ** BigInt(scale), cur);
    const div = 10n ** BigInt(-scale);
    if (digits % div !== 0n) {
      throw new InvalidAmountError(`${cur} supports at most ${exp} decimal places`, { param: "amount" });
    }
    return new Money(sign * (digits / div), cur);
  }

  static sum(items: Iterable<Money>, currency: Currency | string): Money {
    let total = Money.zero(currency);
    for (const m of items) total = total.add(m);
    return total;
  }

  isZero(): boolean {
    return this.amount === 0n;
  }
  isPositive(): boolean {
    return this.amount > 0n;
  }
  isNegative(): boolean {
    return this.amount < 0n;
  }

  private same(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }

  add(o: Money): Money {
    this.same(o);
    return new Money(this.amount + o.amount, this.currency);
  }
  sub(o: Money): Money {
    this.same(o);
    return new Money(this.amount - o.amount, this.currency);
  }
  neg(): Money {
    return new Money(-this.amount, this.currency);
  }
  abs(): Money {
    return new Money(this.amount < 0n ? -this.amount : this.amount, this.currency);
  }
  equals(o: Money): boolean {
    return o.currency === this.currency && o.amount === this.amount;
  }
  lt(o: Money): boolean {
    this.same(o);
    return this.amount < o.amount;
  }
  lte(o: Money): boolean {
    this.same(o);
    return this.amount <= o.amount;
  }
  gt(o: Money): boolean {
    this.same(o);
    return this.amount > o.amount;
  }
  gte(o: Money): boolean {
    this.same(o);
    return this.amount >= o.amount;
  }

  times(factor: bigint): Money {
    return new Money(this.amount * requireBigint(factor, "factor"), this.currency);
  }

  /** ``bps`` basis points of this amount (200 bps = 2%). */
  applyBps(bps: bigint, rounding: Rounding = "half_even"): Money {
    requireBigint(bps, "bps");
    return new Money(divRound(this.amount * bps, BPS_DENOMINATOR, rounding), this.currency);
  }

  applyRatio(numerator: bigint, denominator: bigint, rounding: Rounding): Money {
    return new Money(divRound(this.amount * numerator, denominator, rounding), this.currency);
  }

  /** Largest-remainder split; parts always sum exactly to ``this``. */
  allocate(ratios: readonly bigint[]): Money[] {
    if (ratios.length === 0) throw new RangeError("ratios must not be empty");
    for (const r of ratios) {
      requireBigint(r, "ratio");
      if (r < 0n) throw new RangeError("ratios must be non-negative");
    }
    const total = ratios.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new RangeError("ratios must not all be zero");
    const sign = this.amount < 0n ? -1n : 1n;
    const magnitude = this.amount < 0n ? -this.amount : this.amount;
    const shares = ratios.map((r) => [(magnitude * r) / total, (magnitude * r) % total] as const);
    const parts = shares.map(([q]) => q);
    let leftover = magnitude - parts.reduce((a, b) => a + b, 0n);
    const order = ratios
      .map((_, i) => i)
      .sort((a, b) => {
        const ra = shares[a]![1];
        const rb = shares[b]![1];
        return ra === rb ? a - b : ra > rb ? -1 : 1;
      });
    for (const i of order) {
      if (leftover === 0n) break;
      parts[i]! += 1n;
      leftover -= 1n;
    }
    return parts.map((p) => new Money(sign * p, this.currency));
  }

  split(n: bigint): Money[] {
    if (requireBigint(n, "n") <= 0n) throw new RangeError("n must be positive");
    return this.allocate(Array.from({ length: Number(n) }, () => 1n));
  }

  /** Decimal string in major units, as Python's ``str(Decimal)`` ("1499.50", "-0.05", "500"). */
  toMajor(): string {
    const exp = EXPONENTS[this.currency];
    const neg = this.amount < 0n;
    const mag = (neg ? -this.amount : this.amount).toString();
    if (exp === 0) return (neg ? "-" : "") + mag;
    const padded = mag.padStart(exp + 1, "0");
    return `${neg ? "-" : ""}${padded.slice(0, -exp)}.${padded.slice(-exp)}`;
  }

  /** Human formatting (``₹1,499.50``). Indian digit grouping for INR. */
  format(): string {
    const exp = EXPONENTS[this.currency];
    const sign = this.amount < 0n ? "-" : "";
    const mag = this.amount < 0n ? -this.amount : this.amount;
    const unit = 10n ** BigInt(exp);
    const whole = exp ? mag / unit : mag;
    const frac = exp ? mag % unit : 0n;
    const grouped = this.currency === "INR" ? groupIndian(whole.toString()) : groupThousands(whole.toString());
    const fracPart = exp ? `.${frac.toString().padStart(exp, "0")}` : "";
    return `${sign}${SYMBOLS[this.currency]}${grouped}${fracPart}`;
  }

  toString(): string {
    return `${this.toMajor()} ${this.currency}`;
  }
}

function groupThousands(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "12345678" → "1,23,45,678" (lakh/crore grouping). */
function groupIndian(s: string): string {
  if (s.length <= 3) return s;
  let head = s.slice(0, -3);
  const tail = s.slice(-3);
  const groups: string[] = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) groups.unshift(head);
  return [...groups, tail].join(",");
}
