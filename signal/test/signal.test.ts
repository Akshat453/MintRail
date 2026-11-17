/** Signal unit tests: backoff + jitter, URL policy, signature verification. */
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { signatures } from "@mintrail/shared";

import { backoffSeconds } from "../src/delivery.js";
import { normaliseEvents } from "../src/endpoints.js";
import { isPrivateAddress, validateEndpointUrl } from "../src/urls.js";
import { verifyWebhook } from "../src/verify.js";

const O = { backoffBaseS: 30, backoffCapS: 6 * 3600, backoffScale: 1 };

describe("backoff", () => {
  test("exponential with equal jitter, capped", () => {
    expect(backoffSeconds(1, O, () => 0)).toBe(15);
    expect(backoffSeconds(1, O, () => 1)).toBe(30);
    expect(backoffSeconds(4, O, () => 0.5)).toBe(180);
    expect(backoffSeconds(30, O, () => 1)).toBe(6 * 3600);
    expect(backoffSeconds(5, { ...O, backoffScale: 0 }, () => 1)).toBe(0);
  });
  test("property: within [ceiling/2, ceiling] and non-decreasing ceilings", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.double({ min: 0, max: 1, noNaN: true }), (n, r) => {
        const ceiling = Math.min(O.backoffCapS, O.backoffBaseS * 2 ** (n - 1));
        const v = backoffSeconds(n, O, () => r);
        return v >= ceiling / 2 && v <= ceiling;
      }),
    );
  });
});

describe("endpoint URLs", () => {
  test("https only in production; private and loopback addresses refused", () => {
    expect(validateEndpointUrl("https://hooks.kaveri.example/mintrail", false)).toBe("https://hooks.kaveri.example/mintrail");
    expect(() => validateEndpointUrl("http://hooks.kaveri.example/x", false)).toThrow(/https/);
    expect(() => validateEndpointUrl("https://192.168.1.10/x", false)).toThrow(/private/);
    expect(() => validateEndpointUrl("https://user:pw@hooks.example/x", false)).toThrow(/credentials/);
    expect(() => validateEndpointUrl("http://localhost:4000/x", false)).toThrow();
    expect(validateEndpointUrl("http://localhost:4000/x", true)).toBe("http://localhost:4000/x");
    expect(validateEndpointUrl("http://host.docker.internal:4000/x", true)).toBe("http://host.docker.internal:4000/x");
  });
  test("private address classification", () => {
    for (const ip of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  test("event filters", () => {
    expect(normaliseEvents(undefined)).toEqual(["*"]);
    expect(normaliseEvents(["refund.processed", "payment.captured", "refund.processed"])).toEqual(["payment.captured", "refund.processed"]);
    expect(() => normaliseEvents(["nope"])).toThrow(/unknown event type/);
  });
});

describe("verifyWebhook", () => {
  test("accepts any matching v1, rejects tampering and stale timestamps", () => {
    const body = '{"id":"evt_1","amount":49900}';
    const now = 1_800_000_000;
    const header = `t=${now},v1=${signatures.compute(Buffer.from("whsec_new"), now, body)},v1=${signatures.compute(Buffer.from("whsec_old"), now, body)}`;
    expect(verifyWebhook(body, header, "whsec_old", { now })).toBe(now);
    expect(() => verifyWebhook(body.replace("49900", "49901"), header, "whsec_new", { now })).toThrow();
    expect(() => verifyWebhook(body, header, "whsec_new", { now: now + 301 })).toThrow();
  });
});
