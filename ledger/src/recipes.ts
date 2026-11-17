/**
 * Standard money movements as balanced ledger transactions (same as M1).
 *
 * | Event                | Debit               | Credit                                       |
 * |----------------------|---------------------|----------------------------------------------|
 * | capture              | customer_funds      | merchant_balance, mintrail_fees, gst_payable |
 * | refund initiated     | merchant_balance    | refunds_payable                              |
 * | refund paid out      | refunds_payable     | customer_funds                               |
 * | settlement initiated | merchant_balance    | settlement_clearing                          |
 * | settlement paid      | settlement_clearing | customer_funds                               |
 */
import { BPS_DENOMINATOR, type Currency, InvalidAmountError, type Money } from "@mintrail/shared";

import {
  ensure,
  M2StationAccount,
  m2StationAccount,
  M2SystemAccount,
  m2SystemAccount,
  stationAccount,
  SystemAccount,
  systemAccount,
} from "./chart.js";
import { credit, debit, type LedgerService, type PostedTransaction, type PostingLine } from "./service.js";

/** 18% GST on payment-gateway fees (India). */
export const GST_RATE_BPS = 1_800n;

export interface CaptureBreakdown {
  gross: Money;
  fee: Money;
  tax: Money;
  net: Money;
}

/** MDR = ``feeBps`` of gross (+ optional fixed fee); GST on the fee. Fee rounds half-up, tax half-even. */
export function computeCaptureBreakdown(gross: Money, opts: { feeBps: bigint; fixedFee?: Money; taxBps?: bigint }): CaptureBreakdown {
  if (!gross.isPositive()) throw new InvalidAmountError("gross amount must be positive", { param: "amount" });
  if (opts.feeBps < 0n || opts.feeBps > BPS_DENOMINATOR) {
    throw new InvalidAmountError("fee_bps must be within 0..10000", { param: "fee_bps" });
  }
  let fee = gross.applyBps(opts.feeBps, "half_up");
  if (opts.fixedFee) fee = fee.add(opts.fixedFee);
  const tax = fee.applyBps(opts.taxBps ?? GST_RATE_BPS, "half_even");
  const net = gross.sub(fee).sub(tax);
  if (net.isNegative()) throw new InvalidAmountError("fees exceed the payment amount", { param: "amount" });
  return { gross, fee, tax, net };
}

const nonZero = (lines: PostingLine[]): PostingLine[] => lines.filter((l) => !l.amount.isZero());

const sys = async (ledger: LedgerService, a: SystemAccount, m: Money, livemode: boolean): Promise<string> =>
  (await ensure(ledger, systemAccount(a, m.currency, livemode))).id;

const merchant = async (ledger: LedgerService, stationId: string, m: Money, livemode: boolean): Promise<string> =>
  (await ensure(ledger, stationAccount(stationId, m.currency, livemode))).id;

export async function recordCapture(
  ledger: LedgerService,
  args: { stationId: string; paymentId: string; breakdown: CaptureBreakdown; livemode: boolean },
): Promise<PostedTransaction> {
  const { gross, fee, tax, net } = args.breakdown;
  const lines = nonZero([
    debit(await sys(ledger, SystemAccount.CUSTOMER_FUNDS, gross, args.livemode), gross),
    credit(await merchant(ledger, args.stationId, gross, args.livemode), net),
    credit(await sys(ledger, SystemAccount.MINTRAIL_FEES, gross, args.livemode), fee),
    credit(await sys(ledger, SystemAccount.GST_PAYABLE, gross, args.livemode), tax),
  ]);
  return ledger.post({
    idempotencyKey: `capture:${args.paymentId}`,
    description: `Capture ${args.paymentId}`,
    lines,
    referenceType: "payment",
    referenceId: args.paymentId,
    metadata: { station_id: args.stationId, gross: gross.amount, fee: fee.amount, tax: tax.amount },
  });
}

