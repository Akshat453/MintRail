/** The Pydantic-compatible validation layer (param mapping, lax/strict coercions). */
import { describe, expect, test } from "vitest";
import { z } from "zod";

import { emailStr, laxBool, laxInt, optional, strictInt, validate, ValidationError } from "../src/http/validation.js";

const fail = (schema: z.ZodType, value: unknown): ValidationError => {
  try {
    validate(schema, value);
  } catch (e) {
    return e as ValidationError;
  }
  throw new Error("expected validation to fail");
};

describe("primitives", () => {
  test("strictInt accepts bigint only", () => {
    expect(validate(strictInt(), 5n)).toBe(5n);
    for (const v of [5, "5", 5.5, true]) expect(fail(strictInt(), v).code).toBe("MR_VALIDATION_FAILED");
  });
  test("laxInt accepts integers, integral floats and numeric strings", () => {
    expect([validate(laxInt(), 5n), validate(laxInt(), 5), validate(laxInt(), " 7 ")]).toEqual([5, 5, 7]);
    expect(fail(laxInt(), "5.5").message).toContain("unable to parse");
    expect(fail(laxInt(), 5.5).code).toBe("MR_VALIDATION_FAILED");
  });
  test("laxBool follows Pydantic", () => {
    expect([true, "yes", "ON", 1n, 1].map((v) => validate(laxBool(), v))).toEqual([true, true, true, true, true]);
    expect([false, "no", "off", 0n, "f"].map((v) => validate(laxBool(), v))).toEqual([false, false, false, false, false]);
    expect(fail(laxBool(), "maybe").code).toBe("MR_VALIDATION_FAILED");
    expect(fail(laxBool(), 2n).code).toBe("MR_VALIDATION_FAILED");
  });
  test("emailStr normalises the domain and rejects malformed addresses", () => {
    expect(validate(emailStr(), "Asha.K@Nilgiri.Example")).toBe("Asha.K@nilgiri.example");
    for (const bad of ["not-an-email", "@x.example", "a@", "a@b", "a b@x.example", "a@x.123", "a@-x.example"]) {
      expect(fail(emailStr(), bad).param).toBeNull();
    }
  });
});

describe("param mapping (FastAPI loc → MR param)", () => {
  const Model = z.strictObject({ amount: strictInt(), card: optional(z.strictObject({ number: z.string().min(12) })) });
  test("missing field", () => {
    const e = fail(Model, {});
    expect([e.param, e.message]).toEqual(["amount", "amount: Field required"]);
  });
  test("nested field", () => expect(fail(Model, { amount: 1n, card: { number: "41" } }).param).toBe("card.number"));
  test("extra field", () => expect(fail(Model, { amount: 1n, colour: "red" }).param).toBe("colour"));
  test("nested extra field", () => expect(fail(Model, { amount: 1n, card: { number: "4".repeat(12), cvv: "1" } }).param).toBe("card.cvv"));
  test("whole body wrong type", () => expect(fail(Model, [1]).param).toBeNull());
});
