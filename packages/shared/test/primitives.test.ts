import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { DEV_SECRETS_KEY, loadSettings } from "../src/config.js";
import { DecryptionError, hashPassword, hmacSha256Hex, isBase62, randomToken, SecretBox, verifyPassword } from "../src/crypto.js";
import { apiTime } from "../src/db.js";
import { ErrorCode, HTTP_STATUS_BY_CODE, MintRailError, NotFoundError, RateLimitedError } from "../src/errors.js";
import { encodeBody, IdPrefix, idTimestampMs, isValidId, newId, parseId } from "../src/ids.js";
import { parseJson, stringifyJson } from "../src/json.js";
import { pyRepr } from "../src/pyrepr.js";
import * as signatures from "../src/signatures.js";
import { vectors } from "./vectors.js";

describe("ids", () => {
  test("format", () => {
    const id = newId(IdPrefix.PAYMENT);
    expect(id).toMatch(/^pay_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(isValidId(id, IdPrefix.PAYMENT)).toBe(true);
  });
  test.each(Object.values(IdPrefix))("every prefix round-trips: %s", (p) => {
    expect(parseId(newId(p), p)).toBeTruthy();
  });
  test("wrong prefix", () => {
    const id = newId(IdPrefix.PAYMENT);
    expect(isValidId(id, IdPrefix.REFUND)).toBe(false);
    expect(() => parseId(id, IdPrefix.REFUND, "refund")).toThrow(/is not a valid rfd_ identifier/);
  });
  test.each([null, 42, "", "pay_", "pay", "pay_short", "PAY_01jcz6k3aaaaaaaaaaaaaaaaaa", `pay_${"u".repeat(26)}`])("malformed %s", (v) =>
    expect(isValidId(v, IdPrefix.PAYMENT)).toBe(false),
  );
  test("unique", () => {
    expect(new Set(Array.from({ length: 10_000 }, () => newId(IdPrefix.EVENT))).size).toBe(10_000);
  });
  test("matches M1 encoding vectors", () => {
    for (const v of vectors.id_bodies!) {
      expect(encodeBody((BigInt(v.ts) << 80n) | BigInt(v.rand))).toBe(v.body);
    }
  });
  test("sortable and timestamp extraction", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 48n - 2n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), (a, gap) => {
        const b = a + gap < 2n ** 48n ? a + gap : 2n ** 48n - 1n;
        const x = newId(IdPrefix.ORDER, a);
        const y = newId(IdPrefix.ORDER, b);
        return x < y && idTimestampMs(x) === a && idTimestampMs(y) === b;
      }),
    );
    expect(() => newId(IdPrefix.ORDER, 2n ** 48n)).toThrow(/timestamp/);
  });
});

describe("errors", () => {
  test("every code has an HTTP status and follows MR_ convention", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(HTTP_STATUS_BY_CODE[code]).toBeGreaterThanOrEqual(400);
      expect(code).toMatch(/^MR_[A-Z_]+$/);
    }
  });
  test("to_dict", () => {
    const e = new NotFoundError("nope", { param: "id", details: { x: 1 } });
    expect(e.httpStatus).toBe(404);
    expect(e.toDict()).toEqual({ code: "MR_RESOURCE_NOT_FOUND", message: "nope", param: "id", details: { x: 1 } });
  });
  test("explicit code overrides default", () => {
    expect(new MintRailError("slow", { code: ErrorCode.RATE_LIMITED }).httpStatus).toBe(429);
    expect(new RateLimitedError("slow", 3).details).toEqual({ retry_after_s: 3 });
  });
  test("python repr", () => {
    expect(pyRepr("pay_x")).toBe("'pay_x'");
    expect(pyRepr("it's")).toBe(`"it's"`);
    expect(pyRepr(`a'b"c`)).toBe(`'a\\'b"c'`);
    expect(pyRepr("tab\there\n")).toBe("'tab\\there\\n'");
    expect(pyRepr("clé")).toBe("'clé'");
  });
});

describe("config", () => {
  test.each(["staging", "production"])("placeholder secrets rejected in %s", (env) => {
    expect(() => loadSettings({ MINTRAIL_ENVIRONMENT: env }, {}, "/nonexistent")).toThrow(/MINTRAIL_API_KEY_PEPPER/);
  });
  test("dev secrets key rejected in production", () => {
    const env = {
      MINTRAIL_ENVIRONMENT: "production",
      MINTRAIL_API_KEY_PEPPER: "a".repeat(32),
      MINTRAIL_JUNCTION_API_KEY: "b".repeat(32),
      MINTRAIL_JUNCTION_CALLBACK_SECRET: "c".repeat(32),
      MINTRAIL_SIGNAL_API_KEY: "d".repeat(32),
      MINTRAIL_DEPOT_API_KEY: "e".repeat(32),
    };
    expect(() => loadSettings(env, {}, "/nonexistent")).toThrow(/MINTRAIL_SECRETS_KEY/);
    expect(
      loadSettings({ ...env, MINTRAIL_SECRETS_KEY: "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=" }, {}, "/nonexistent").environment,
    ).toBe("production");
  });
  test("env prefix and coercion", () => {
    const s = loadSettings({ MINTRAIL_DB_POOL_SIZE: "7", MINTRAIL_LOG_JSON: "false" }, {}, "/nonexistent");
    expect(s.db_pool_size).toBe(7);
    expect(s.log_json).toBe(false);
  });
});

