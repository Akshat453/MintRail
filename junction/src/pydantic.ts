/**
 * Minimal reproduction of FastAPI's default 422 body (``{"detail": [...]}``)
 * for the constraints Junction's request models use. Junction is internal, but
 * its wire contract is frozen (docs/contract) — so errors match M1 exactly.
 */
export interface PydErr {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

type Field =
  | { kind: "str"; min?: number; max?: number; optional?: boolean }
  | { kind: "strict_int"; gt?: number }
  | { kind: "literal"; values: string[] }
  | { kind: "bool" };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const LAX_TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const LAX_FALSE = new Set(["0", "f", "false", "n", "no", "off"]);

export function validateModel(
  body: unknown,
  fields: Record<string, Field>,
  where = "body",
): { value: Record<string, unknown>; errors: PydErr[] } {
  const errors: PydErr[] = [];
  const value: Record<string, unknown> = {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      value,
      errors: [
        {
          type: "model_attributes_type",
          loc: [where],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: body,
        },
      ],
    };
  }
  const obj = body as Record<string, unknown>;
  for (const [name, f] of Object.entries(fields)) {
    const loc = [where, name];
    if (!(name in obj) || obj[name] === undefined) {
      if (f.kind === "str" && f.optional) {
        value[name] = null;
        continue;
      }
      errors.push({ type: "missing", loc, msg: "Field required", input: body });
      continue;
    }
    const v = obj[name];
    switch (f.kind) {
      case "str":
        if (v === null && f.optional) {
          value[name] = null;
        } else if (typeof v !== "string") {
          errors.push({ type: "string_type", loc, msg: "Input should be a valid string", input: v });
        } else if (f.min !== undefined && v.length < f.min) {
          errors.push({
            type: "string_too_short",
            loc,
            msg: `String should have at least ${plural(f.min, "character")}`,
            input: v,
            ctx: { min_length: f.min },
          });
        } else if (f.max !== undefined && v.length > f.max) {
          errors.push({
            type: "string_too_long",
            loc,
            msg: `String should have at most ${plural(f.max, "character")}`,
            input: v,
            ctx: { max_length: f.max },
          });
        } else {
          value[name] = v;
        }
        break;
      case "strict_int":
        if (typeof v !== "bigint") {
          errors.push({ type: "int_type", loc, msg: "Input should be a valid integer", input: v });
        } else if (f.gt !== undefined && v <= BigInt(f.gt)) {
          errors.push({ type: "greater_than", loc, msg: `Input should be greater than ${f.gt}`, input: v, ctx: { gt: f.gt } });
        } else {
          value[name] = v;
        }
        break;
      case "literal":
        if (typeof v === "string" && f.values.includes(v)) {
          value[name] = v;
        } else {
          const q = f.values.map((x) => `'${x}'`);
          const expected = q.length === 1 ? q[0]! : `${q.slice(0, -1).join(", ")} or ${q[q.length - 1]}`;
          errors.push({ type: "literal_error", loc, msg: `Input should be ${expected}`, input: v, ctx: { expected } });
        }
        break;
      case "bool":
        if (typeof v === "boolean") value[name] = v;
        else if (typeof v === "bigint" && (v === 0n || v === 1n)) value[name] = v === 1n;
        else if (typeof v === "string" && (LAX_TRUE.has(v.toLowerCase()) || LAX_FALSE.has(v.toLowerCase())))
          value[name] = LAX_TRUE.has(v.toLowerCase());
        else if (typeof v === "string")
          errors.push({ type: "bool_parsing", loc, msg: "Input should be a valid boolean, unable to interpret input", input: v });
        else errors.push({ type: "bool_type", loc, msg: "Input should be a valid boolean", input: v });
        break;
    }
  }
  return { value, errors };
}

export const AUTHORIZE_FIELDS: Record<string, Field> = {
  payment_id: { kind: "str", min: 1, max: 40 },
  merchant_ref: { kind: "str", min: 1, max: 40 },
  amount: { kind: "strict_int", gt: 0 },
  currency: { kind: "literal", values: ["INR", "USD"] },
  method: { kind: "literal", values: ["card", "upi", "netbanking"] },
  instrument: { kind: "str", min: 1, max: 64 },
  livemode: { kind: "bool" },
  scenario: { kind: "str", max: 64, optional: true },
};

export const CAPTURE_FIELDS: Record<string, Field> = { amount: { kind: "strict_int", gt: 0 } };
