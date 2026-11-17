/** Fee plans (MDR in basis points). Pricing is fictional; GST is added by the ledger recipe. */
import { type Currency, InvalidRequestError, pyRepr } from "@mintrail/shared";

export const FEE_PLANS = ["standard", "growth", "enterprise"] as const;
export type FeePlan = (typeof FEE_PLANS)[number];

const RATES: Record<FeePlan, Record<string, bigint>> = {
  standard: { "INR:card": 200n, "INR:netbanking": 190n, "INR:upi": 100n, "USD:card": 300n },
  growth: { "INR:card": 180n, "INR:netbanking": 170n, "INR:upi": 80n, "USD:card": 280n },
  enterprise: { "INR:card": 150n, "INR:netbanking": 150n, "INR:upi": 50n, "USD:card": 250n },
};

export function feeBps(plan: string, currency: Currency, method: string): bigint {
  const rate = (RATES as Record<string, Record<string, bigint> | undefined>)[plan]?.[`${currency}:${method}`];
  if (rate === undefined) {
    throw new InvalidRequestError(`fee plan ${pyRepr(plan)} has no rate for ${method} in ${currency}`);
  }
  return rate;
}
