# ADR-0013: Signal — webhooks from a transactional outbox

* Status: accepted
* Date: 2026-11-18
* Deciders: Platform, Payments, Security

## Context

Merchants need to learn about state changes (payments, refunds, settlements, disputes,
payouts) without polling. Delivery must be at-least-once, must not lose events when a
transaction commits but a process dies before sending, and must never deliver an event for a
change that rolled back.

## Decision

* **Transactional outbox.** Producers call `emit(tx, …)` inside the transaction that changes
  state; it inserts into `outbox_events`. An `AFTER INSERT` trigger runs
  `pg_notify('mintrail_outbox', id)`.
* **Signal worker** `LISTEN`s on `mintrail_outbox` for immediate wake-ups and polls every
  `MINTRAIL_SIGNAL_POLL_INTERVAL_S` as the fallback (a missed NOTIFY only adds latency). It fans
  each event out to one `webhook_deliveries` row per enabled, subscribed endpoint (same Station
  and mode), marking the event dispatched in the same transaction.
* **Delivery:** claimed with `FOR UPDATE SKIP LOCKED` and a lease (stale leases are reclaimed);
  POSTed with undici (connect/headers/body timeouts `MINTRAIL_SIGNAL_TIMEOUT_MS`). 2xx = success.
  Otherwise retry with exponential backoff and equal jitter (`base·2ⁿ⁻¹` capped at 6 h,
  ½ fixed + ½ random), up to `MINTRAIL_SIGNAL_MAX_ATTEMPTS` (10, ~2 days), then `failed`.
  Every attempt is logged in the append-only `webhook_delivery_attempts`. All scheduling uses
  the database clock.
* **Signing:** `MintRail-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + body)>`, the
  same scheme as Junction callbacks. Per-endpoint `whsec_…` secrets are AES-GCM encrypted at
  rest and shown only on create/rotate. **Rotation** keeps the old secret valid for 24 h
  (`MINTRAIL_SIGNAL_SECRET_GRACE_S`); during the window each delivery carries two `v1=`
  values, so receivers verify either.
* **Replay:** creates a new single-attempt delivery linked by `replay_of` (merchant via API /
  dashboard; staff via Railyard, audited).
* **SSRF:** production endpoints must be https and must not be private, loopback or link-local
  addresses — checked at registration and again at DNS resolution time. dev/test allow
  localhost and `host.docker.internal`.
* Signal is a library (`@mintrail/signal`, used by Platform for `/v1/webhook_endpoints`) plus
  its own service (health, stats, replay) and worker.

## Consequences

* Delivery is at-least-once; receivers dedupe on the event id (`MintRail-Event-Id`).
* The outbox table grows forever; archiving dispatched events is future work.
