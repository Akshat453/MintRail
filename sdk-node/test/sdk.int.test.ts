/** @mintrail/node against a running Platform API (the integration harness's real HTTP servers). */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { MintRail, MintRailError, WebhookSignatureError } from "../src/index.js";
import { useHarness } from "../../tests/support/harness.js";

const { h } = useHarness();
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

const client = async (live = false) => {
  const m = live ? await h().liveMerchant() : await h().merchant();
  return { m, mr: new MintRail({ apiKey: m.secret, keyId: live ? m.keyId : undefined, baseUrl: h().platformUrl }) };
};

describe("@mintrail/node", () => {
  test("payment → refund with typed bigint money; idempotent retries reuse the key", async () => {
    const { mr } = await client();
    const order = await mr.orders.create({ amount: 49_900n, receipt: "sdk-1" });
    expect(order.amount).toBe(49_900n);
    const pay = await mr.payments.create(
      { order_id: order.id, method: "upi", upi: { vpa: "success@mintrail" } },
      { idempotencyKey: "sdk-pay-1" },
    );
    const again = await mr.payments.create(
      { order_id: order.id, method: "upi", upi: { vpa: "success@mintrail" } },
      { idempotencyKey: "sdk-pay-1" },
    );
    expect(again.id).toBe(pay.id);
    await h().drainAll();
    const captured = await mr.payments.retrieve(pay.id);
    expect([captured.status, captured.fee! + captured.tax! < captured.amount]).toEqual(["captured", true]);
    const refund = await mr.refunds.create(pay.id, { amount: 10_000n, reason: "order_cancelled" });
    await h().drainAll();
    expect((await mr.refunds.retrieve(refund.id)).status).toBe("processed");
    expect((await mr.payments.refunds(pay.id)).data.map((r) => r.amount)).toEqual([10_000n]);
    expect((await mr.balance.retrieve("INR")).balances[0]!.balance).toBe(captured.amount - captured.fee! - captured.tax! - 10_000n);
  });

  test("live keys sign every request", async () => {
    const { mr } = await client(true);
    expect(mr.livemode).toBe(true);
    expect((await mr.station.retrieve()).live_enabled).toBe(true);
    const o = await mr.orders.create({ amount: 1_000n });
    expect(o.livemode).toBe(true);
    expect(() => new MintRail({ apiKey: "mr_live_x" })).toThrow(/keyId/);
    expect(() => new MintRail({ apiKey: "sk_nope" })).toThrow();
  });

  test("errors are typed; pagination follows cursors", async () => {
    const { mr } = await client();
    await expect(mr.payments.retrieve("pay_00000000000000000000000000")).rejects.toMatchObject({
      status: 404,
      code: "MR_PAYMENT_NOT_FOUND",
    });
    const e = await mr.orders.create({ amount: 1n }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MintRailError);
    expect((e as MintRailError).param).toBe("amount");
    for (let i = 0; i < 5; i++) await mr.orders.create({ amount: 1_000n + BigInt(i) });
    const seen: bigint[] = [];
    for await (const o of mr.paginate(mr.orders.list, { limit: 2 })) seen.push(o.amount);
    expect(seen).toEqual([1_004n, 1_003n, 1_002n, 1_001n, 1_000n]);
  });

  test("retries 5xx with the same idempotency key, then gives up", async () => {
    const keys: string[] = [];
    let calls = 0;
    const flaky: typeof fetch = async (url, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      calls += 1;
      if (calls < 3) return new Response('{"error":{"code":"MR_SERVICE_UNAVAILABLE","message":"down"}}', { status: 503 });
      return fetch(url, init);
    };
    const m = await h().merchant();
    const mr = new MintRail({ apiKey: m.secret, baseUrl: h().platformUrl, fetch: flaky });
    const o = await mr.orders.create({ amount: 2_500n });
    expect(o.amount).toBe(2_500n);
    expect(new Set(keys).size).toBe(1);
    const dead = new MintRail({ apiKey: m.secret, baseUrl: "http://127.0.0.1:9", maxRetries: 1 });
    await expect(dead.orders.list()).rejects.toThrow(/could not reach MintRail/);
  });

  test("webhook endpoint + signature verification helper on a real delivery", async () => {
    const { mr } = await client();
    const got: { body: string; sig: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push({ body, sig: String(req.headers["mintrail-signature"]) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const ep = await mr.webhookEndpoints.create({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
      enabled_events: ["payment.captured"],
    });
    const o = await mr.orders.create({ amount: 30_000n });
    await mr.payments.create({
      order_id: o.id,
      method: "card",
      card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2030, cvv: "123" },
    });
    await h().drainAll();
    const event = MintRail.webhooks.constructEvent<{ type: string; data: { object: { amount: bigint } } }>(
      got[0]!.body,
      got[0]!.sig,
      ep.secret!,
    );
    expect([event.type, event.data.object.amount]).toEqual(["payment.captured", 30_000n]);
    expect(() => MintRail.webhooks.constructEvent(got[0]!.body, got[0]!.sig, "whsec_wrong")).toThrow(WebhookSignatureError);
    expect(() => MintRail.webhooks.constructEvent(got[0]!.body.replace("30000", "30001"), got[0]!.sig, ep.secret!)).toThrow(
      WebhookSignatureError,
    );
    const deliveries = await mr.webhookDeliveries.list({ endpoint_id: ep.id });
    expect(deliveries.data[0]!.status).toBe("succeeded");
    const replay = await mr.webhookDeliveries.replay(deliveries.data[0]!.id);
    expect(replay.replay_of).toBe(deliveries.data[0]!.id);
    const rotated = await mr.webhookEndpoints.rotateSecret(ep.id);
    expect(rotated.secret).not.toBe(ep.secret);
    expect((await mr.events.list({ type: "payment.captured" })).data).toHaveLength(1);
  });

  test("disputes, payouts (incl. bulk CSV) and settlements resources", async () => {
    const { mr } = await client();
    const o = await mr.orders.create({ amount: 900_000n });
    const p = await mr.payments.create({
      order_id: o.id,
      method: "card",
      card: { number: "4111111111111111", expiry_month: 12, expiry_year: 2030, cvv: "123" },
    });
    await h().drainAll();
    await mr.payments.simulateDispute(p.id, { amount: 10_000n });
    await h().drainAll();
    const [d] = (await mr.disputes.list({ payment_id: p.id })).data;
    const withEvidence = await mr.disputes.addEvidence(d!.id, {
      files: [{ filename: "r.pdf", content: Buffer.from("%PDF-1.4\n%%EOF\n"), contentType: "application/pdf" }],
      text: "Delivered.",
    });
    expect(withEvidence.evidence).toHaveLength(1);
    expect((await mr.disputes.submit(d!.id)).status).toBe("under_review");
    const po = await mr.payouts.create({
      amount: 50_000n,
      mode: "IMPS",
      purpose: "vendor_bill",
      beneficiary: { name: "Supplier Co", account_number: "123456789012", ifsc: "HDFC0001234" },
    });
    expect((await mr.payouts.retrieve(po.id)).status).toBe("queued");
    const batch = await mr.payouts.bulk("beneficiary_name,vpa,amount,mode,purpose\nAsha K,asha@okaxis,100,UPI,salary\n");
    expect([batch.accepted_count, batch.rejected_count]).toEqual([1n, 0n]);
    expect((await mr.payouts.batch(batch.id)).payouts).toHaveLength(1);
    expect((await mr.settlements.list()).data).toEqual([]);
    await expect(mr.fxRates.latest()).rejects.toMatchObject({ code: "MR_FX_RATE_UNAVAILABLE" });
  });
});
