# Junction — bank simulator

Owned by **@mintrail/payments**. It is a separate service (`node junction/dist/main-server.js`, port 8100) with its own worker (`node junction/dist/main-worker.js`). Seeded outcomes use `PyRandom`, a bit-exact port of CPython's `random.Random`, so a seed means the same thing it did in M1. See [ADR-0007](../docs/adr/0007-junction-bank-simulator.md).

## HTTP API (called by Platform; `Authorization: Bearer $MINTRAIL_JUNCTION_API_KEY`)

| Method | Path                                                          |                                                               |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------- |
| POST   | `/v1/authorizations`                                          | 202 plus `ref` (`JN` + 12 digits). Idempotent on `payment_id` |
| GET    | `/v1/authorizations?payment_id=` / `/v1/authorizations/{ref}` | Status inquiry                                                |
| POST   | `/v1/authorizations/{ref}/capture`                            | Full amount only                                              |
| POST   | `/v1/authorizations/{ref}/void`                               | Releases a pending or authorized hold                         |

Junction reports outcomes as signed callbacks (`Junction-Signature: t=…,v1=…`) to
`MINTRAIL_JUNCTION_CALLBACK_URL`. The events are `authorization.pending` (seq 1) and
`authorization.succeeded` or `authorization.failed` (seq 2).

## Test controls (test mode only)

Header on `POST /v1/payments`: `MintRail-Test-Scenario: <scenario>`

| Scenario              | Behaviour                                                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`             | authorizes (UPI sends `pending` first)                                                                                                                                                                                                          |
| `decline:<code>`      | declines with `insufficient_funds`, `card_declined`, `do_not_honor`, `expired_card`, `incorrect_cvv`, `upi_collect_declined`, `upi_collect_expired`, `upi_invalid_vpa`, `bank_unavailable`, `netbanking_cancelled` or `risk_declined_by_issuer` |
| `timeout`             | never resolves; Platform fails the payment with `gateway_timeout` after 15 min                                                                                                                                                                  |
| `delayed:<s>`         | authorizes after `s` seconds (multiplied by the latency scale)                                                                                                                                                                                  |
| `duplicate_callbacks` | the final event is delivered 3 times                                                                                                                                                                                                            |
| `out_of_order`        | the stale `pending` (seq 1) arrives after `succeeded` (seq 2)                                                                                                                                                                                   |
| `flaky`               | the first authorize call gets a 503; Platform retries                                                                                                                                                                                           |
| `late_success`        | authorizes after 20 min, after Platform has already timed out, so it gets voided                                                                                                                                                                |

Magic instruments (no header needed):

| Instrument                 | Result             |
| -------------------------- | ------------------ |
| VPA `success@mintrail`     | succeeds           |
| VPA `failure@mintrail`     | declined           |
| VPA `expired@mintrail`     | declined           |
| VPA `timeout@mintrail`     | times out          |
| Card `4111 1111 1111 1111` | succeeds           |
| Card `4000 0000 0000 0002` | declined           |
| Card `…9995`               | insufficient funds |
| Card `…0069`               | expired card       |
| Card `…0127`               | incorrect CVV      |
| Bank code `MRTEST`         | succeeds           |
| Bank code `MRFAIL`         | fails              |

Anything else gets a seeded, realistic outcome
(`MINTRAIL_JUNCTION_SEED`, deterministic per `payment_id`).

## M2: refunds, chargebacks, payouts, FX

| Endpoint                                     | What                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/refunds`                           | Refund a captured authorization (deduped by `refund_id`, can't exceed the capture) → `refund.processed` / `refund.failed` callback |
| `POST /v1/disputes`                          | Raise a chargeback on a captured authorization (test helper) → `dispute.opened`                                                    |
| `POST /v1/disputes/:ref/evidence`, `/accept` | Merchant response → `dispute.won` / `dispute.lost`                                                                                 |
| `POST /v1/payouts`                           | Pay a bank account or VPA → `payout.processed` (with UTR) / `payout.failed`                                                        |
| `GET /v1/fx/USD/INR?date=`                   | Deterministic simulated mid rate (string, 4 dp)                                                                                    |

Test controls: refund scenario `refund_fail[:reason]`; dispute outcome `win`/`lose` (default: won
if evidence was submitted); payout scenario `payout_fail[:reason]`, account ending `0000` →
`invalid_account`, ending `1111` → `beneficiary_bank_offline`.
