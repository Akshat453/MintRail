/** Ported from api/tests/test_keys.py, plus M1 wire-compatibility vectors. */
import { describe, expect, test } from "vitest";

import { InvalidRequestError, signatures } from "@mintrail/shared";

import { deriveSigningKey, generateKey, hashSecret, makeHint, modeOf, SECRET_BODY_LEN } from "../src/keys.js";
import { ALL, allows, normaliseScopes } from "../src/scopes.js";
import { canonicalRequest, signRequest } from "../src/signing.js";
import { vectors } from "../../packages/shared/test/vectors.js";

test.each(["test", "live"] as const)("generated key shape (%s)", (mode) => {
  const k = generateKey(mode, "pepper");
  expect(k.secret.startsWith(`mr_${mode}_`)).toBe(true);
  expect(k.secret).toHaveLength(`mr_${mode}_`.length + SECRET_BODY_LEN);
  expect(modeOf(k.secret)).toBe(mode);
  expect(k.secretHash).toBe(hashSecret(k.secret, "pepper"));
  expect(k.signingKey.equals(deriveSigningKey(k.secret))).toBe(true);
  expect(k.hint).not.toContain(k.secret);
  expect(k.hint.endsWith(k.secret.slice(-4))).toBe(true);
});

test("hash depends on pepper", () => expect(hashSecret("mr_test_x", "a")).not.toBe(hashSecret("mr_test_x", "b")));
test("hint", () => expect(makeHint(`mr_live_${"a".repeat(36)}WXYZ`)).toBe("mr_live_…WXYZ"));
test.each([
  "",
  "mr_test_",
  `mr_prod_${"a".repeat(40)}`,
  `mr_test_${"a".repeat(39)}`,
  `mr_test_${"!".repeat(40)}`,
  `sk_test_${"a".repeat(40)}`,
])("mode_of rejects malformed %s", (v) => expect(modeOf(v)).toBeNull());
test("keys are unique", () => expect(new Set(Array.from({ length: 1000 }, () => generateKey("test", "p").secret)).size).toBe(1000));

test("M1 vectors: hash, signing key, hint, canonical string, signed headers", () => {
  for (const v of vectors.api_keys!) {
    expect(hashSecret(v.secret, v.pepper)).toBe(v.hash);
    expect(deriveSigningKey(v.secret).toString("hex")).toBe(v.signing_key_hex);
    expect(makeHint(v.secret)).toBe(v.hint);
    expect(canonicalRequest(v.method, v.path, v.query, v.body).toString()).toBe(v.canonical);
    const keyId = v.headers["MintRail-Key-Id"];
    expect(signRequest(v.secret, keyId, { method: v.method, path: v.path, query: v.query, body: v.body, timestamp: v.ts })).toEqual(
      v.headers,
    );
  }
});

describe("scopes", () => {
  test("default is full access", () => {
    expect(normaliseScopes(null)).toEqual([ALL]);
    expect(normaliseScopes([])).toEqual([ALL]);
  });
  test("wildcard wins", () => expect(normaliseScopes(["orders:read", "*"])).toEqual([ALL]));
  test("dedupe and sort", () =>
    expect(normaliseScopes(["payments:read", "orders:read", "orders:read"])).toEqual(["orders:read", "payments:read"]));
  test("unknown scope", () => expect(() => normaliseScopes(["teleport:write"])).toThrow(InvalidRequestError));
  test("M2 scopes are real", () => expect(normaliseScopes(["refunds:write", "payouts:read"])).toEqual(["payouts:read", "refunds:write"]));
  test("allows", () => {
    expect(allows([ALL], "payments:write")).toBe(true);
    expect(allows(["payments:write"], "payments:write")).toBe(true);
    expect(allows(["payments:read"], "payments:write")).toBe(false);
  });
});

describe("request signing", () => {
  test("canonical form", () => {
    const c = canonicalRequest("post", "/v1/orders", "a=1", "{}").toString().split("\n");
    expect(c.slice(0, 3)).toEqual(["POST", "/v1/orders", "a=1"]);
    expect(c[3]).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });
  test("signature verifies with the derived key", () => {
    const k = generateKey("test", "p");
    const h = signRequest(k.secret, "key_x", { method: "POST", path: "/v1/orders", body: "{}", timestamp: 1_700_000_000 });
    expect(h["MintRail-Key-Id"]).toBe("key_x");
    signatures.verify(k.signingKey, h["MintRail-Signature"]!, canonicalRequest("POST", "/v1/orders", "", "{}"), { now: 1_700_000_100 });
  });
  test("body tampering detected", () => {
    const k = generateKey("test", "p");
    const h = signRequest(k.secret, "key_x", { method: "POST", path: "/v1/orders", body: "{}", timestamp: 100 });
    expect(() =>
      signatures.verify(k.signingKey, h["MintRail-Signature"]!, canonicalRequest("POST", "/v1/orders", "", '{"amount":1}'), { now: 100 }),
    ).toThrow();
  });
});
