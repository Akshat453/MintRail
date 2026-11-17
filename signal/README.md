# Signal — webhooks

Owned by **@mintrail/signal**. A transactional outbox plus signed, retried deliveries (ADR-0013).

- **Library** (used by Platform):
  - `emit(tx, …)` writes outbox events;
  - `EndpointService` manages endpoints, rotates secrets, lists deliveries and events, and
    replays deliveries;
  - `verifyWebhook` is the receiver-side check.
- **Worker** (`node signal/dist/main-worker.js`): `LISTEN mintrail_outbox` with polling as the
  fallback; fans each event out to subscribed endpoints, then delivers with undici. Each request
  carries `MintRail-Signature: t=…,v1=…`, `MintRail-Event-Id`, `MintRail-Event-Type` and
  `MintRail-Delivery-Id`.
- **Service** (`:8200`, bearer `MINTRAIL_SIGNAL_API_KEY`): `/healthz`, `/internal/signal/v1/stats`,
  `/internal/signal/v1/deliveries/:id/replay`.

Events: `payment.authorized|captured|failed`, `refund.created|processed|failed`,
`settlement.processed`, `dispute.created|closed`, `payout.processed|failed`.

Retries: 30 s × 2ⁿ⁻¹ (capped at 6 h) with equal jitter, 10 attempts; every attempt is logged.
Rotation: the old secret keeps signing (a second `v1=`) for 24 h.

Verify in a receiver:

```ts
import { MintRail } from "@mintrail/node";
const event = MintRail.webhooks.constructEvent(rawBody, req.headers["mintrail-signature"], process.env.MINTRAIL_WEBHOOK_SECRET!);
```
