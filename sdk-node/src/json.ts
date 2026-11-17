/**
 * Exact JSON for money: integer literals become ``bigint`` on parse (using the
 * JSON.parse reviver's ``source`` text, Node ≥ 22), and ``bigint`` serialises as
 * a bare JSON number. Floats stay numbers (e.g. FX rates are strings anyway).
 */

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

const INTEGER = /^-?\d+$/;

export function parse<T = unknown>(text: string): T {
  const reviver: Reviver = (_key, value, context) =>
    typeof value === "number" && context?.source && INTEGER.test(context.source) ? BigInt(context.source) : value;
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]) as T;
}

interface RawJson {
  rawJSON(text: string): unknown;
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? (JSON as unknown as RawJson).rawJSON(v.toString()) : v));
}
