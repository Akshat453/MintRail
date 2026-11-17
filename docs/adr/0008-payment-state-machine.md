# ADR-0008: Payment state machine, callback ordering and timeouts

* Status: accepted
* Date: 2026-11-17
* Deciders: Payments, Ledger

## Decision

Statuses are `created → pending → authorized → captured`, and any non-terminal state can
move to `failed`. Allowed transitions are listed in `api/mintrail_api/services/payments.py`.

* **Callbacks** are recorded in `payment_events` *before* they are applied:
  * A duplicate Junction event id is acknowledged and has no effect.
  * An event whose `sequence` is ≤ the last one applied is stored with `applied=false`
    and the note "stale". This is what happens to the late `pending` after a `succeeded`.
  * A `succeeded` that arrives for an already **failed** payment is a *late
    authorization*. The payment stays failed and a void is sent to the bank, so the
    customer's funds are released.
  * A `failed` that arrives for an authorized or captured payment is ignored and logged
    as a `DERAILMENT`.
* **Timeouts**: a status check runs every 2 min (`payment_status_check_after_s`) and
  queries Junction directly. If Junction knows the outcome, it is applied (a synthetic
  event with id `inq_*`). After 15 min (`payment_timeout_s`) the payment fails with
  `gateway_timeout`, and any pending authorization is voided.
* **Capture**: automatic (via a job) unless the request or the Station's setting says
  manual. Capture is the only place a payment touches the ledger (`record_capture`:
  MDR from the fee plan, plus 18% GST). An authorization that is never captured is voided
  after 5 days (`authorization_expired`).
* **One live attempt per order**: a partial unique index allows at most one payment per
  order whose status is not `failed`.
* **Risk**: a Conductor `block` fails the payment before it reaches the bank. A `review`
  still authorizes but holds the capture until a Railyard reviewer approves (the capture
  is then enqueued) or rejects (the authorization is voided and the payment fails with
  `risk_rejected`).
