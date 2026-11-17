/**
 * Webhook endpoints (per Station and mode), their signing secrets, deliveries
 * and manual replay. Secrets are ``whsec_…``, stored AES-GCM encrypted (AAD =
 * endpoint id) and shown to the merchant only on create and rotate.
 *
 * Rotation keeps the previous secret valid for ``graceS`` seconds: during the
 * grace window every delivery carries two ``v1=`` signatures (new and old).
 */
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";

import {
  type Clock,
  ErrorCode,
  IdPrefix,
  InvalidRequestError,
  newId,
  NotFoundError,
  randomToken,
  type SecretBox,
  systemClock,
  type Tx,
} from "@mintrail/shared";

import { ALL_EVENTS, EVENT_TYPES } from "./events.js";
import {
  outboxEvents,
  type OutboxEvent,
  type WebhookDelivery,
  webhookDeliveries,
  webhookDeliveryAttempts,
  type WebhookDeliveryAttempt,
  type WebhookEndpoint,
  webhookEndpoints,
} from "./schema.js";
import { validateEndpointUrl } from "./urls.js";

export const SECRET_PREFIX = "whsec_";
export const MAX_ENDPOINTS_PER_MODE = 10;

export interface Owner {
  stationId: string;
  livemode: boolean;
}

export interface EndpointInput {
  url?: string;
  description?: string | null;
  enabled_events?: string[];
  status?: "enabled" | "disabled";
}

export function normaliseEvents(events: string[] | undefined | null): string[] {
  if (!events || events.length === 0) return [ALL_EVENTS];
  const out = new Set<string>();
  for (const e of events) {
    if (e === ALL_EVENTS) return [ALL_EVENTS];
    if (!(EVENT_TYPES as readonly string[]).includes(e)) {
      throw new InvalidRequestError(`unknown event type '${e}'`, { param: "enabled_events" });
    }
    out.add(e);
  }
  return [...out].sort();
}

const parseTs = (v: string): number => Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));

export class EndpointService {
  constructor(
    readonly tx: Tx,
    private readonly opts: { secretBox: SecretBox; allowLocal: boolean; graceS: number; maxAttempts: number; clock?: Clock },
  ) {}

  private get clock(): Clock {
    return this.opts.clock ?? systemClock;
  }

  private newSecret(id: string): { secret: string; enc: Buffer; hint: string } {
    const secret = randomToken(SECRET_PREFIX, 32);
    return { secret, enc: this.opts.secretBox.encrypt(Buffer.from(secret), Buffer.from(id)), hint: secret.slice(-4) };
  }

