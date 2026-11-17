# ADR-0004: Background jobs on a PostgreSQL table with SKIP LOCKED

* Status: accepted
* Date: 2022-08-02
* Deciders: Platform Eng, DevEx

## Context

We need retries for webhooks (Signal), settlement batches (Depot) and reconciliation.
A separate broker such as Redis or SQS would split the source of truth: a job could be
enqueued for a payment whose transaction then rolled back.

## Decision

* A `jobs` table. `enqueue()` runs inside the caller's transaction, so a job exists if
  and only if the business change committed (a transactional outbox, for free).
* Workers claim jobs with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`.
  The claim commits immediately as a lease (`locked_by`, `locked_at`).
* A `running` job whose lease is older than the visibility timeout can be claimed again
  (the worker crashed). `complete`/`fail` match on `locked_by`, so a worker that lost
  its lease cannot overwrite the result.
* The handler's side effects and `status = succeeded` commit in one transaction.
* Failures are retried with capped exponential backoff and full jitter. When attempts
  run out, or a handler raises `PermanentJobError`, the job goes to `dead`.
* `dedupe_key` (unique) makes enqueueing idempotent.

## Consequences

* Throughput is bounded by Postgres, which is fine below about 1k jobs/s, far beyond
  our needs.
* Handlers must be idempotent, because a lease can expire mid-run.
