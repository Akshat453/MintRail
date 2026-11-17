# Platform API

Owned by **@mintrail/payments**. A Express 5 app served at `https://api.mintrail.example`
(locally `http://localhost:8000`, with OpenAPI at `/openapi.json`).
Run it with `node api/dist/main-server.js`; the payments worker is `node api/dist/main-worker.js` and migrations are `node api/dist/main-migrate.js`.

## Authentication ([ADR-0006](../docs/adr/0006-merchant-api-authentication.md))

- Test mode: `Authorization: Bearer mr_test_…`
- Signed (required for live keys): `MintRail-Key-Id` + `MintRail-Signature: t=…,v1=…`.
  See `api/src/signing.ts` (`signRequest`) for the reference client.
- Every public POST needs an `Idempotency-Key` ([ADR-0009](../docs/adr/0009-idempotency-keys.md)).
- Rate limits are per Station and mode; responses carry `RateLimit-*` headers.

## Public endpoints

| Method   | Path                                                        | Scope                          |
| -------- | ----------------------------------------------------------- | ------------------------------ |
| GET      | `/v1/station`                                               | `station:read`                 |
| PATCH    | `/v1/station/settings` (`webhook_url`, `auto_capture`)      | `station:write`                |
| GET      | `/v1/balance`                                               | `balance:read`                 |
| POST/GET | `/v1/orders`, `/v1/orders/{id}`, `/v1/orders/{id}/payments` | `orders:write` / `orders:read` |
| POST     | `/v1/payments` (`card` \| `upi` \| `netbanking`)            | `payments:write`               |
| GET      | `/v1/payments`, `/v1/payments/{id}`                         | `payments:read`                |
| POST     | `/v1/payments/{id}/capture`                                 | `payments:write`               |

## Railyard — `/internal/v1` (staff session token; [ADR-0010](../docs/adr/0010-railyard-staff-auth-and-audit.md))

`auth/login|logout|me` · `staff` · `audit_log` · `stations` (create, list, search, get,
`settings`, `kyc/verify|reject|reopen`, `suspend|reactivate`, `api_keys`) ·
`api_keys/{id}/revoke` · `payments/{id}` (with event log) · `payments/review_queue` ·
`payments/{id}/risk_review` · `risk/blocklist` · `ledger/trial_balance|reconcile`.

## Junction callbacks

`POST /internal/junction/v1/callbacks`, authenticated by `Junction-Signature`.

## Errors

```json
{ "error": { "code": "MR_INVALID_SIGNATURE", "message": "…", "request_id": "req_01…" } }
```