export async function recordRefundInitiated(
  ledger: LedgerService,
  args: { stationId: string; refundId: string; amount: Money; livemode: boolean },
): Promise<PostedTransaction> {
  return ledger.post({
    idempotencyKey: `refund_initiated:${args.refundId}`,
    description: `Refund ${args.refundId} initiated`,
    lines: [
      debit(await merchant(ledger, args.stationId, args.amount, args.livemode), args.amount),
      credit(await sys(ledger, SystemAccount.REFUNDS_PAYABLE, args.amount, args.livemode), args.amount),
    ],
    referenceType: "refund",
    referenceId: args.refundId,
    metadata: { station_id: args.stationId },
  });
}

export async function recordRefundPaid(
  ledger: LedgerService,
  args: { refundId: string; amount: Money; livemode: boolean },
): Promise<PostedTransaction> {
  return ledger.post({
    idempotencyKey: `refund_paid:${args.refundId}`,
    description: `Refund ${args.refundId} returned to customer`,
    lines: [
      debit(await sys(ledger, SystemAccount.REFUNDS_PAYABLE, args.amount, args.livemode), args.amount),
      credit(await sys(ledger, SystemAccount.CUSTOMER_FUNDS, args.amount, args.livemode), args.amount),
    ],
    referenceType: "refund",
    referenceId: args.refundId,
  });
}

export async function recordSettlementInitiated(
  ledger: LedgerService,
  args: { stationId: string; settlementId: string; amount: Money; livemode: boolean },
): Promise<PostedTransaction> {
  return ledger.post({
    idempotencyKey: `settlement_initiated:${args.settlementId}`,
    description: `Settlement ${args.settlementId} initiated`,
    lines: [
      debit(await merchant(ledger, args.stationId, args.amount, args.livemode), args.amount),
      credit(await sys(ledger, SystemAccount.SETTLEMENT_CLEARING, args.amount, args.livemode), args.amount),
    ],
    referenceType: "settlement",
    referenceId: args.settlementId,
    metadata: { station_id: args.stationId },
  });
}

export async function recordSettlementPaid(
  ledger: LedgerService,
  args: { settlementId: string; amount: Money; livemode: boolean },
): Promise<PostedTransaction> {
  return ledger.post({
    idempotencyKey: `settlement_paid:${args.settlementId}`,
    description: `Settlement ${args.settlementId} credited to merchant bank`,
    lines: [
      debit(await sys(ledger, SystemAccount.SETTLEMENT_CLEARING, args.amount, args.livemode), args.amount),
      credit(await sys(ledger, SystemAccount.CUSTOMER_FUNDS, args.amount, args.livemode), args.amount),
    ],
    referenceType: "settlement",
    referenceId: args.settlementId,
  });
}

// ================================================================== M2 recipes
//
// | Event                     | Debit                    | Credit                                   |
// |---------------------------|--------------------------|------------------------------------------|
// | refund fee (instant)      | merchant_balance         | mintrail_fees, gst_payable               |
// | refund failed             | reversal of initiated (+ fee)                                       |
// | dispute opened            | station dispute_reserve  | dispute_clearing                         |
// | dispute won               | dispute_clearing         | station dispute_reserve                  |
// | dispute lost              | dispute_clearing         | customer_funds                           |
// | payout initiated          | merchant_balance         | payouts_clearing                         |
// | payout paid               | payouts_clearing         | customer_funds                           |
// | payout failed / rejected  | reversal of initiated                                               |
// | reserve hold / release    | merchant_balance ⇄ station reserve                                  |
// | dispute sweep             | merchant_balance ⇄ station dispute_reserve                          |
// | settlement (foreign cur.) | merchant_balance (X) → customer_funds (X): treasury sells X;     |
// |                           | customer_funds (INR) → settlement_clearing (INR) at the snapshot rate      |

const m2sys = async (ledger: LedgerService, a: M2SystemAccount, currency: Currency, livemode: boolean): Promise<string> =>
  (await ensure(ledger, m2SystemAccount(a, currency, livemode))).id;

