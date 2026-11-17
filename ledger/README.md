# Ledger

Owned by **@mintrail/ledger**. MintRail's append-only, double-entry ledger
([ADR-0003](../docs/adr/0003-double-entry-ledger.md)).

## Using it

Most callers should use a **recipe**:

```ts
import { computeCaptureBreakdown, LedgerService, recordCapture } from "@mintrail/ledger";

const breakdown = computeCaptureBreakdown(Money.of(100_000n, "INR"), { feeBps: 200n });
await db.transaction((tx) => recordCapture(new LedgerService(tx), { stationId, paymentId, breakdown, livemode: false }));
// the caller owns the transaction
```

| Recipe                        | Dr                  | Cr                                           |
| ----------------------------- | ------------------- | -------------------------------------------- |
| `record_capture`              | customer_funds      | merchant_balance, mintrail_fees, gst_payable |
| `record_refund_initiated`     | merchant_balance    | refunds_payable                              |
| `record_refund_paid`          | refunds_payable     | customer_funds                               |
| `record_settlement_initiated` | merchant_balance    | settlement_clearing                          |
| `record_settlement_paid`      | settlement_clearing | customer_funds                               |

Platform calls `record_capture` today. The refund and settlement recipes are ready for
Depot and refunds (M2).

Lower-level calls are `ledger.post({ idempotencyKey, description, lines })` and `ledger.reverse(id, { idempotencyKey })`. All amounts are `bigint`.

## Guarantees

- Balanced per currency, checked in TypeScript **and** by a deferred DB constraint trigger.
- Non-negative accounts can't be overdrawn, even under concurrency (row locks in
  account-id order).
- Idempotent. A replay returns the original transaction (`replayed=True`). Reusing a key
  for a different movement raises `MR_IDEMPOTENCY_KEY_REUSED`.
- Immutable. The DB rejects `UPDATE` and `DELETE` on transactions and postings.
- Test and live accounts are separate, and one transaction can't touch both.

## Chart of accounts

See `src/chart.ts`. Codes look like `station:<mer>:<test|live>:merchant_balance:<CUR>`
and `platform:<test|live>:<customer_funds|mintrail_fees|gst_payable|refunds_payable|settlement_clearing>:<CUR>`.

## Worker

`node ledger/dist/main.js` (compose: `ledger-worker`) serves the `ledger` queue.

| Job                         | Purpose                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `ledger.reconcile_balances` | Recompute balances from postings. Logs a `DERAILMENT` on drift |
