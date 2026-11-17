/**
 * Signal's engine.
 *
 *   dispatch():  outbox_events (undispatched) ──▶ one webhook_deliveries row per matching endpoint
 *   deliverDue(): claim due deliveries (lease) ──▶ POST signed JSON via undici ──▶ attempt log
 *                 2xx → succeeded; otherwise retry with exponential backoff + jitter,
 *                 or ``failed`` after max attempts.
 *
 * All scheduling uses the database clock (``now()``), so app/DB clock skew
 * cannot make a due delivery look like it is in the future.
 */
import { Agent, request } from "undici";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { type Db, IdPrefix, log, newId, type SecretBox, signatures, stringifyJson } from "@mintrail/shared";

import { EndpointService } from "./endpoints.js";
import { eventOut } from "./out.js";
import { outboxEvents, webhookDeliveries, webhookDeliveryAttempts, type WebhookDelivery, webhookEndpoints } from "./schema.js";
import { isPrivateAddress } from "./urls.js";

export const SIGNATURE_HEADER = "MintRail-Signature";
export const USER_AGENT = "MintRail-Signal/1.0 (+https://mintrail.example/docs/webhooks)";

export interface SignalOptions {
  secretBox: SecretBox;
  maxAttempts: number;
  backoffBaseS: number;
  backoffCapS: number;
  backoffScale: number;
  timeoutMs: number;
  concurrency: number;
  graceS: number;
  /** dev/test: allow delivering to loopback / private addresses. */
  allowPrivate: boolean;
  random?: () => number;
}

/** Exponential backoff with "equal jitter": half fixed, half random. Seconds before attempt ``attempt + 1``. */
export function backoffSeconds(
  attempt: number,
  o: Pick<SignalOptions, "backoffBaseS" | "backoffCapS" | "backoffScale">,
  random = Math.random,
): number {
  const ceiling = Math.min(o.backoffCapS, o.backoffBaseS * 2 ** Math.max(0, attempt - 1));
  return (ceiling / 2 + random() * (ceiling / 2)) * o.backoffScale;
}

/** Reject DNS answers that resolve to private addresses (SSRF), unless allowed. */
function guardedAgent(allowPrivate: boolean, timeoutMs: number): Agent {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connectTimeout: timeoutMs,
    connect: allowPrivate
      ? {}
      : {
          lookup: (hostname, options, cb) => {
            dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
              if (err) return cb(err, "", 0);
              const list = addresses as LookupAddress[];
              const bad = list.find((a) => isPrivateAddress(a.address));
              if (bad) return cb(new Error(`refusing to deliver to private address ${bad.address}`), "", 0);
              const first = list[0]!;
              if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
              cb(null, first.address, first.family);
            });
          },
        },
  });
}

export class SignalEngine {
  private readonly agent: Agent;

