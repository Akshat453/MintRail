/**
 * Currency conversion for stored FX snapshots (ADR-0017).
 *
 * Rates are decimal strings ("83.4215" INR per 1 USD), never JS numbers. The
 * conversion is done in decimal.js on *minor units*, then rounded once:
 *
 *     to_minor = round(from_minor × rate × 10^(exp_to − exp_from), HALF_EVEN)
 *
 * Banker's rounding (half-even) avoids a systematic bias across many conversions.
 */
import { Decimal } from "decimal.js";

import { InvalidRequestError } from "./errors.js";
import { type Currency, exponentOf, Money } from "./money.js";

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN });

/** A rate must be a positive decimal with at most 10 fractional digits. */
export const RATE_RE = /^(0|[1-9]\d{0,9})(\.\d{1,10})?$/;

export function parseRate(rate: string): string {
  if (!RATE_RE.test(rate) || new D(rate).lte(0))
    throw new InvalidRequestError(`invalid FX rate ${JSON.stringify(rate)}`, { param: "rate" });
  return new D(rate).toFixed();
}

/** Convert ``amount`` into ``to`` at ``rate`` (units of ``to`` per 1 unit of ``amount.currency``). */
export function convert(amount: Money, to: Currency, rate: string): Money {
  const r = new D(parseRate(rate));
  const scale = new D(10).pow(exponentOf(to) - exponentOf(amount.currency as Currency));
  const minor = new D(amount.amount.toString()).mul(r).mul(scale);
  return Money.of(BigInt(Math.round(minor.toNumber())), to);
}

/** Multiply two rates (e.g. for cross rates), keeping 10 fractional digits, half-even. */
export const mulRates = (a: string, b: string): string => new D(parseRate(a)).mul(parseRate(b)).toDecimalPlaces(10).toFixed();
