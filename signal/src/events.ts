/**
 * Event catalogue and the transactional-outbox producer API.
 *
 * Producers call ``emit(tx, …)`` inside the transaction that changes state, so
 * an event exists if and only if the change committed. Signal fans events out
 * to webhook endpoints asynchronously (see dispatcher.ts / delivery.ts).
 */
import { type Clock, IdPrefix, newId, systemClock, type Tx } from "@mintrail/shared";

import { outboxEvents, type OutboxEvent } from "./schema.js";

export const EVENT_TYPES = [
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "refund.created",
  "refund.processed",
  "refund.failed",
  "settlement.processed",
  "dispute.created",
  "dispute.closed",
  "payout.processed",
  "payout.failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const ALL_EVENTS = "*";

export interface EmitArgs {
  stationId: string;
  livemode: boolean;
  type: EventType;
  /** The API representation of the resource, exactly as the public API returns it. */
  object: Record<string, unknown>;
}

export async function emit(tx: Tx, args: EmitArgs, clock: Clock = systemClock): Promise<OutboxEvent> {
  const [row] = await tx
    .insert(outboxEvents)
    .values({
      id: newId(IdPrefix.EVENT, BigInt(clock.now().getTime())),
      stationId: args.stationId,
      livemode: args.livemode,
      type: args.type,
      data: { object: args.object },
    })
    .returning();
  return row!;
}
