/** API key scopes. A key holds either ``*`` (full access) or an explicit list. */
import { InvalidRequestError, pyRepr } from "@mintrail/shared";

export const ALL = "*";
export const SCOPES = [
  "station:read",
  "station:write",
  "balance:read",
  "orders:read",
  "orders:write",
  "payments:read",
  "payments:write",
  // M2
  "refunds:read",
  "refunds:write",
  "disputes:read",
  "disputes:write",
  "payouts:read",
  "payouts:write",
  "settlements:read",
  "webhooks:read",
  "webhooks:write",
  "events:read",
] as const;
export type Scope = (typeof SCOPES)[number];

export function normaliseScopes(scopes: string[] | null | undefined): string[] {
  if (!scopes || scopes.length === 0) return [ALL];
  const out = new Set<string>();
  for (const s of scopes) {
    if (s === ALL) return [ALL];
    if (!(SCOPES as readonly string[]).includes(s)) {
      throw new InvalidRequestError(`unknown scope ${pyRepr(s)}`, { param: "scopes" });
    }
    out.add(s);
  }
  return [...out].sort();
}

export const allows = (granted: string[], required: Scope): boolean => granted.includes(ALL) || granted.includes(required);
