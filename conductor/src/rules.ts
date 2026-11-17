/** Risk rules: pure functions of their inputs → zero or more hits (same thresholds/texts as M1). */
import { type Currency, Money } from "@mintrail/shared";

/** Per-transaction ceilings by (currency, method), in minor units. */
export const METHOD_LIMITS: Record<string, bigint> = {
  "INR:upi": 1_00_000_00n,
  "INR:card": 5_00_000_00n,
  "INR:netbanking": 10_00_000_00n,
  "USD:card": 10_000_00n,
};
/** Above this, allowed but flagged for manual review. */
export const REVIEW_THRESHOLDS: Partial<Record<Currency, bigint>> = { INR: 2_00_000_00n, USD: 2_500_00n };

export const VELOCITY_WINDOW_S = 600;
export const VELOCITY_REVIEW_AT = 5;
export const VELOCITY_BLOCK_AT = 10;
export const FAILURE_WINDOW_S = 3600;
export const FAILURES_REVIEW_AT = 3;

export interface Hit {
  rule: string;
  outcome: "review" | "block";
  detail: string;
  weight: number;
}

export function amountLimits(amount: Money, method: string, stationMaxAmount: bigint | null): Hit[] {
  const hits: Hit[] = [];
  const limit = METHOD_LIMITS[`${amount.currency}:${method}`];
  if (limit === undefined) {
    hits.push({ rule: "method_not_supported", outcome: "block", detail: `${method} is not supported for ${amount.currency}`, weight: 100 });
  } else if (amount.amount > limit) {
    hits.push({
      rule: "amount_over_method_limit",
      outcome: "block",
      detail: `${amount.format()} exceeds the ${method} limit of ${Money.of(limit, amount.currency).format()}`,
      weight: 100,
    });
  }
  if (stationMaxAmount !== null && amount.amount > stationMaxAmount) {
    hits.push({
      rule: "amount_over_station_limit",
      outcome: "block",
      detail: `${amount.format()} exceeds this station's per-payment limit`,
      weight: 100,
    });
  }
  const threshold = REVIEW_THRESHOLDS[amount.currency];
  if (threshold !== undefined && amount.amount > threshold && hits.length === 0) {
    hits.push({ rule: "high_value", outcome: "review", detail: `${amount.format()} is a high-value payment`, weight: 40 });
  }
  return hits;
}

export function blocklist(args: { cardBin: string | null; vpa: string | null; blockedBins: Set<string>; blockedVpas: Set<string> }): Hit[] {
  const hits: Hit[] = [];
  if (args.cardBin !== null && args.blockedBins.has(args.cardBin)) {
    hits.push({ rule: "blocked_bin", outcome: "block", detail: `card BIN ${args.cardBin} is blocklisted`, weight: 100 });
  }
  if (args.vpa !== null && args.blockedVpas.has(args.vpa.toLowerCase())) {
    hits.push({ rule: "blocked_vpa", outcome: "block", detail: `VPA ${args.vpa} is blocklisted`, weight: 100 });
  }
  return hits;
}

/** ``recentAttempts`` excludes the payment being evaluated. */
export function velocity(recentAttempts: number, recentFailures: number): Hit[] {
  const hits: Hit[] = [];
  const attempts = recentAttempts + 1;
  const minutes = Math.floor(VELOCITY_WINDOW_S / 60);
  if (attempts >= VELOCITY_BLOCK_AT) {
    hits.push({
      rule: "instrument_velocity",
      outcome: "block",
      detail: `${attempts} attempts with this instrument in ${minutes} minutes`,
      weight: 90,
    });
  } else if (attempts >= VELOCITY_REVIEW_AT) {
    hits.push({
      rule: "instrument_velocity",
      outcome: "review",
      detail: `${attempts} attempts with this instrument in ${minutes} minutes`,
      weight: 50,
    });
  }
  if (recentFailures >= FAILURES_REVIEW_AT) {
    hits.push({
      rule: "repeated_failures",
      outcome: "review",
      detail: `${recentFailures} failed payments with this instrument in the last hour`,
      weight: 30,
    });
  }
  return hits;
}
