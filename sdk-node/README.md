# @mintrail/node

The Node.js client for the MintRail API (fictional). It's typed, has no dependencies (Node ≥ 22),
and handles money as **bigint** minor units end to end.

```ts
import { MintRail } from "@mintrail/node";

const mr = new MintRail({ apiKey: process.env.MINTRAIL_API_KEY! }); // mr_test_… (Bearer)
// Live keys sign every request:
// new MintRail({ apiKey: process.env.MINTRAIL_LIVE_KEY!, keyId: "key_…" })

const order = await mr.orders.create({ amount: 49_900n, receipt: "rcpt_1042" }); // ₹499.00
const payment = await mr.payments.create({ order_id: order.id, method: "upi", upi: { vpa: "asha@okhdfcbank" } });

const refund = await mr.refunds.create(payment.id, { amount: 10_000n, reason: "order_cancelled", speed: "instant" });

for await (const p of mr.paginate(mr.payments.list, { status: "captured", limit: 100 })) {
  console.log(p.id, p.amount); // bigint
}
```

## Retries and idempotency

Every POST gets an `Idempotency-Key` (generate your own and pass `{ idempotencyKey }` to make
retries span process restarts). Network errors, `429`, `5xx` and `MR_IDEMPOTENCY_KEY_IN_PROGRESS`
are retried with exponential backoff and jitter, honouring `Retry-After` and always reusing
**the same key**, so a retry never charges, refunds or pays out twice. Errors are typed:
`MintRailError` (`status`, `code`, `param`, `requestId`, `details`) and `MintRailConnectionError`.

## Webhooks

```ts
import express from "express";
import { MintRail, WebhookSignatureError } from "@mintrail/node";

app.post("/webhooks/mintrail", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = MintRail.webhooks.constructEvent(req.body, req.get("MintRail-Signature")!, process.env.MINTRAIL_WEBHOOK_SECRET!);
    if (event.type === "refund.processed") markRefunded(event.data.object);
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(e instanceof WebhookSignatureError ? 400 : 500);
  }
});
```

Verify the **raw** body. During secret rotation the header carries two `v1=` signatures; either
one verifies. Deliveries are at least once, so dedupe on `event.id`.

## Resources

`station`, `balance`, `orders`, `payments` (incl. `capture`, `simulateDispute` in test mode),
`refunds`, `disputes` (`addEvidence` multipart, `submit`, `accept`), `payouts` (`bulk` CSV,
`cancel`), `settlements` (`entries`, `report` CSV), `fxRates`, `webhookEndpoints`
(`rotateSecret`), `webhookDeliveries` (`replay`), `events`.

## Example and tests

```bash
MINTRAIL_API_KEY=mr_test_… MINTRAIL_API_URL=http://localhost:18000 pnpm --filter @mintrail/node example
pnpm vitest run --project integration sdk-node    # against a running Platform (the integration harness)
```

The example makes a payment, refunds part of it, and verifies the `payment.captured`,
`refund.created` and `refund.processed` webhooks it receives (`make demo` runs it).
