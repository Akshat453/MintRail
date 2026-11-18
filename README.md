# MintRail

> **MintRail is a fictional company created to demonstrate AgentGuard; not affiliated with any real business.**

MintRail is a payments platform for Indian businesses — founded 2022 in Bengaluru, about 120
people. Merchants ("Stations") accept UPI, cards and netbanking through one API and get settled
to their bank account on a schedule.

This repository is the MintRail backend monorepo: **TypeScript on Node.js 22**, Express 5,
Drizzle + PostgreSQL 16, and a pnpm workspace.

## Rail map

| Name          | What it is                                                                                                            | Where                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Platform**  | Public HTTP API (`https://api.mintrail.example`): orders, payments, refunds, disputes, payouts, webhooks, settlements | [`api/`](api/)                         |
| **Station**   | A merchant account (`mer_…`) with KYC, settings and money policy                                                      | `api/`                                 |
| **Ledger**    | Append-only double-entry ledger                                                                                       | [`ledger/`](ledger/)                   |
| **Junction**  | Bank / UPI / card-network simulator: auth, refunds, chargebacks, payouts, FX                                          | [`junction/`](junction/)               |
| **Conductor** | Risk checks: limits, blocklists, velocity                                                                             | [`conductor/`](conductor/)             |
| **Signal**    | Webhooks: transactional outbox → signed deliveries, retries, replay                                                   | [`signal/`](signal/)                   |
| **Depot**     | Settlements: T+N with IST cutoff, fees + GST, reserves, FX, reconciliation                                            | [`depot/`](depot/)                     |
| **Freight**   | Payouts to bank accounts / VPAs, bulk CSV, approvals                                                                  | `api/`                                 |
| **Dashboard** | Merchant dashboard (Next.js)                                                                                          | [`dashboard/`](dashboard/)             |
| **Railyard**  | Internal ops console (Next.js) + `/internal/v1` API                                                                   | [`railyard/`](railyard/) · `api/`      |
| SDK           | `@mintrail/node`: typed client, signing, retries, webhook verification                                                | [`sdk-node/`](sdk-node/)               |
| —             | Shared: money (bigint), FX, IST dates, IDs, errors, crypto, DB, job queue                                             | [`packages/shared/`](packages/shared/) |

A **Derailment** is an incident. Anything that logs `DERAILMENT:` pages on-call; Railyard keeps
the timeline.

## Quick start

You need Docker, Node.js 22 (`.nvmrc`), and pnpm via corepack (`corepack enable`).

```bash
cp .env.example .env   # placeholders only; `make up` does this if missing
make up                # postgres → migrate → api, junction, signal, depot, 5 workers, dashboard, railyard
make migrate           # idempotent; re-runs migrations + bootstrap admin
make seed              # 50 merchants, ~200k payments over 90 days, settlements, payouts, webhooks (≈4 min)
make test              # unit + integration (Testcontainers) + Playwright smoke of both UIs
make demo              # M1 demo + SDK payment → refund → verified webhooks + clean reconciliation
```

| What         | Where                                      | Sign in                                                           |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------- |
| Platform API | <http://localhost:18000> (`/openapi.json`) | `mr_test_…` keys in `.mintrail/demo-keys.json`                    |
| Dashboard    | <http://localhost:13000>                   | `owner@kesari-threads.example` (any `owner@<slug>.example`)       |
| Railyard     | <http://localhost:13100>                   | `riya@` / `arjun@` / `meera@` / `kabir@` / `dev@mintrail.example` |

Seeded passwords are in `.mintrail/demo-keys.json` (git-ignored, local only).

To start from scratch instead, run `make fresh` (wipes every merchant and demo login, keeps only
the bootstrap Railyard admin from `.env`) and create your own account at
<http://localhost:13000/signup>. `make seed` brings the demo data back (the UI, parity and
planted-bug tests need it).

Host ports use the 1xxxx range (Postgres 15432, API 18000, Junction 18100, Signal 18200,
Depot 18300, Dashboard 13000, Railyard 13100) so MintRail can run next to other local stacks.
If one is still taken, change the `MINTRAIL_*_PORT` variables (and the matching URLs) in `.env`.

Test-mode outcomes are controlled with `MintRail-Test-Scenario` (e.g. `decline:insufficient_funds`,
`refund_fail`, `payout_fail`) or magic instruments; see [junction/README.md](junction/README.md).

## Development

```bash
pnpm install
make test              # unit + integration + e2e (Testcontainers) + UI smoke (needs `make up seed`)
make test-unit         # no Docker needed
make coverage          # full suite with the 85% gate on api/ and ledger/
make lint              # ESLint (incl. mintrail/no-number-money) + Prettier
make typecheck         # tsc --noEmit, strict, every package
make test-ui           # Playwright smoke for Dashboard + Railyard only
make parity            # 211 M1 contract goldens + 18 M2 regression goldens against `make up`
```

Integration tests use Testcontainers by default. To reuse an existing database instead,
set `MINTRAIL_TEST_DATABASE_URL`. **That database will be wiped.**

## Conventions

- **Money** is `bigint` minor units (paise) via `Money` in `@mintrail/shared`, never JS
  `number`; a lint rule enforces this. Any operation that could produce a fraction takes an
  explicit `Rounding`. — [ADR-0002](docs/adr/0002-money-as-integer-minor-units.md)
- **IDs** are prefixed and time-sortable: `mer_`, `key_`, `ord_`, `pay_`, `rfd_`, `dsp_`,
  `stl_`, `pout_`, `whk_`, `evt_`. — [ADR-0005](docs/adr/0005-identifiers-and-api-keys.md)
- **API keys** look like `mr_test_…` / `mr_live_…` and are stored as peppered HMACs. Live keys must
  **sign** requests (HMAC, 5-minute window), and every public POST needs an
  `Idempotency-Key`. — [ADR-0006](docs/adr/0006-merchant-api-authentication.md), [ADR-0009](docs/adr/0009-idempotency-keys.md)
- **Errors** use stable `MR_<UPPER_SNAKE>` codes in a `{"error": {...}}` envelope.
- **Test and live** data never share a ledger account.
- **Ledger writes** go through `LedgerService.post` and are idempotent. — [ADR-0003](docs/adr/0003-double-entry-ledger.md)
- **Background work** uses the Postgres job table. — [ADR-0004](docs/adr/0004-postgres-job-queue.md)
- **The M1 contract is frozen** in [`docs/contract/`](docs/contract/), and CI replays it on every
  change. — [ADR-0011](docs/adr/0011-migrate-backend-to-express-typescript.md)
- **Every state change emits an event** in the same transaction (outbox) — [ADR-0013](docs/adr/0013-signal-webhooks-outbox.md).
  M2 decisions: refunds [0012](docs/adr/0012-refunds.md), settlements [0014](docs/adr/0014-depot-settlements-and-reconciliation.md),
  disputes [0015](docs/adr/0015-disputes.md), payouts [0016](docs/adr/0016-freight-payouts.md),
  FX [0017](docs/adr/0017-fx-snapshots.md), web apps [0018](docs/adr/0018-dashboard-and-railyard-ui.md).

See [docs/architecture.md](docs/architecture.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
