/** Signed delivery of Junction events to Platform. */
import { pyJsonCompact, signatures } from "./deps.js";

export const SIGNATURE_HEADER = "Junction-Signature";

export class DeliveryFailedError extends Error {}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export async function deliver(fetchImpl: Fetch, url: string, secret: Buffer, event: Record<string, unknown>, now: number): Promise<number> {
  const body = pyJsonCompact(event);
  let resp: { status: number; text(): Promise<string> };
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SIGNATURE_HEADER]: signatures.header(secret, now, body) },
      body,
    });
  } catch (e) {
    const err = e as Error;
    throw new DeliveryFailedError(`${err.name}: ${err.message}`);
  }
  if (resp.status >= 300) {
    throw new DeliveryFailedError(`platform answered ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return resp.status;
}
