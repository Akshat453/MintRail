/**
 * MintRail's chart of accounts (identical codes to M1).
 *
 * Platform (``platform:<mode>:<name>:<CUR>``): customer_funds (asset),
 * mintrail_fees (revenue), gst_payable, refunds_payable, settlement_clearing (liabilities).
 * Station (``station:<mer_id>:<mode>:merchant_balance:<CUR>``): liability.
 */
import type { Currency } from "@mintrail/shared";

import type { LedgerAccountRow } from "./schema.js";
import type { AccountType, LedgerService } from "./service.js";

export const StationAccount = { MERCHANT_BALANCE: "merchant_balance" } as const;
export type StationAccount = (typeof StationAccount)[keyof typeof StationAccount];

export const SystemAccount = {
  CUSTOMER_FUNDS: "customer_funds",
  MINTRAIL_FEES: "mintrail_fees",
  GST_PAYABLE: "gst_payable",
  REFUNDS_PAYABLE: "refunds_payable",
  SETTLEMENT_CLEARING: "settlement_clearing",
} as const;
export type SystemAccount = (typeof SystemAccount)[keyof typeof SystemAccount];

const SYSTEM_TYPES: Record<SystemAccount, AccountType> = {
  customer_funds: "asset",
  mintrail_fees: "revenue",
  gst_payable: "liability",
  refunds_payable: "liability",
  settlement_clearing: "liability",
};

export interface AccountSpec {
  code: string;
  name: string;
  type: AccountType;
  currency: Currency;
  livemode: boolean;
  ownerId: string | null;
  allowNegative: boolean;
}

export const ensure = (ledger: LedgerService, spec: AccountSpec): Promise<LedgerAccountRow> => ledger.ensureAccount(spec);

export const modeLabel = (livemode: boolean): string => (livemode ? "live" : "test");

export function stationAccount(
  stationId: string,
  currency: Currency,
  livemode: boolean,
  kind: StationAccount = StationAccount.MERCHANT_BALANCE,
): AccountSpec {
  const mode = modeLabel(livemode);
  return {
    code: `station:${stationId}:${mode}:${kind}:${currency}`,
    name: `${stationId} ${kind} (${currency}, ${mode})`,
    type: "liability",
    currency,
    livemode,
    ownerId: stationId,
    allowNegative: false,
  };
}

export function systemAccount(account: SystemAccount, currency: Currency, livemode: boolean): AccountSpec {
  const mode = modeLabel(livemode);
  return {
    code: `platform:${mode}:${account}:${currency}`,
    name: `Platform ${account.replaceAll("_", " ")} (${currency}, ${mode})`,
    type: SYSTEM_TYPES[account],
    currency,
    livemode,
    ownerId: null,
    allowNegative: false,
  };
}

export async function ensureStationAccounts(
  ledger: LedgerService,
  stationId: string,
  currency: Currency,
  livemode: boolean,
): Promise<Record<StationAccount, LedgerAccountRow>> {
  const out = {} as Record<StationAccount, LedgerAccountRow>;
  for (const kind of Object.values(StationAccount)) {
    out[kind] = await ensure(ledger, stationAccount(stationId, currency, livemode, kind));
  }
  return out;
}

export async function ensureSystemAccounts(
  ledger: LedgerService,
  currency: Currency,
  livemode: boolean,
): Promise<Record<SystemAccount, LedgerAccountRow>> {
  const out = {} as Record<SystemAccount, LedgerAccountRow>;
  for (const acct of Object.values(SystemAccount)) {
    out[acct] = await ensure(ledger, systemAccount(acct, currency, livemode));
  }
  return out;
}

// ------------------------------------------------------------------ M2 accounts
// Kept out of StationAccount/SystemAccount on purpose: those sets are provisioned
// eagerly when a Station is created (an M1 behaviour the parity harness pins).
// M2 accounts are created lazily the first time a recipe needs them.

/** Station sub-accounts. ``dispute_reserve`` may go negative: the merchant owes MintRail until it is swept. */
export const M2StationAccount = { RESERVE: "reserve", DISPUTE_RESERVE: "dispute_reserve" } as const;
export type M2StationAccount = (typeof M2StationAccount)[keyof typeof M2StationAccount];

/** Platform accounts: payouts in flight, chargebacks owed to the network. */
export const M2SystemAccount = { PAYOUTS_CLEARING: "payouts_clearing", DISPUTE_CLEARING: "dispute_clearing" } as const;
export type M2SystemAccount = (typeof M2SystemAccount)[keyof typeof M2SystemAccount];

export function m2StationAccount(stationId: string, kind: M2StationAccount, currency: Currency, livemode: boolean): AccountSpec {
  return { ...stationAccount(stationId, currency, livemode, kind as unknown as StationAccount), allowNegative: kind === "dispute_reserve" };
}

export function m2SystemAccount(account: M2SystemAccount, currency: Currency, livemode: boolean): AccountSpec {
  const mode = modeLabel(livemode);
  return {
    code: `platform:${mode}:${account}:${currency}`,
    name: `Platform ${account.replaceAll("_", " ")} (${currency}, ${mode})`,
    type: "liability",
    currency,
    livemode,
    ownerId: null,
    allowNegative: false,
  };
}
