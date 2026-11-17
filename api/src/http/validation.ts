/**
 * Request validation with Zod, reporting errors the way M1 (FastAPI/Pydantic)
 * did: status 422, ``MR_VALIDATION_FAILED``, ``param`` = dotted field path of
 * the first error (query errors before body errors). Message text is the
 * framework's own and is not part of the parity contract (ADR-0011).
 */
import { z } from "zod";

import { ErrorCode, MintRailError } from "@mintrail/shared";

export class ValidationError extends MintRailError {
  static override defaultCode = ErrorCode.VALIDATION_FAILED;
}

// ---------------------------------------------------------------- Pydantic-like primitives
/** StrictInt: JSON integer literals only (parsed as bigint). No strings, floats or bools. */
export const strictInt = () => z.bigint({ error: "Input should be a valid integer" });

/** Lax ``int`` (Pydantic lax mode): integers, integral floats, numeric strings. Returns number. */
export const laxInt = () =>
  z.union([z.bigint(), z.number(), z.string()], { error: "Input should be a valid integer" }).transform((v, ctx) => {
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "number" && Number.isInteger(v)) return v;
    if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v.trim());
    ctx.addIssue({ code: "custom", message: "Input should be a valid integer, unable to parse string as an integer" });
    return z.NEVER;
  });

const TRUE = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE = new Set(["0", "f", "false", "n", "no", "off"]);
/** Lax ``bool``: booleans, 0/1, and Pydantic's accepted strings. */
export const laxBool = () =>
  z.union([z.boolean(), z.bigint(), z.number(), z.string()]).transform((v, ctx) => {
    if (typeof v === "boolean") return v;
    if ((typeof v === "bigint" || typeof v === "number") && (Number(v) === 0 || Number(v) === 1)) return Number(v) === 1;
    if (typeof v === "string" && (TRUE.has(v.toLowerCase()) || FALSE.has(v.toLowerCase()))) return TRUE.has(v.toLowerCase());
    ctx.addIssue({ code: "custom", message: "Input should be a valid boolean" });
    return z.NEVER;
  });

/**
 * ``EmailStr`` (email-validator, deliverability off): a syntactically valid
 * address; returned normalised like Pydantic (domain lower-cased).
 */
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
export const emailStr = () =>
  z.string().transform((v, ctx) => {
    const at = v.lastIndexOf("@");
    const local = v.slice(0, at);
    const domain = v.slice(at + 1);
    const labels = domain.split(".");
    const ok =
      at > 0 &&
      local.length <= 64 &&
      LOCAL.test(local) &&
      labels.length >= 2 &&
      labels.every((l) => LABEL.test(l)) &&
      !/^\d+$/.test(labels[labels.length - 1]!);
    if (!ok) {
      ctx.addIssue({ code: "custom", message: "value is not a valid email address" });
      return z.NEVER;
    }
    return `${local}@${domain.toLowerCase()}`;
  });

export const optional = <T extends z.ZodType>(t: T) => t.nullable().optional();

// ---------------------------------------------------------------- running a schema
function paramOf(issue: z.core.$ZodIssue): string | null {
  const path = issue.path.map(String);
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) path.push(issue.keys[0]!);
  return path.length > 0 ? path.join(".") : null;
}

export function validate<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const first = r.error.issues[0]!;
  const param = paramOf(first);
  const msg = first.code === "invalid_type" && first.input === undefined ? "Field required" : first.message;
  throw new ValidationError(param ? `${param}: ${msg}` : msg, { param });
}