const m2station = async (ledger: LedgerService, stationId: string, a: M2StationAccount, currency: Currency, livemode: boolean) =>
  (await ensure(ledger, m2StationAccount(stationId, a, currency, livemode))).id;

const cur = (m: Money): Currency => m.currency as Currency;

/** Reverse the transaction posted under ``originalKey`` (no-op if it was never posted). */
async function reverseByKey(
  ledger: LedgerService,
  originalKey: string,
  key: string,
  description: string,
): Promise<PostedTransaction | null> {
  const original = await ledger.transactionByKey(originalKey);
  if (!original) return null;
  return ledger.reverse(original.id, { idempotencyKey: key, description });
}

export async function recordRefundFee(
  ledger: LedgerService,
  args: { stationId: string; refundId: string; fee: Money; tax: Money; livemode: boolean },
): Promise<PostedTransaction | null> {
  const total = args.fee.add(args.tax);
  if (total.isZero()) return null;
  return ledger.post({
    idempotencyKey: `refund_fee:${args.refundId}`,
    description: `Instant refund fee for ${args.refundId}`,
    lines: nonZero([
      debit(await merchant(ledger, args.stationId, total, args.livemode), total),
      credit(await sys(ledger, SystemAccount.MINTRAIL_FEES, total, args.livemode), args.fee),
      credit(await sys(ledger, SystemAccount.GST_PAYABLE, total, args.livemode), args.tax),
    ]),
    referenceType: "refund",
    referenceId: args.refundId,
    metadata: { station_id: args.stationId, fee: args.fee.amount, tax: args.tax.amount },
  });
}

/** A refund the bank could not process: give the merchant the amount (and any fee) back. */
export async function recordRefundFailed(ledger: LedgerService, args: { refundId: string }): Promise<void> {
  await reverseByKey(ledger, `refund_initiated:${args.refundId}`, `refund_failed:${args.refundId}`, `Refund ${args.refundId} failed`);
  await reverseByKey(ledger, `refund_fee:${args.refundId}`, `refund_fee_reversed:${args.refundId}`, `Refund ${args.refundId} fee returned`);
}

export async function recordDisputeOpened(
  ledger: LedgerService,
  args: { stationId: string; disputeId: string; amount: Money; livemode: boolean },
): Promise<PostedTransaction> {
  return ledger.post({
    idempotencyKey: `dispute_opened:${args.disputeId}`,
    description: `Chargeback ${args.disputeId} opened`,
    lines: [
      debit(await m2station(ledger, args.stationId, M2StationAccount.DISPUTE_RESERVE, cur(args.amount), args.livemode), args.amount),
      credit(await m2sys(ledger, M2SystemAccount.DISPUTE_CLEARING, cur(args.amount), args.livemode), args.amount),
    ],
    referenceType: "dispute",
    referenceId: args.disputeId,
    metadata: { station_id: args.stationId },
  });
}

export async function recordDisputeClosed(
  ledger: LedgerService,
  args: { stationId: string; disputeId: string; amount: Money; livemode: boolean; won: boolean },
): Promise<PostedTransaction> {
  const c = cur(args.amount);
  const to = args.won
    ? await m2station(ledger, args.stationId, M2StationAccount.DISPUTE_RESERVE, c, args.livemode)
    : await sys(ledger, SystemAccount.CUSTOMER_FUNDS, args.amount, args.livemode);
  return ledger.post({
    idempotencyKey: `dispute_${args.won ? "won" : "lost"}:${args.disputeId}`,
    description: `Chargeback ${args.disputeId} ${args.won ? "won — funds returned to merchant" : "lost — funds paid to the network"}`,
    lines: [debit(await m2sys(ledger, M2SystemAccount.DISPUTE_CLEARING, c, args.livemode), args.amount), credit(to, args.amount)],
    referenceType: "dispute",
    referenceId: args.disputeId,
    metadata: { station_id: args.stationId },
  });
}

