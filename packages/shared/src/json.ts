/**
 * Exact JSON for money: integers are parsed as ``bigint`` (using the JSON
 * source text, so ``10.0`` stays a float and is rejected where an integer is
 * required) and ``bigint`` serializes as a bare JSON number.
 */
const INT_RE = /^-?\d+$/;

interface ReviverContext {
  source?: string;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, ctx?: ReviverContext) {
    if (typeof value === "number" && ctx?.source !== undefined && INT_RE.test(ctx.source)) {
      return BigInt(ctx.source);
    }
    return value;
  } as (this: unknown, key: string, value: unknown) => unknown);
}

declare global {
  interface JSON {
    rawJSON(text: string): unknown;
  }
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? JSON.rawJSON(value.toString()) : value;
}

export function stringifyJson(value: unknown, space?: number): string {
  return JSON.stringify(value, bigintReplacer, space);
}
