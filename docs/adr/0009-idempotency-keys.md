# ADR-0009: Mandatory idempotency keys on public POSTs

* Status: accepted
* Date: 2026-11-17
* Deciders: Payments

## Decision

* Every `POST /v1/*` requires an `Idempotency-Key` header: 1-255 printable ASCII
  characters, no spaces. Without one, the request fails with `MR_IDEMPOTENCY_KEY_REQUIRED`.
* Keys are scoped to (Station, mode). The stored row holds the request digest
  (`SHA-256(method \n path \n raw body)`) and the full response.
* The `in_progress` row is committed **before** the handler runs; it acts as the lock.
  The handler's writes and the stored response then commit in **one** transaction.
* What happens when the same key arrives again:

  | State | Result |
  |---|---|
  | Same digest, completed | Stored response replayed, with `Idempotent-Replayed: true`. 4xx errors are replayed too. |
  | Different digest | `MR_IDEMPOTENCY_KEY_REUSED` (409) |
  | Still in progress | `MR_IDEMPOTENCY_KEY_IN_PROGRESS` (409). If the lock is older than 60 s, the new request takes over. |
  | Handler failed with 5xx or crashed | Row deleted, so a retry runs fresh |

* Railyard (`/internal/v1`) POSTs are staff actions. They are audited (ADR-0010) but do
  not take idempotency keys.

## Consequences

* Rows accumulate. A TTL cleanup job (24 h) is still to be written.
