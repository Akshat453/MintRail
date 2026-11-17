/** Receiver-side verification of ``MintRail-Signature`` (used by tests, the demo and documented for merchants). */
import { SignatureError, signatures } from "@mintrail/shared";

/** Throws SignatureError unless one ``v1`` matches ``secret`` within ``toleranceS``. Returns the timestamp. */
export function verifyWebhook(
  payload: string | Buffer,
  header: string,
  secret: string,
  opts: { now?: number; toleranceS?: number } = {},
): number {
  return signatures.verify(Buffer.from(secret), header, payload, {
    now: opts.now ?? Math.floor(Date.now() / 1000),
    toleranceS: opts.toleranceS ?? 300,
  });
}

export { SignatureError };
