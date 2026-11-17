/**
 * @mintrail/node example: a payment, a refund, and verified webhooks — end to end.
 *
 *   MINTRAIL_API_KEY=mr_test_…  MINTRAIL_API_URL=http://localhost:8000  pnpm --filter @mintrail/node example
 *
 * Starts a tiny webhook receiver, registers it as an endpoint, makes a ₹499 UPI
 * payment, refunds ₹100 of it, and waits until MintRail has delivered
 * payment.captured, refund.created and refund.processed — each one verified with
 * the endpoint's signing secret. Exits non-zero if anything is missing.
 *
 * When the API runs in Docker (``make up``), MintRail reaches this receiver at
 * ``host.docker.internal`` (override with MINTRAIL_WEBHOOK_HOST).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { MintRail, type MintRailEvent, WebhookSignatureError } from "../src/index.js";

const apiKey = process.env.MINTRAIL_API_KEY;
if (!apiKey) {
  console.error("Set MINTRAIL_API_KEY to a test key (make seed writes some to .mintrail/demo-keys.json).");
  process.exit(2);
}
const mr = new MintRail({ apiKey, baseUrl: process.env.MINTRAIL_API_URL ?? "http://localhost:8000" });
const hookHost = process.env.MINTRAIL_WEBHOOK_HOST ?? "host.docker.internal";
const WANT = ["payment.captured", "refund.created", "refund.processed"] as const;
const rupees = (paise: bigint) => `₹${paise / 100n}.${String(paise % 100n).padStart(2, "0")}`;

let secret = "";
const received = new Map<string, MintRailEvent>();
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    try {
      const event = MintRail.webhooks.constructEvent<MintRailEvent>(raw, String(req.headers["mintrail-signature"] ?? ""), secret);
      received.set(event.type, event);
      console.log(`  ✓ webhook ${event.type.padEnd(18)} ${event.id} (signature verified)`);
      res.writeHead(200).end();
    } catch (e) {
      console.log(`  ✗ webhook rejected: ${(e as Error).message}`);
      res.writeHead(e instanceof WebhookSignatureError ? 400 : 500).end();
    }
  });
});
await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
const port = (server.address() as AddressInfo).port;

const until = async <T>(what: string, fn: () => Promise<T | null>, timeoutMs = 60_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

try {
  const ep = await mr.webhookEndpoints.create({
    url: `http://${hookHost}:${port}/mintrail/webhooks`,
    description: "SDK example",
    enabled_events: [...WANT],
  });
  secret = ep.secret!;
  console.log(`endpoint ${ep.id} → ${ep.url} (secret …${ep.secret_hint})`);

  const order = await mr.orders.create({ amount: 49_900n, receipt: `sdk-example-${Date.now()}` });
  const payment = await mr.payments.create({
    order_id: order.id,
    method: "upi",
    upi: { vpa: "success@mintrail" },
    email: "asha@example.com",
  });
  console.log(`payment  ${payment.id} ${rupees(payment.amount)} via UPI — ${payment.status}`);
  const captured = await until("capture", async () => {
    const p = await mr.payments.retrieve(payment.id);
    if (p.status === "failed") throw new Error(`payment failed: ${p.error_code}`);
    return p.status === "captured" ? p : null;
  });
  console.log(`         captured; fee ${rupees(captured.fee!)} + GST ${rupees(captured.tax!)}`);

  const refund = await mr.refunds.create(payment.id, { amount: 10_000n, reason: "order_cancelled" });
  console.log(`refund   ${refund.id} ${rupees(refund.amount)} — ${refund.status}`);
  const processed = await until("refund", async () => {
    const r = await mr.refunds.retrieve(refund.id);
    if (r.status === "failed") throw new Error(`refund failed: ${r.error_code}`);
    return r.status === "processed" ? r : null;
  });
  console.log(`         processed (bank ref ${processed.bank_reference})`);

  await until("webhooks", async () => (WANT.every((t) => received.has(t)) ? true : null));
  await mr.webhookEndpoints.delete(ep.id);
  console.log(`\n✓ SDK example passed: payment + refund + ${received.size} verified webhooks`);
} catch (e) {
  console.error(`\n✗ SDK example failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  server.close();
}
