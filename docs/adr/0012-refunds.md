# ADR-0012: Refunds

* Status: accepted
* Date: 2026-11-18
* Deciders: Payments, Ledger

## Context

Merchants refund captured payments in full or in part, often several times per payment, and
sometimes need the money back with the customer the same day. Refunds move real money, so they
must be idempotent, auditable in the ledger, and never exceed what was captured.

## Decision

* `POST /v1/payments/:id/refunds` creates a refund in `pending`; Junction resolves it to
  `processed` or `failed` via a signed callback (`refund.processed` / `refund.failed`).
* **Limit:** captured − non-failed refunds − open/lost disputes. The payment row is locked
  (`SELECT … FOR UPDATE`) while this is computed, so concurrent refunds cannot overshoot.
  Exceeding it is `422 MR_REFUND_AMOUNT_EXCEEDED` (with `details.refundable`).
* **Speed:** `normal` (free) or `instant` (card/UPI only): fee = 50 bps of the amount
  (half-up) + 18% GST on the fee (half-even), charged to the merchant.
* **Ledger:** at creation `refund_initiated` (merchant_balance → refunds_payable) and, for
  instant refunds, `refund_fee` (merchant_balance → mintrail_fees + gst_payable). On
  `processed`, `refund_paid` (refunds_payable → customer_funds). On `failed`, both are reversed.
  Debiting at creation means a refund cannot be settled out from under itself.
* **MDR is not returned.** The merchant is debited the gross amount; a merchant without enough
  balance gets `422 MR_INSUFFICIENT_BALANCE` (as real Indian gateways do).
* Idempotency: the standard `Idempotency-Key` contract (ADR-0009); Junction dedupes by refund id.
* Events: `refund.created`, `refund.processed`, `refund.failed` via the outbox (ADR-0013).

## Consequences

* A merchant whose only payment is being refunded in full needs balance from elsewhere.
  Tests, the SDK example and the seed account for this.
* Refunds after settlement are deducted from the next settlement (ADR-0014).
