# ADR-0006: Merchant API authentication — bearer keys, signed requests, scopes, rate limits

* Status: accepted
* Date: 2026-11-17
* Deciders: Payments, Security

## Context

A bearer secret alone has three problems. A request captured from a log or a proxy can
be replayed. A tampered body goes unnoticed. And every integration gets full account
access. Merchants asked for restricted keys, and our auditors want live traffic to carry
integrity protection.

## Decision

**Two ways to authenticate**

* `Authorization: Bearer mr_test_…`: for test mode only.
* Signed requests, with the headers `MintRail-Key-Id: key_…` and
  `MintRail-Signature: t=<unix>,v1=<hex>`. These are **required for live keys**.
  * `v1 = HMAC-SHA256(signing_key, "<t>." + canonical)`
  * `canonical = METHOD \n PATH \n QUERY \n hex(SHA-256(raw body))`
  * `signing_key = HMAC-SHA256(api_secret, "mintrail-request-signing-v1")`. The client
    derives it from the secret it already has, so there is no second credential.
  * A timestamp more than **300 s** from server time is rejected with `MR_REQUEST_EXPIRED`.
    A bad MAC gets `MR_INVALID_SIGNATURE`. Several `v1=` entries are accepted, so a
    client can sign with two keys while rotating.

**Key storage**

* `secret_hash = HMAC-SHA256(pepper, secret)`. This is what bearer lookup uses (ADR-0005).
* `signing_key_enc = AES-256-GCM(MINTRAIL_SECRETS_KEY, signing_key, aad=key_id)`.
  The server has to be able to *read* the signing key in order to verify a MAC, so it is
  encrypted rather than hashed. The AAD binds each ciphertext to its own row. Keys issued
  before migration 0002 have no signing key and keep working with bearer auth.

**Scopes**: `station:read|write`, `balance:read`, `orders:read|write`,
`payments:read|write`. A key holds either `*` or an explicit list. A missing scope
returns `MR_INSUFFICIENT_SCOPE` (403).

**Rate limits**: GCRA per Station and mode, with state in `rate_limit_state` (a single
atomic upsert, so it works across processes with no Redis). Each Station has its own
`rate_limit_per_sec` / `rate_limit_burst` (defaults 25/s, burst 50). Every response
carries `RateLimit-Limit` and `RateLimit-Remaining`. A limited request gets `429` with
`MR_RATE_LIMITED` and `Retry-After`. If the limiter's database is unavailable, requests
**fail open**: losing rate limits is better than losing payments.

## Consequences

* Losing `MINTRAIL_SECRETS_KEY` makes signed requests impossible until keys are reissued.
  Rotating it needs re-encryption, which is not built yet.
* Within the 5-minute window, nothing stops a replay of a signed GET. POST replays are
  covered by mandatory idempotency keys (ADR-0009).
