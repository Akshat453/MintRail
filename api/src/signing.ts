/**
 * Merchant request signing (client and server halves), identical to M1:
 *   MintRail-Key-Id: key_…   MintRail-Signature: t=<unix>,v1=<hex>
 *   v1 = HMAC-SHA256(signing_key, "<t>." + METHOD\nPATH\nQUERY\nhex(SHA-256(body)))
 */
import { sha256Hex, signatures } from "@mintrail/shared";

import { deriveSigningKey } from "./keys.js";

export const KEY_ID_HEADER = "MintRail-Key-Id";
export const SIGNATURE_HEADER = "MintRail-Signature";

export const canonicalRequest = (method: string, path: string, query: string, body: Buffer | string): Buffer =>
  Buffer.from([method.toUpperCase(), path, query, sha256Hex(body)].join("\n"));

/** Client helper: headers to attach to a request. */
export function signRequest(
  secret: string,
  keyId: string,
  req: { method: string; path: string; query?: string; body?: Buffer | string; timestamp?: number },
): Record<string, string> {
  const ts = req.timestamp ?? Math.floor(Date.now() / 1000);
  const payload = canonicalRequest(req.method, req.path, req.query ?? "", req.body ?? "");
  return { [KEY_ID_HEADER]: keyId, [SIGNATURE_HEADER]: signatures.header(deriveSigningKey(secret), ts, payload) };
}
