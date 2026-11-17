/**
 * Validation and tokenisation of payment instruments (same rules as M1). Raw
 * card numbers and CVVs live only in memory; we keep BIN, last 4, network,
 * expiry and a keyed fingerprint.
 */
import { ErrorCode, hmacSha256Hex, InvalidRequestError, pyRepr } from "@mintrail/shared";

import type { PaymentMethod } from "./schema/index.js";

export const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

export const BANKS: Record<string, string> = {
  HDFC: "HDFC Bank",
  ICIC: "ICICI Bank",
  SBIN: "State Bank of India",
  UTIB: "Axis Bank",
  KKBK: "Kotak Mahindra Bank",
  YESB: "Yes Bank",
  PUNB: "Punjab National Bank",
  BARB: "Bank of Baroda",
};
export const TEST_BANKS: Record<string, string> = {
  MRTEST: "MintRail Test Bank (always succeeds)",
  MRFAIL: "MintRail Test Bank (always fails)",
};

const invalid = (message: string, param: string): InvalidRequestError =>
  new InvalidRequestError(message, { code: ErrorCode.INVALID_PAYMENT_METHOD, param });

export interface Instrument {
  method: PaymentMethod;
  fingerprint: string;
  masked: string;
  cardNetwork: string | null;
  cardBin: string | null;
  cardLast4: string | null;
  cardExpiryMonth: number | null;
  cardExpiryYear: number | null;
  vpa: string | null;
  bankCode: string | null;
}

const base = { cardNetwork: null, cardBin: null, cardLast4: null, cardExpiryMonth: null, cardExpiryYear: null, vpa: null, bankCode: null };

export function luhnValid(number: string): boolean {
  let total = 0;
  [...number].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  });
  return total % 10 === 0;
}

export function cardNetwork(number: string): string {
  const two = Number(number.slice(0, 2));
  const four = Number(number.slice(0, 4));
  if (number.startsWith("4")) return "visa";
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return "mastercard";
  if (two === 34 || two === 37) return "amex";
  if ([60, 65, 81, 82].includes(two) || number.startsWith("508")) return "rupay";
  return "unknown";
}

export function parseCard(
  number: string,
  expiryMonth: number,
  expiryYear: number,
  cvv: string,
  opts: { pepper: string; today: Date },
): Instrument {
  const digits = number.replaceAll(" ", "").replaceAll("-", "");
  if (!/^\d+$/.test(digits) || digits.length < 12 || digits.length > 19 || !luhnValid(digits)) {
    throw invalid("card number is invalid", "card.number");
  }
  if (expiryMonth < 1 || expiryMonth > 12) throw invalid("expiry_month must be 1-12", "card.expiry_month");
  const year = expiryYear < 100 ? expiryYear + 2000 : expiryYear;
  const ty = opts.today.getUTCFullYear();
  const tm = opts.today.getUTCMonth() + 1;
  if (year < ty || (year === ty && expiryMonth < tm)) throw invalid("card has expired", "card.expiry_year");
  const network = cardNetwork(digits);
  const cvvLen = network === "amex" ? 4 : 3;
  if (!(/^\d+$/.test(cvv) && cvv.length === cvvLen)) throw invalid(`cvv must be ${cvvLen} digits`, "card.cvv");
  return {
    ...base,
    method: "card",
    fingerprint: hmacSha256Hex(opts.pepper, `card:${digits}`),
    masked: `card:${digits.slice(0, 6)}:${digits.slice(-4)}`,
    cardNetwork: network,
    cardBin: digits.slice(0, 6),
    cardLast4: digits.slice(-4),
    cardExpiryMonth: expiryMonth,
    cardExpiryYear: year,
  };
}

export function parseUpi(vpa: string, opts: { pepper: string }): Instrument {
  const v = vpa.trim();
  if (!VPA_RE.test(v)) throw invalid("vpa must look like name@bank", "upi.vpa");
  const normalised = v.toLowerCase();
  return {
    ...base,
    method: "upi",
    fingerprint: hmacSha256Hex(opts.pepper, `upi:${normalised}`),
    masked: `upi:${normalised}`,
    vpa: normalised,
  };
}

export function parseNetbanking(bankCode: string, opts: { pepper: string; livemode: boolean }): Instrument {
  const code = bankCode.trim().toUpperCase();
  const allowed = opts.livemode ? BANKS : { ...BANKS, ...TEST_BANKS };
  if (!(code in allowed)) throw invalid(`unsupported bank ${pyRepr(bankCode)}`, "netbanking.bank_code");
  return {
    ...base,
    method: "netbanking",
    fingerprint: hmacSha256Hex(opts.pepper, `nb:${code}`),
    masked: `netbanking:${code}`,
    bankCode: code,
  };
}