export async function recordPayoutInitiated(
  ledger: LedgerService,
  args: { stationId: string; payoutId: string; amount: Money; livemode: boolean },
): Promise<PostedTransaction> {
  return ledger.post({
    idempotencyKey: `payout_initiated:${args.payoutId}`,
    description: `Payout ${args.payoutId} initiated`,
    lines: [
      debit(await merchant(ledger, args.stationId, args.amount, args.livemode), args.amount),
      credit(await m2sys(ledger, M2SystemAccount.PAYOUTS_CLEARING, cur(args.amount), args.livemode), args.amount),
    ],
    referenceType: "payout",
    referenceId: args.payoutId,
    metadata: { station_id: args.stationId },
  });
}

export async function recordPayoutPaid(
  ledger: LedgerService,
  args: { payoutId: string; amount: Money; livemode: boolean },
): Promise<PostedTransaction> {
  return ledger.post({
    idempotencyKey: `payout_paid:${args.payoutId}`,
    description: `Payout ${args.payoutId} credited to beneficiary`,
    lines: [
      debit(await m2sys(ledger, M2SystemAccount.PAYOUTS_CLEARING, cur(args.amount), args.livemode), args.amount),
      credit(await sys(ledger, SystemAccount.CUSTOMER_FUNDS, args.amount, args.livemode), args.amount),
    ],
    referenceType: "payout",
    referenceId: args.payoutId,
  });
}

export async function recordPayoutReversed(ledger: LedgerService, args: { payoutId: string }): Promise<PostedTransaction | null> {
  return reverseByKey(ledger, `payout_initiated:${args.payoutId}`, `payout_reversed:${args.payoutId}`, `Payout ${args.payoutId} returned`);
}

/** Move ``amount`` between merchant_balance and a station sub-account (positive: into the sub-account). */
export async function recordStationTransfer(
  ledger: LedgerService,
  args: {
    stationId: string;
    account: M2StationAccount;
    key: string;
    description: string;
    amount: Money;
    livemode: boolean;
    referenceId: string;
  },
): Promise<PostedTransaction | null> {
  if (args.amount.isZero()) return null;
  const m = await merchant(ledger, args.stationId, args.amount, args.livemode);
  const sub = await m2station(ledger, args.stationId, args.account, cur(args.amount), args.livemode);
  const abs = args.amount.abs();
  const [from, to] = args.amount.isPositive() ? [m, sub] : [sub, m];
  return ledger.post({
    idempotencyKey: args.key,
    description: args.description,
    lines: [debit(from, abs), credit(to, abs)],
    referenceType: "settlement",
    referenceId: args.referenceId,
    metadata: { station_id: args.stationId, account: args.account },
  });
}

/**
 * Settlement of a foreign-currency balance, converted to ``payout`` (INR) at the batch's FX
 * snapshot. Treasury converts the cash in the same transaction: the foreign-currency cash
 * leaves customer_funds (X) and the INR proceeds arrive in customer_funds (INR), owed to the
 * merchant via settlement_clearing. Balanced per currency.
 */
export async function recordSettlementInitiatedFx(
  ledger: LedgerService,
  args: { stationId: string; settlementId: string; amount: Money; payout: Money; fxRate: string; livemode: boolean },
): Promise<PostedTransaction> {
  return ledger.post({
    idempotencyKey: `settlement_initiated:${args.settlementId}`,
    description: `Settlement ${args.settlementId} initiated (${args.amount.currency}→${args.payout.currency} @ ${args.fxRate})`,
    lines: [
      debit(await merchant(ledger, args.stationId, args.amount, args.livemode), args.amount),
      credit(await sys(ledger, SystemAccount.CUSTOMER_FUNDS, args.amount, args.livemode), args.amount),
      debit(await sys(ledger, SystemAccount.CUSTOMER_FUNDS, args.payout, args.livemode), args.payout),
      credit(await sys(ledger, SystemAccount.SETTLEMENT_CLEARING, args.payout, args.livemode), args.payout),
    ],
    referenceType: "settlement",
    referenceId: args.settlementId,
    metadata: { station_id: args.stationId, fx_rate: args.fxRate },
  });
}
