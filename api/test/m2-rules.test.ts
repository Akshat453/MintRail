/** M2 pure rules: payout validation, evidence content sniffing, CSV parsing/writing, money formatting for reports. */
import { describe, expect, test } from "vitest";

import { ErrorCode, MintRailError } from "@mintrail/shared";

import { parseCsv, toCsv } from "../src/csv.js";
import { sniffContentType } from "../src/services/disputes.js";
import { type PayoutInput, validatePayout } from "../src/services/payouts.js";
import { major } from "../src/services/settlements.js";

const bank: PayoutInput = {
  amount: 50_000n,
  mode: "IMPS",
  purpose: "vendor_bill",
  beneficiary: { name: "Supplier Co", account_number: "123456789012", ifsc: "HDFC0001234" },
};
const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as MintRailError).param ?? (e as MintRailError).code;
  }
};

describe("validatePayout", () => {
  test("valid bank and UPI payouts pass", () => {
    expect(codeOf(() => validatePayout(bank))).toBeNull();
    expect(
      codeOf(() => validatePayout({ ...bank, mode: "UPI", amount: 10_000n, beneficiary: { name: "Asha K", vpa: "asha@okhdfc" } })),
    ).toBeNull();
    expect(codeOf(() => validatePayout({ ...bank, mode: "RTGS", amount: 2_00_000_00n }))).toBeNull();
  });
  test.each([
    ["short name", { beneficiary: { ...bank.beneficiary, name: "Al" } }, "beneficiary.name"],
    ["UPI without vpa", { mode: "UPI", beneficiary: { name: "Asha K" } }, "beneficiary.vpa"],
    ["UPI bad vpa", { mode: "UPI", beneficiary: { name: "Asha K", vpa: "not-a-vpa" } }, "beneficiary.vpa"],
    [
      "UPI with account",
      { mode: "UPI", beneficiary: { name: "Asha K", vpa: "asha@okaxis", account_number: "123456789012" } },
      "beneficiary",
    ],
    ["short account", { beneficiary: { ...bank.beneficiary, account_number: "1234" } }, "beneficiary.account_number"],
    ["bad ifsc", { beneficiary: { ...bank.beneficiary, ifsc: "HDFC1234567" } }, "beneficiary.ifsc"],
    ["bank with vpa", { beneficiary: { ...bank.beneficiary, vpa: "a@okaxis" } }, "beneficiary.vpa"],
    ["IMPS above ₹5L", { amount: 5_00_000_01n }, "amount"],
    ["UPI above ₹1L", { mode: "UPI", amount: 1_00_000_01n, beneficiary: { name: "Asha K", vpa: "asha@okaxis" } }, "amount"],
    ["RTGS below ₹2L", { mode: "RTGS", amount: 1_000n }, "amount"],
    ["below ₹1", { amount: 99n }, "amount"],
    ["unknown purpose", { purpose: "bribe" }, "purpose"],
    ["long reference", { reference: "x".repeat(41) }, "reference"],
    ["bad narration", { narration: "Nov <script>" }, "narration"],
  ] as const)("%s", (_name, patch, param) => {
    expect(codeOf(() => validatePayout({ ...bank, ...(patch as Partial<PayoutInput>) } as PayoutInput))).toBe(param);
  });
});

describe("sniffContentType", () => {
  test("magic bytes decide, not names", () => {
    expect(sniffContentType(Buffer.from("%PDF-1.7 ..."))).toBe("application/pdf");
    expect(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffContentType(Buffer.from("MZ\x90\x00"))).toBeNull();
    expect(sniffContentType(Buffer.from("<html>"))).toBeNull();
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
  });
});

describe("CSV", () => {
  test("parses quotes, embedded commas/newlines, CRLF, BOM and blank lines", () => {
    const text = '﻿name,amount\r\n"Sharma, Ravi",100\r\n"He said ""hi""",200\n\n"multi\nline",300';
    expect(parseCsv(text)).toEqual([
      ["name", "amount"],
      ["Sharma, Ravi", "100"],
      ['He said "hi"', "200"],
      ["multi\nline", "300"],
    ]);
    expect(parseCsv("a,b\nc,")).toEqual([
      ["a", "b"],
      ["c", ""],
    ]);
  });
  test("writes RFC 4180 and neutralises spreadsheet formulas", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          ["x,y", 'q"t'],
          [null, -12.5],
          ["=HYPERLINK(1)", "+91"],
          ["@x", undefined],
        ],
      ),
    ).toBe('a,b\r\n"x,y","q""t"\r\n,-12.5\r\n\'=HYPERLINK(1),\'+91\r\n\'@x,\r\n');
  });
});

describe("major (report amounts)", () => {
  test("paise → rupees without floats", () => {
    expect([major(0n), major(5n), major(123_456n), major(-250n), major(10_00_000_00n)]).toEqual([
      "0.00",
      "0.05",
      "1234.56",
      "-2.50",
      "1000000.00",
    ]);
  });
});

test("error codes used by M2 are mapped", () => {
  for (const code of [
    ErrorCode.REFUND_AMOUNT_EXCEEDED,
    ErrorCode.PAYOUT_LIMIT_EXCEEDED,
    ErrorCode.INVALID_EVIDENCE,
    ErrorCode.PAYLOAD_TOO_LARGE,
  ]) {
    expect(new MintRailError("x", { code }).httpStatus).toBeGreaterThanOrEqual(400);
  }
});