  async create(owner: Owner, input: EndpointInput & { url: string }): Promise<[WebhookEndpoint, string]> {
    const [row] = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.stationId, owner.stationId),
          eq(webhookEndpoints.livemode, owner.livemode),
          ne(webhookEndpoints.status, "deleted"),
        ),
      );
    if ((row?.n ?? 0) >= MAX_ENDPOINTS_PER_MODE) {
      throw new InvalidRequestError(`at most ${MAX_ENDPOINTS_PER_MODE} webhook endpoints per mode`);
    }
    const id = newId(IdPrefix.WEBHOOK);
    const s = this.newSecret(id);
    const [ep] = await this.tx
      .insert(webhookEndpoints)
      .values({
        id,
        stationId: owner.stationId,
        livemode: owner.livemode,
        url: validateEndpointUrl(input.url, this.opts.allowLocal),
        description: input.description ?? null,
        enabledEvents: normaliseEvents(input.enabled_events),
        status: input.status ?? "enabled",
        secretEnc: s.enc,
        secretHint: s.hint,
      })
      .returning();
    return [ep!, s.secret];
  }

  async list(owner: Owner): Promise<WebhookEndpoint[]> {
    return this.tx
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.stationId, owner.stationId),
          eq(webhookEndpoints.livemode, owner.livemode),
          ne(webhookEndpoints.status, "deleted"),
        ),
      )
      .orderBy(desc(webhookEndpoints.id));
  }

  /** ``owner`` null = staff access (any station). */
  async get(owner: Owner | null, id: string, lock = false): Promise<WebhookEndpoint> {
    const where = [eq(webhookEndpoints.id, id), ne(webhookEndpoints.status, "deleted")];
    if (owner) where.push(eq(webhookEndpoints.stationId, owner.stationId), eq(webhookEndpoints.livemode, owner.livemode));
    const q = this.tx
      .select()
      .from(webhookEndpoints)
      .where(and(...where));
    const [ep] = await (lock ? q.for("update") : q);
    if (!ep) throw new NotFoundError(`webhook endpoint ${id} not found`, { code: ErrorCode.WEBHOOK_ENDPOINT_NOT_FOUND });
    return ep;
  }

  async update(owner: Owner, id: string, input: EndpointInput): Promise<WebhookEndpoint> {
    await this.get(owner, id, true);
    const values: Partial<typeof webhookEndpoints.$inferInsert> = {};
    if (input.url !== undefined) values.url = validateEndpointUrl(input.url, this.opts.allowLocal);
    if (input.description !== undefined) values.description = input.description;
    if (input.enabled_events !== undefined) values.enabledEvents = normaliseEvents(input.enabled_events);
    if (input.status !== undefined) values.status = input.status;
    const [ep] = await this.tx
      .update(webhookEndpoints)
      .set({ ...values, updatedAt: sql`now()` })
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return ep!;
  }

  async remove(owner: Owner, id: string): Promise<WebhookEndpoint> {
    await this.get(owner, id, true);
    const [ep] = await this.tx
      .update(webhookEndpoints)
      .set({ status: "deleted", updatedAt: sql`now()` })
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return ep!;
  }

  /** New secret now; the old one keeps signing for ``graceS`` seconds. */
  async rotateSecret(owner: Owner, id: string): Promise<[WebhookEndpoint, string]> {
    const current = await this.get(owner, id, true);
    const s = this.newSecret(id);
    const now = this.clock.now();
    const [ep] = await this.tx
      .update(webhookEndpoints)
      .set({
        secretEnc: s.enc,
        secretHint: s.hint,
        previousSecretEnc: this.opts.graceS > 0 ? current.secretEnc : null,
        previousSecretExpiresAt: this.opts.graceS > 0 ? new Date(now.getTime() + this.opts.graceS * 1000).toISOString() : null,
        secretRotatedAt: now.toISOString(),
        updatedAt: sql`now()`,
      })
      .where(eq(webhookEndpoints.id, id))
      .returning();
    return [ep!, s.secret];
  }

  /** Secrets that should sign a delivery right now: current first, then the previous one inside its grace window. */
  secretsFor(ep: WebhookEndpoint, now: Date = this.clock.now()): Buffer[] {
    const out = [this.opts.secretBox.decrypt(ep.secretEnc, Buffer.from(ep.id))];
    if (ep.previousSecretEnc && ep.previousSecretExpiresAt && parseTs(ep.previousSecretExpiresAt) > now.getTime()) {
      out.push(this.opts.secretBox.decrypt(ep.previousSecretEnc, Buffer.from(ep.id)));
    }
    return out;
  }

  // ------------------------------------------------------------ deliveries & events
  async deliveries(
    owner: Owner | null,
    opts: {
      endpointId?: string | null;
      eventId?: string | null;
      status?: string | null;
      stationId?: string | null;
      limit: number;
      startingAfter?: string | null;
    },
  ): Promise<[WebhookDelivery[], boolean]> {
    const where = [];
    if (opts.stationId) where.push(eq(webhookDeliveries.stationId, opts.stationId));
    if (owner) where.push(eq(webhookDeliveries.stationId, owner.stationId), eq(webhookDeliveries.livemode, owner.livemode));
    if (opts.endpointId) where.push(eq(webhookDeliveries.endpointId, opts.endpointId));
    if (opts.eventId) where.push(eq(webhookDeliveries.eventId, opts.eventId));
    if (opts.status) where.push(eq(webhookDeliveries.status, opts.status));
    if (opts.startingAfter) where.push(lt(webhookDeliveries.id, opts.startingAfter));
    const rows = await this.tx
      .select()
      .from(webhookDeliveries)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(webhookDeliveries.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  async delivery(owner: Owner | null, id: string): Promise<[WebhookDelivery, WebhookDeliveryAttempt[]]> {
    const where = [eq(webhookDeliveries.id, id)];
    if (owner) where.push(eq(webhookDeliveries.stationId, owner.stationId), eq(webhookDeliveries.livemode, owner.livemode));
    const [d] = await this.tx
      .select()
      .from(webhookDeliveries)
      .where(and(...where));
    if (!d) throw new NotFoundError(`webhook delivery ${id} not found`, { code: ErrorCode.WEBHOOK_DELIVERY_NOT_FOUND });
    const attempts = await this.tx
      .select()
      .from(webhookDeliveryAttempts)
      .where(eq(webhookDeliveryAttempts.deliveryId, id))
      .orderBy(asc(webhookDeliveryAttempts.id));
    return [d, attempts];
  }

  /** Manual replay: a fresh single-attempt delivery of the same event to the same endpoint. */
  async replay(owner: Owner | null, deliveryId: string): Promise<WebhookDelivery> {
    const [original] = await this.delivery(owner, deliveryId);
    const ep = await this.get(null, original.endpointId);
    if (ep.status !== "enabled") throw new InvalidRequestError(`webhook endpoint ${ep.id} is ${ep.status}`);
    const [row] = await this.tx
      .insert(webhookDeliveries)
      .values({
        id: newId(IdPrefix.WEBHOOK_DELIVERY),
        eventId: original.eventId,
        endpointId: original.endpointId,
        stationId: original.stationId,
        livemode: original.livemode,
        eventType: original.eventType,
        status: "pending",
        attempts: 0,
        maxAttempts: 1,
        nextAttemptAt: sql`now()`,
        replayOf: original.id,
      })
      .returning();
    return row!;
  }

  async events(
    owner: Owner,
    opts: { limit: number; startingAfter?: string | null; type?: string | null },
  ): Promise<[OutboxEvent[], boolean]> {
    const where = [eq(outboxEvents.stationId, owner.stationId), eq(outboxEvents.livemode, owner.livemode)];
    if (opts.startingAfter) where.push(lt(outboxEvents.id, opts.startingAfter));
    if (opts.type) where.push(eq(outboxEvents.type, opts.type));
    const rows = await this.tx
      .select()
      .from(outboxEvents)
      .where(and(...where))
      .orderBy(desc(outboxEvents.id))
      .limit(opts.limit + 1);
    return [rows.slice(0, opts.limit), rows.length > opts.limit];
  }

  async event(owner: Owner, id: string): Promise<OutboxEvent> {
    const [e] = await this.tx
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.stationId, owner.stationId), eq(outboxEvents.livemode, owner.livemode)));
    if (!e) throw new NotFoundError(`event ${id} not found`, { code: ErrorCode.EVENT_NOT_FOUND });
    return e;
  }

  async endpointsByIds(ids: string[]): Promise<WebhookEndpoint[]> {
    return ids.length ? this.tx.select().from(webhookEndpoints).where(inArray(webhookEndpoints.id, ids)) : [];
  }
}
