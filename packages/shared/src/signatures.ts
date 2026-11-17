/**
 * Timestamped HMAC-SHA256 signatures: ``t=<unix>,v1=<hex>`` over ``"<t>." + payload``.
 * Used for merchant request signing, Junction callbacks and (later) Signal webhooks.
 */
import { hmacSha256Hex, constantTimeEqual } from "./crypto.js";

export const DEFAULT_TOLERANCE_S = 300;

export class SignatureError extends Error {
  constructor(
    readonly reason: string,
    readonly expired = false,
  ) {
    super(reason);
  }
}

export const compute = (secret: Buffer, timestamp: number, payload: Buffer | string): string =>
  hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(payload)]));

export const header = (secret: Buffer, timestamp: number, payload: Buffer | string): string =>
  `t=${timestamp},v1=${compute(secret, timestamp, payload)}`;

export function parse(value: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | undefined;
  const sigs: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (key === "t") {
      // Python int(): optional sign, digits, surrounding whitespace, underscores between digits.
      if (!/^\s*[+-]?\d+(_\d+)*\s*$/.test(val)) throw new SignatureError("timestamp is not an integer");
      timestamp = Number(val.replaceAll("_", "").trim());
    } else if (key === "v1") {
      sigs.push(val);
    }
  }
  if (timestamp === undefined) throw new SignatureError("signature header has no timestamp");
  if (sigs.length === 0) throw new SignatureError("signature header has no v1 signature");
  return { timestamp, signatures: sigs };
}

export function verify(secret: Buffer, value: string, payload: Buffer | string, opts: { now: number; toleranceS?: number }): number {
  const tolerance = opts.toleranceS ?? DEFAULT_TOLERANCE_S;
  const parsed = parse(value);
  if (Math.abs(opts.now - parsed.timestamp) > tolerance) {
    throw new SignatureError(`timestamp outside the ${tolerance}s tolerance window`, true);
  }
  const expected = compute(secret, parsed.timestamp, payload);
  if (!parsed.signatures.some((s) => constantTimeEqual(expected, s))) {
    throw new SignatureError("signature mismatch");
  }
  return parsed.timestamp;
}
