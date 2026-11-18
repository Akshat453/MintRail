/** Webhooks end to end: outbox → Signal → a real local receiver; signatures, retries, replay, rotation. */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { parseJson, signatures } from "@mintrail/shared";
import { verifyWebhook } from "@mintrail/signal";

import { useHarness } from "../../tests/support/harness.js";

const { h, db } = useHarness();

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function receiver(status: () => number = () => 200): Promise<{ url: string; got: Received[] }> {
  const got: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      res.writeHead(status(), { "content-type": "text/plain" }).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/mintrail`, got };
}

describe("webhooks", () => {
  test("payment.captured is delivered, signed with the endpoint secret; delivery log records it", async () => {
    const m = await h().merchant();
    const rx = await receiver();
    const ep = await h().call(m, "POST", "/v1/webhook_endpoints", { url: rx.url, enabled_events: ["payment.captured", "refund.created"] });
    expect(ep.status, ep.text).toBe(201);
    expect(ep.body.secret).toMatch(/^whsec_[A-Za-z0-9]{32}$/);
    const p = await h().paid(m, "card");
    await h().drainAll();
    expect(rx.got).toHaveLength(1); // payment.authorized is not subscribed
    const [d] = rx.got;
    const event = parseJson(d!.body) as Record<string, any>;
    expect(event).toMatchObject({
      object: "event",
      type: "payment.captured",
      livemode: false,
      data: { object: { id: p.id, status: "captured", amount: 49_900n } },
    });
    expect(d!.headers["mintrail-event-type"]).toBe("payment.captured");
    expect(() => verifyWebhook(d!.body, String(d!.headers["mintrail-signature"]), ep.body.secret)).not.toThrow();
    expect(() => verifyWebhook(d!.body, String(d!.headers["mintrail-signature"]), "whsec_wrong")).toThrow();
    const deliveries = (await h().call(m, "GET", `/v1/webhook_deliveries?endpoint_id=${ep.body.id}`)).body.data;
    expect(deliveries.map((x: { status: string; attempts: number }) => [x.status, x.attempts])).toEqual([["succeeded", 1n]]);
    const detail = (await h().call(m, "GET", `/v1/webhook_deliveries/${deliveries[0].id}`)).body;
    expect(detail.attempt_log[0]).toMatchObject({ attempt: 1n, status_code: 200n, error: null });
  });

  test("failures retry with backoff up to max attempts, then fail; manual replay re-sends once", async () => {
    let code = 500;
    const rx = await receiver(() => code);
    const m = await h().merchant();
    await h().call(m, "POST", "/v1/webhook_endpoints", { url: rx.url });
    await h().paid(m, "card");
    await h().drainAll();
    const all = (await h().call(m, "GET", "/v1/webhook_deliveries?limit=50")).body.data;
    const captured = all.find((x: { event_type: string }) => x.event_type === "payment.captured");
    expect([captured.status, captured.attempts, captured.last_status_code]).toEqual([
      "failed",
      BigInt(h().settings.signal_max_attempts),
      500n,
    ]);
    code = 200;
    const replay = await h().call(m, "POST", `/v1/webhook_deliveries/${captured.id}/replay`);
    expect([replay.status, replay.body.replay_of, replay.body.max_attempts]).toEqual([201, captured.id, 1n]);
    await h().drainAll();
    expect((await h().call(m, "GET", `/v1/webhook_deliveries/${replay.body.id}`)).body.status).toBe("succeeded");
  });

  test("backoff is real when not scaled to zero (next attempt in the future, jittered)", async () => {
    const rx = await receiver(() => 503);
    const m = await h().merchant();
    await h().call(m, "POST", "/v1/webhook_endpoints", { url: rx.url, enabled_events: ["payment.captured"] });
    h().signal.opts.backoffScale = 1;
    await h().paid(m, "card");
    await h().drainAll();
    const r = await db().execute<{ secs: string; attempts: number }>(
      sql`SELECT extract(epoch FROM next_attempt_at - now())::text AS secs, attempts FROM webhook_deliveries`,
    );
    expect(r.rows[0]!.attempts).toBe(1);
    const secs = Number(r.rows[0]!.secs);
    expect(secs).toBeGreaterThan(h().settings.signal_backoff_base_s / 2 - 2);
    expect(secs).toBeLessThanOrEqual(h().settings.signal_backoff_base_s);
  });

  test("the first retry is scheduled 22.5 s out (30 s base, half fixed + half jitter)", async () => {
    const rx = await receiver(() => 500);
    const m = await h().merchant();
    await h().call(m, "POST", "/v1/webhook_endpoints", { url: rx.url, enabled_events: ["payment.captured"] });
    h().signal.opts.backoffScale = 1;
    h().signal.opts.random = () => 0.5;
    await h().paid(m, "card");
    await h().drainAll();
    const r = await db().execute<{ at: string }>(sql`SELECT extract(epoch FROM next_attempt_at)::text AS at FROM webhook_deliveries`);
    const expected = Date.now() + 22_500;
    expect(Math.floor(Number(r.rows[0]!.at))).toBe(Math.floor(expected / 1000));
  });

  test("secret rotation: both secrets sign during the grace window; disabled endpoints get nothing", async () => {
    const rx = await receiver();
    const m = await h().merchant();
    const ep = (await h().call(m, "POST", "/v1/webhook_endpoints", { url: rx.url, enabled_events: ["payment.captured"] })).body;
    const rot = (await h().call(m, "POST", `/v1/webhook_endpoints/${ep.id}/rotate_secret`)).body;
    expect(rot.secret).not.toBe(ep.secret);
    expect(rot.previous_secret_expires_at).not.toBeNull();
    await h().paid(m, "card");
    await h().drainAll();
    const sig = String(rx.got[0]!.headers["mintrail-signature"]);
    expect(signatures.parse(sig).signatures).toHaveLength(2);
    expect(() => verifyWebhook(rx.got[0]!.body, sig, rot.secret)).not.toThrow();
    expect(() => verifyWebhook(rx.got[0]!.body, sig, ep.secret)).not.toThrow();
    await h().call(m, "PATCH", `/v1/webhook_endpoints/${ep.id}`, { status: "disabled" });
    await h().paid(m, "card");
    await h().drainAll();
    expect(rx.got).toHaveLength(1);
  });

  test("endpoint URL policy and per-mode isolation", async () => {
    const m = await h().merchant();
    const bad = await h().call(m, "POST", "/v1/webhook_endpoints", { url: "ftp://example.com/x" });
    expect(bad.body.error.param).toBe("url");
    const priv = await h().call(m, "POST", "/v1/webhook_endpoints", { url: "https://10.0.0.5/hook" });
    expect(priv.body.error.message).toContain("private");
    const unknown = await h().call(m, "POST", "/v1/webhook_endpoints", {
      url: "https://hooks.example.com/x",
      enabled_events: ["payment.exploded"],
    });
    expect(unknown.body.error.param).toBe("enabled_events");
    const other = await h().merchant();
    const ep = (await h().call(m, "POST", "/v1/webhook_endpoints", { url: "https://hooks.example.com/x" })).body;
    expect((await h().call(other, "GET", `/v1/webhook_endpoints/${ep.id}`)).status).toBe(404);
  });
});
