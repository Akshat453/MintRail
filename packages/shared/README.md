# @mintrail/shared — shared building blocks

Owned by **@mintrail/platform**. Service-agnostic code used by every package.

| Module          | What                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `money.ts`      | `Money` (`bigint` minor units), currencies, `Rounding`, `divRound`, `allocate`, Indian formatting ([ADR-0002](../../docs/adr/0002-money-as-integer-minor-units.md)) |
| `json.ts`       | `parseJson` (integers → `bigint` via the JSON source text) / `stringifyJson` (`bigint` → JSON number)                                                               |
| `ids.ts`        | `newId(IdPrefix.PAYMENT)` → `pay_01…`, `parseId`, `idTimestampMs`                                                                                                   |
| `errors.ts`     | `ErrorCode` (`MR_*`), `MintRailError` and subclasses, the HTTP status map                                                                                           |
| `pyrepr.ts`     | Python `repr()` for strings, so error messages stay byte-identical to M1                                                                                            |
| `config.ts`     | `Settings` from `MINTRAIL_*` env vars (`.env` as a fallback); refuses placeholder secrets in staging and prod                                                       |
| `crypto.ts`     | AES-256-GCM `SecretBox`, scrypt passwords, HMAC helpers, tokens (all wire-compatible with M1)                                                                       |
| `signatures.ts` | `t=…,v1=…` HMAC signatures (request signing, Junction callbacks)                                                                                                    |
| `db.ts`         | pg pool, Drizzle, `jsonbExact` / `bytea` columns, the `apiTime` formatter                                                                                           |
| `jobs.ts`       | Postgres job queue: `enqueue`, `claim` (SKIP LOCKED), `complete`, `fail` ([ADR-0004](../../docs/adr/0004-postgres-job-queue.md))                                    |
| `worker.ts`     | `Worker` loop with graceful SIGTERM drain, `JobRegistry`, `PermanentJobError`                                                                                       |
| `migrate.ts`    | Drizzle migrator that adopts M1/Alembic databases                                                                                                                   |
| `log.ts`        | pino with `request_id` / `job_id` context and secret redaction                                                                                                      |

```ts
import { Money } from "@mintrail/shared";

Money.fromMajor("1499.00", "INR").applyBps(200n, "half_up"); // ₹29.98
Money.of(100n, "INR").allocate([1n, 1n, 1n]); // 34, 33, 33
```
