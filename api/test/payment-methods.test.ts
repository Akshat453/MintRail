/** Ported from api/tests/test_payment_methods.py, plus M1 fingerprint vectors. */
import { describe, expect, test } from "vitest";

import { ErrorCode, InvalidRequestError } from "@mintrail/shared";

import { feeBps } from "../src/fees.js";
import { cardNetwork, luhnValid, parseCard, parseNetbanking, parseUpi } from "../src/payment-methods.js";
import { validateNotes } from "../src/services/payments.js";
import { validateWebhookUrl } from "../src/services/stations.js";
import { urlparse } from "../src/urlparse.js";
import { vectors } from "../../packages/shared/test/vectors.js";

const TODAY = new Date("2026-11-17T00:00:00Z");
const PEPPER = "test-pepper-not-a-secret";

test.each([
  ["4111111111111111", true],
  ["4111111111111112", false],
  ["79927398713", true],
] as const)("luhn %s", (n, ok) => expect(luhnValid(n)).toBe(ok));

test.each([
  ["4111111111111111", "visa"],
  ["5500000000000004", "mastercard"],
  ["2221000000000009", "mastercard"],
  ["378282246310005", "amex"],
  ["6522000000000000", "rupay"],
  ["9999000000000000", "unknown"],
])("network %s", (n, net) => expect(cardNetwork(n)).toBe(net));

describe("card", () => {
  test("tokenises without keeping the PAN", () => {
    const i = parseCard("4111 1111 1111 1111", 12, 30, "123", { pepper: "p", today: TODAY });
    expect([i.cardBin, i.cardLast4, i.cardExpiryYear, i.masked]).toEqual(["411111", "1111", 2030, "card:411111:1111"]);
    expect(JSON.stringify(i)).not.toContain("4111111111111111");
  });
  test("fingerprint is stable and keyed", () => {
    const a = parseCard("4111111111111111", 12, 2030, "123", { pepper: "p", today: TODAY });
    const b = parseCard("4111-1111-1111-1111", 1, 2031, "999", { pepper: "p", today: TODAY });
    const c = parseCard("4111111111111111", 12, 2030, "123", { pepper: "q", today: TODAY });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });
  test.each([
    ["4111111111111112", 12, 2030, "123", "card.number"],
    ["41111", 12, 2030, "123", "card.number"],
    ["4111111111111111", 13, 2030, "123", "card.expiry_month"],
    ["4111111111111111", 10, 2026, "123", "card.expiry_year"],
    ["4111111111111111", 12, 2030, "12", "card.cvv"],
    ["378282246310005", 12, 2030, "123", "card.cvv"],
  ] as const)("rejects %s %s/%s %s", (n, m, y, cvv, param) => {
    try {
      parseCard(n, m, y, cvv, { pepper: "p", today: TODAY });
      expect.unreachable();
    } catch (e) {
      expect((e as InvalidRequestError).param).toBe(param);
      expect((e as InvalidRequestError).code).toBe(ErrorCode.INVALID_PAYMENT_METHOD);
    }
  });
  test("current month is not expired", () => parseCard("4111111111111111", 11, 2026, "123", { pepper: "p", today: TODAY }));
});

describe("upi", () => {
  test("normalises", () => {
    const i = parseUpi(" Asha.K@OkMintRail ", { pepper: "p" });
    expect([i.vpa, i.masked]).toEqual(["asha.k@okmintrail", "upi:asha.k@okmintrail"]);
  });
  test.each(["noatsign", "@bank", "a@", "a b@bank", "x@1bank"])("rejects %s", (v) =>
    expect(() => parseUpi(v, { pepper: "p" })).toThrow(InvalidRequestError),
  );
});

describe("netbanking", () => {
  test("known bank", () => expect(parseNetbanking("hdfc", { pepper: "p", livemode: true }).bankCode).toBe("HDFC"));
  test("test banks only in test mode", () => {
    expect(parseNetbanking("MRTEST", { pepper: "p", livemode: false }).bankCode).toBe("MRTEST");
    expect(() => parseNetbanking("MRTEST", { pepper: "p", livemode: true })).toThrow(InvalidRequestError);
  });
  test("unknown bank", () => expect(() => parseNetbanking("ZZZZ", { pepper: "p", livemode: false })).toThrow("unsupported bank 'ZZZZ'"));
});

test("fingerprints and masks match M1", () => {
  for (const v of vectors.fingerprints!) {
    const i =
      v.kind === "card"
        ? parseCard(v.input, 12, 2030, v.input.startsWith("37") ? "1234" : "123", { pepper: PEPPER, today: TODAY })
        : v.kind === "upi"
          ? parseUpi(v.input, { pepper: PEPPER })
          : parseNetbanking(v.input, { pepper: PEPPER, livemode: false });
    expect([i.fingerprint, i.masked]).toEqual([v.fingerprint, v.masked]);
  }
});

describe("fees", () => {
  test("plans", () => {
    expect(feeBps("standard", "INR", "card")).toBe(200n);
    expect(feeBps("enterprise", "INR", "upi")).toBe(50n);
    expect(feeBps("growth", "USD", "card")).toBe(280n);
  });
  test("missing rate", () => expect(() => feeBps("standard", "USD", "upi")).toThrow("fee plan 'standard' has no rate for upi in USD"));
});

describe("notes", () => {
  test("coerces scalars like Python str()", () => expect(validateNotes({ a: 1n, b: true, c: "x" })).toEqual({ a: "1", b: "True", c: "x" }));
  test.each([
    Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i), "x"])),
    { "": "x" },
    { k: "x".repeat(257) },
    { k: { nested: 1 } },
    { k: 1.5 },
  ])("rejects %j", (notes) => expect(() => validateNotes(notes as Record<string, unknown>)).toThrow(InvalidRequestError));
});

describe("webhook urls", () => {
  test.each([
    ["https://hooks.kaveri.example/x", true, "https://hooks.kaveri.example/x"],
    ["http://localhost:9000/h", true, "http://localhost:9000/h"],
    ["", true, null],
  ])("accepts %s", (url, allowHttp, out) => expect(validateWebhookUrl(url, allowHttp)).toBe(out));
  test.each([
    ["http://hooks.example/x", true, "webhook_url must be an https:// URL"],
    ["ftp://x", true, "webhook_url must be an https:// URL"],
    ["http://127.0.0.1/h", false, "webhook_url cannot point at localhost"],
    ["https://", true, "webhook_url has no host"],
  ])("rejects %s", (url, allowHttp, msg) => expect(() => validateWebhookUrl(url, allowHttp)).toThrow(msg));
  test("urlparse subset", () => {
    expect(urlparse("HTTPS://User@Host.Example:8443/p?q")).toEqual({ scheme: "https", hostname: "host.example" });
    expect(urlparse("https://[::1]:80/")).toEqual({ scheme: "https", hostname: "::1" });
    expect(urlparse("no-scheme")).toEqual({ scheme: "", hostname: null });
  });
});
