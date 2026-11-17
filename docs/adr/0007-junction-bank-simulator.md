# ADR-0007: Junction — a deterministic bank simulator behind a real HTTP boundary

* Status: accepted
* Date: 2026-11-17
* Deciders: Payments

## Context

The hard parts of payments are the failure modes: declines, timeouts, slow and duplicate
callbacks, callbacks in the wrong order, banks that briefly fail. These have to be
reproducible in tests and in demos, and they have to be impossible to trigger in
production.

## Decision

* Junction is a **separate service** (`junction/`): its own FastAPI app, its own worker,
  and its own table (`junction_authorizations`). Platform reaches it only over HTTP
  (`POST /v1/authorizations`, `GET ?payment_id=`, `/capture`, `/void`) with a service
  key. Results come back as **HMAC-signed callbacks** (`Junction-Signature`, same
  `t=,v1=` scheme) to `/internal/junction/v1/callbacks`. It shares the Postgres instance
  for convenience only and never touches Platform tables.
* Each outcome is a `Plan` (final result, latency, duplicates, ordering), chosen from:
  1. the test-mode header `MintRail-Test-Scenario`: `success`, `decline:<code>`,
     `timeout`, `delayed:<s>`, `duplicate_callbacks`, `out_of_order`, `flaky`,
     `late_success`;
  2. magic test instruments, for example `failure@mintrail` or card `4000 0000 0000 0002`;
  3. otherwise a seeded draw, `Random(f"{MINTRAIL_JUNCTION_SEED}:{payment_id}")`, using
     realistic per-method success rates (UPI 93%, card 89%, netbanking 86%) and
     decline-code mixes.
* Live mode ignores both scenarios and magic instruments. Platform also rejects the
  scenario header for live keys (`MR_SCENARIO_NOT_ALLOWED`).
* Events have a per-authorization `sequence`, and every delivery is a job, so retries,
  duplicates and reordering all come from the job queue. `MINTRAIL_JUNCTION_LATENCY_SCALE`
  shrinks the simulated latency; tests use 0.
* Authorization is idempotent on `payment_id`. That makes Platform's submit retries safe.

## Consequences

* Platform's payment code is written against a realistic, unreliable dependency. That is
  the point.
* A real acquirer integration later replaces Junction behind the same client interface
  (`mintrail_api/junction_client.py`).