  constructor(
    readonly db: Db,
    readonly opts: SignalOptions,
  ) {
    this.agent = guardedAgent(opts.allowPrivate, opts.timeoutMs);
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  /** Fan out up to ``limit`` undispatched outbox events. Returns events dispatched. */
  async dispatch(limit = 200): Promise<number> {
    return this.db.transaction(async (tx) => {
      const events = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.dispatchedAt))
        .orderBy(outboxEvents.seq)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (events.length === 0) return 0;
      const owners = [...new Set(events.map((e) => e.stationId))];
      const endpoints = await tx
        .select()
        .from(webhookEndpoints)
        .where(and(inArray(webhookEndpoints.stationId, owners), eq(webhookEndpoints.status, "enabled")));
      const rows: Record<string, unknown>[] = [];
      for (const e of events) {
        for (const ep of endpoints) {
          if (ep.stationId !== e.stationId || ep.livemode !== e.livemode) continue;
          if (!ep.enabledEvents.includes("*") && !ep.enabledEvents.includes(e.type)) continue;
          rows.push({
            id: newId(IdPrefix.WEBHOOK_DELIVERY),
            eventId: e.id,
            endpointId: ep.id,
            stationId: e.stationId,
            livemode: e.livemode,
            eventType: e.type,
            status: "pending",
            attempts: 0,
            maxAttempts: this.opts.maxAttempts,
            nextAttemptAt: sql`now()`,
          });
        }
      }
      if (rows.length) await tx.insert(webhookDeliveries).values(rows as (typeof webhookDeliveries.$inferInsert)[]);
      await tx
        .update(outboxEvents)
        .set({ dispatchedAt: sql`now()` })
        .where(
          inArray(
            outboxEvents.id,
            events.map((e) => e.id),
          ),
        );
      return events.length;
    });
  }

  /** Claim due deliveries (and stale leases) and send them concurrently. Returns attempts made. */
  async deliverDue(limit = this.opts.concurrency): Promise<number> {
    const claimed = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          sql`(${webhookDeliveries.status} = 'pending' AND ${webhookDeliveries.nextAttemptAt} <= now())
              OR (${webhookDeliveries.status} = 'sending' AND ${webhookDeliveries.leaseUntil} < now())`,
        )
        .orderBy(webhookDeliveries.nextAttemptAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      const leaseS = Math.ceil(this.opts.timeoutMs / 1000) + 30;
      return tx
        .update(webhookDeliveries)
        .set({ status: "sending", leaseUntil: sql`now() + make_interval(secs => ${leaseS})`, updatedAt: sql`now()` })
        .where(
          inArray(
            webhookDeliveries.id,
            due.map((d) => d.id),
          ),
        )
        .returning();
    });
    await Promise.all(claimed.map((d) => this.send(d)));
    return claimed.length;
  }

  /** Dispatch everything, then deliver until nothing is due. Test / CLI helper. */
  async drain(maxRounds = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = (await this.dispatch()) + (await this.deliverDue());
      total += n;
      if (n === 0) return total;
    }
    return total;
  }

  private async send(d: WebhookDelivery): Promise<void> {
    const [[event], [ep]] = await Promise.all([
      this.db.select().from(outboxEvents).where(eq(outboxEvents.id, d.eventId)),
      this.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, d.endpointId)),
    ]);
    const attempt = d.attempts + 1;
    if (!event || !ep || ep.status !== "enabled") {
      await this.finish(d, attempt, {
        ok: false,
        final: true,
        statusCode: null,
        error: "endpoint disabled or deleted",
        ms: 0,
        excerpt: null,
      });
      return;
    }
    const svc = new EndpointService(this.db, {
      secretBox: this.opts.secretBox,
      allowLocal: true,
      graceS: this.opts.graceS,
      maxAttempts: d.maxAttempts,
    });
    const body = stringifyJson(eventOut(event));
    const t = Math.floor(Date.now() / 1000);
    const sig = [`t=${t}`, ...svc.secretsFor(ep).map((s) => `v1=${signatures.compute(s, t, body)}`)].join(",");
    const started = performance.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    let excerpt: string | null = null;
    try {
      const res = await request(ep.url, {
        method: "POST",
        dispatcher: this.agent,
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          [SIGNATURE_HEADER.toLowerCase()]: sig,
          "mintrail-event-id": event.id,
          "mintrail-event-type": event.type,
          "mintrail-delivery-id": d.id,
        },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      statusCode = res.statusCode;
      excerpt = (await res.body.text()).slice(0, 500) || null;
    } catch (e) {
      error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 500);
    }
    const ms = Math.round(performance.now() - started);
    const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
    if (!ok) error ??= `endpoint answered ${statusCode}`;
    await this.finish(d, attempt, { ok, final: ok || attempt >= d.maxAttempts, statusCode, error: ok ? null : error, ms, excerpt });
  }

  private async finish(
    d: WebhookDelivery,
    attempt: number,
    r: { ok: boolean; final: boolean; statusCode: number | null; error: string | null; ms: number; excerpt: string | null },
  ): Promise<void> {
    const delay = backoffSeconds(attempt, this.opts, this.opts.random);
    await this.db.transaction(async (tx) => {
      await tx.insert(webhookDeliveryAttempts).values({
        deliveryId: d.id,
        attempt,
        statusCode: r.statusCode,
        error: r.error,
        durationMs: r.ms,
        responseExcerpt: r.excerpt,
      });
      await tx
        .update(webhookDeliveries)
        .set({
          attempts: attempt,
          status: r.ok ? "succeeded" : r.final ? "failed" : "pending",
          lastStatusCode: r.statusCode,
          lastError: r.error,
          leaseUntil: null,
          nextAttemptAt: r.final ? null : sql`now() + make_interval(secs => ${delay})`,
          completedAt: r.final ? sql`now()` : null,
          updatedAt: sql`now()`,
        })
        .where(eq(webhookDeliveries.id, d.id));
    });
    if (!r.ok)
      log.warn({ delivery_id: d.id, endpoint_id: d.endpointId, attempt, status: r.statusCode, final: r.final }, "webhook delivery failed");
  }
}
