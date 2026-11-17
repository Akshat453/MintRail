/** Request signing and webhook verification (the same HMAC-SHA256 ``t=…,v1=…`` scheme MintRail uses server-side). */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SIGNING_CONTEXT = "mintrail-request-signing-v1";

const hmacHex = (key: Buffer | string, message: Buffer | string): string => createHmac("sha256", key).update(message).digest("hex");

/** Live keys sign each request; the signing key is derived from the secret, which never leaves the client. */
export function signRequest(
  secret: string,
  keyId: string,
  req: { method: string; path: string; query: string; body: string; timestamp: number },
): Record<string, string> {
  const signingKey = createHmac("sha256", Buffer.from(secret, "utf8")).update(SIGNING_CONTEXT).digest();
  const canonical = [req.method.toUpperCase(), req.path, req.query, createHash("sha256").update(req.body).digest("hex")].join("\n");
  const v1 = hmacHex(signingKey, Buffer.concat([Buffer.from(`${req.timestamp}.`), Buffer.from(canonical)]));
  return { "MintRail-Key-Id": keyId, "MintRail-Signature": `t=${req.timestamp},v1=${v1}` };
}

export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

/**
 * Verify a ``MintRail-Signature`` header against the raw request body. Accepts the
 * header if *any* ``v1`` matches (during secret rotation MintRail sends two).
 * Returns the signed timestamp.
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  header: string,
  secret: string,
  opts: { toleranceS?: number; now?: number } = {},
): number {
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2) as [string, string | undefined];
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) sigs.push(v);
  }
  if (t === undefined) throw new WebhookSignatureError("signature header has no timestamp");
  if (sigs.length === 0) throw new WebhookSignatureError("signature header has no v1 signature");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceS ?? 300)) throw new WebhookSignatureError("signature timestamp is outside the tolerance window");
  const expected = Buffer.from(hmacHex(Buffer.from(secret, "utf8"), Buffer.concat([Buffer.from(`${t}.`), Buffer.from(payload)])), "utf8");
  const ok = sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s, "utf8"), expected));
  if (!ok) throw new WebhookSignatureError("no signature matches the expected value");
  return t;
}
