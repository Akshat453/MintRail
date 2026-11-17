/**
 * API key generation, hashing and request-signing key derivation (wire-compatible with M1):
 * key = ``mr_<mode>_<40 base62>``; stored hash = HMAC-SHA256(pepper, key);
 * signing key = HMAC-SHA256(key, "mintrail-request-signing-v1"), kept AES-GCM encrypted.
 */
import { hmacSha256, hmacSha256Hex, isBase62, randomToken } from "@mintrail/shared";

import type { KeyMode } from "./schema/index.js";

export const SECRET_BODY_LEN = 40;
export const KEY_PREFIXES: Record<KeyMode, string> = { test: "mr_test_", live: "mr_live_" };
export const SIGNING_KEY_CONTEXT = "mintrail-request-signing-v1";

export interface GeneratedKey {
  secret: string;
  secretHash: string;
  signingKey: Buffer;
  hint: string;
  mode: KeyMode;
}

export const hashSecret = (secret: string, pepper: string): string => hmacSha256Hex(pepper, secret);
export const deriveSigningKey = (secret: string): Buffer => hmacSha256(Buffer.from(secret, "utf8"), SIGNING_KEY_CONTEXT);

/** Safe-to-display form: ``mr_test_…k3Zq``. */
export function makeHint(secret: string): string {
  const prefix = secret.slice(0, secret.indexOf("_", 3) + 1);
  return `${prefix}…${secret.slice(-4)}`;
}

export function generateKey(mode: KeyMode, pepper: string): GeneratedKey {
  const secret = randomToken(KEY_PREFIXES[mode], SECRET_BODY_LEN);
  return { secret, secretHash: hashSecret(secret, pepper), signingKey: deriveSigningKey(secret), hint: makeHint(secret), mode };
}

/** The mode encoded in a presented key, or null if malformed. */
export function modeOf(secret: string): KeyMode | null {
  for (const [mode, prefix] of Object.entries(KEY_PREFIXES) as [KeyMode, string][]) {
    if (secret.startsWith(prefix)) {
      const body = secret.slice(prefix.length);
      if (body.length === SECRET_BODY_LEN && isBase62(body)) return mode;
    }
  }
  return null;
}
