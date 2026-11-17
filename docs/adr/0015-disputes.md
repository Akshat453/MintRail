# ADR-0015: Disputes (chargebacks)

* Status: accepted
* Date: 2026-11-18
* Deciders: Payments, Ledger, Risk

## Decision

* Disputes originate at the network: Junction sends `dispute.opened`. In test mode a merchant
  (or Railyard ops) can ask Junction to open one with `POST …/simulate_dispute`. The dispute
  starts in `needs_response`, with `evidence_due_by` = opened + `MINTRAIL_DISPUTE_RESPONSE_DAYS`
  (7).
* **Evidence:** multipart upload (multer, memory storage, `limits.fileSize` 5 MB, 5 files,
  field limits). Files are accepted only if their *content* is PDF, PNG or JPEG (magic bytes),
  whatever the declared type or name; names are sanitised; SHA-256 is stored. A text statement
  is allowed too.
* **Outcomes:**
  * `submit` → `under_review` → Junction decides → `won` or `lost`;
  * `accept` → `lost` immediately;
  * missing the deadline → `lost` ("evidence deadline passed"), via a scheduled job.
* **Ledger:**
  * opened: dispute_reserve (station, may go negative) → dispute_clearing;
  * won: dispute_clearing → dispute_reserve;
  * lost: dispute_clearing → customer_funds.

  Depot recovers or returns the dispute_reserve balance in settlements (ADR-0014).
* Disputed amounts (open or lost) are no longer refundable.
* Events: `dispute.created`, `dispute.closed`.

## Consequences

* Evidence lives in Postgres (bytea); production would use object storage behind the same API.
* No dispute fee is charged in this simulation.
