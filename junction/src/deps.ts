import { stringifyJson } from "@mintrail/shared";

export { signatures } from "@mintrail/shared";

/** ``json.dumps(event, separators=(",", ":"), sort_keys=True)`` (body bytes are what's signed). */
export function pyJsonCompact(value: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, value[k]]),
  );
  return stringifyJson(sorted);
}
