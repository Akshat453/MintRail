/**
 * Junction callbacks for M2 resources (refunds, chargebacks, payouts). Authorization
 * events keep M1's path untouched (PaymentService.applyJunctionEvent). Each event is
 * recorded in ``junction_inbox`` in the same transaction it is applied in, so a
 * redelivery is a no-op.
 */
import { eq } from "drizzle-orm";

import { InvalidRequestError } from "@mintrail/shared";

import type { AppDeps } from "../deps.js";
import { junctionInbox } from "../schema/index.js";
import { DisputeService } from "./disputes.js";
import { PayoutService } from "./payouts.js";
import { RefundService } from "./refunds.js";

const PREFIXES = ["refund.", "dispute.", "payout."];
const REQUIRED: Record<string, string[]> = {
  refund: ["id", "type", "ref", "refund_id"],
  dispute: ["id", "type", "ref", "payment_id", "amount"],
  payout: ["id", "type", "ref", "payout_id"],
};

export const isM2Event = (e: Record<string, unknown>): boolean =>
  typeof e.type === "string" && PREFIXES.some((p) => (e.type as string).startsWith(p));

export async function applyM2Event(deps: AppDeps, event: Record<string, unknown>): Promise<string> {
  const type = String(event.type);
  const kind = type.split(".")[0]!;
  const missing = (REQUIRED[kind] ?? []).filter((f) => !(f in event));
  if (missing.length) throw new InvalidRequestError(`callback missing fields: [${missing.map((m) => `'${m}'`).join(", ")}]`);
  return deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(junctionInbox)
      .values({ eventId: String(event.id), type, outcome: "pending", payload: event })
      .onConflictDoNothing()
      .returning({ id: junctionInbox.eventId });
    if (inserted.length === 0) return "duplicate";
    let outcome: string;
    if (kind === "refund") outcome = await new RefundService(tx, deps.settings, deps.junction, deps.clock).applyEvent(event);
    else if (kind === "payout") outcome = await new PayoutService(tx, deps.settings, deps.junction, deps.clock).applyEvent(event);
    else if (type === "dispute.opened") outcome = await new DisputeService(tx, deps.settings, deps.junction, deps.clock).applyOpened(event);
    else if (type === "dispute.won" || type === "dispute.lost")
      outcome = await new DisputeService(tx, deps.settings, deps.junction, deps.clock).applyClosed(event);
    else outcome = "ignored";
    await tx
      .update(junctionInbox)
      .set({ outcome })
      .where(eq(junctionInbox.eventId, String(event.id)));
    return outcome;
  });
}