describe("crypto (M1 wire compatibility)", () => {
  test("decrypts blobs encrypted by M1", () => {
    for (const v of vectors.secret_box!) {
      const box = new SecretBox(v.key_b64);
      expect(box.decrypt(Buffer.from(v.blob_hex, "hex"), Buffer.from(v.aad)).toString("hex")).toBe(v.plaintext_hex);
    }
  });
  test("round trip, aad binding, tamper", () => {
    const box = new SecretBox(DEV_SECRETS_KEY);
    const blob = box.encrypt(Buffer.from("signing-key"), Buffer.from("key_1"));
    expect(box.decrypt(blob, Buffer.from("key_1")).toString()).toBe("signing-key");
    expect(() => box.decrypt(blob, Buffer.from("key_2"))).toThrow(DecryptionError);
    const t = Buffer.from(blob);
    t[t.length - 1]! ^= 1;
    expect(() => box.decrypt(t, Buffer.from("key_1"))).toThrow(DecryptionError);
    expect(() => box.decrypt(Buffer.from([2, 1]), Buffer.from("a"))).toThrow(DecryptionError);
    expect(() => new SecretBox("not base64!!")).toThrow(/secrets key/);
    expect(() => new SecretBox(Buffer.from("short").toString("base64"))).toThrow(/secrets key/);
  });
  test("verifies scrypt hashes produced by M1", async () => {
    for (const v of vectors.passwords!) {
      expect(await verifyPassword(v.password, v.hash)).toBe(true);
      expect(await verifyPassword(`${v.password}x`, v.hash)).toBe(false);
    }
  });
  test("hash/verify round trip, salted, garbage never verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
    for (const g of ["", "bcrypt$x", "scrypt$1$2$3$!!$!!", "scrypt$a$b$c$d$e"]) {
      expect(await verifyPassword("x", g)).toBe(false);
    }
  });
  test("tokens", () => {
    const t = randomToken("rys_", 40);
    expect(t).toHaveLength(44);
    expect(isBase62(t.slice(4))).toBe(true);
  });
  test("staff token hash matches M1", () => {
    for (const v of vectors.api_keys!) {
      expect(hmacSha256Hex(v.pepper, `staff-session:rys_${v.secret.slice(8)}`)).toBe(v.staff_token_hash);
    }
  });
});

describe("signatures", () => {
  const S = Buffer.from("whsec");
  test("matches M1 callback signatures", () => {
    for (const v of vectors.callback_signatures!) {
      expect(signatures.header(Buffer.from(v.secret), v.ts, v.payload)).toBe(v.header);
    }
  });
  test("round trip / mismatch / tolerance / rotation", () => {
    const h = signatures.header(S, 1000, "payload");
    expect(signatures.verify(S, h, "payload", { now: 1000 })).toBe(1000);
    expect(() => signatures.verify(S, h, "other", { now: 1000 })).toThrow("signature mismatch");
    for (const now of [699, 1301]) {
      try {
        signatures.verify(S, h, "payload", { now });
        expect.unreachable();
      } catch (e) {
        expect((e as signatures.SignatureError).expired).toBe(true);
      }
    }
    const old = signatures.compute(Buffer.from("old"), 5, "p");
    const fresh = signatures.compute(S, 5, "p");
    expect(signatures.verify(S, `t=5,v1=${old},v1=${fresh}`, "p", { now: 5 })).toBe(5);
  });
  test.each(["", "v1=abc", "t=5", "t=x,v1=abc", "garbage"])("malformed %s", (v) => {
    expect(() => signatures.verify(S, v, "p", { now: 5 })).toThrow(signatures.SignatureError);
  });
});

describe("json + time", () => {
  test("integers parse as bigint; floats stay floats", () => {
    expect(parseJson('{"a": 10, "b": 10.0, "c": 123456789012345678901}')).toEqual({ a: 10n, b: 10, c: 123456789012345678901n });
    expect(stringifyJson({ a: 12345678901234567890n, b: [1n] })).toBe('{"a":12345678901234567890,"b":[1]}');
  });
  test("api time format", () => {
    expect(apiTime("2026-11-16 18:28:34.17603+00")).toBe("2026-11-16T18:28:34.176030Z");
    expect(apiTime("2026-11-16 18:28:34+00")).toBe("2026-11-16T18:28:34Z");
    expect(apiTime(null)).toBeNull();
    expect(apiTime(new Date("2026-01-02T03:04:05.006Z"))).toBe("2026-01-02T03:04:05.006000Z");
  });
});
