# ADR-0011: Migrate the backend from Python/FastAPI to Express + TypeScript

* Status: accepted — **owner sign-off required for the differences listed below**
* Date: 2026-11-17
* Deciders: Platform, Payments, Ledger, Security

## Context

M1 shipped in Python (FastAPI, SQLAlchemy, Alembic, pytest). MintRail has standardised on
TypeScript end to end: Express 5 services and Next.js front ends. Running two backend
languages would double tooling, hiring surface and review load. M1.5 moves every M1
service to the TypeScript stack **without changing external behaviour**. It adds no
features.

## Decision

* **Stack**: Node.js 22 LTS, Express 5, TypeScript (strict), a pnpm workspace
  (`packages/shared`, `ledger`, `conductor`, `junction`, `api`, plus empty `depot`/`signal`).
  Data access uses Drizzle ORM 0.45 with drizzle-kit, validation uses Zod 4 (OpenAPI
  generated with zod-to-openapi and served at `/openapi.json`), logging uses pino with
  redaction, and tests use Vitest 5, fast-check and Testcontainers.
* **Money is `bigint` end to end.** Request JSON is parsed using the JSON source text, so
  integer literals become `bigint`, and `10.0` stays a float and is rejected where an
  integer is required. Responses write `bigint` as bare JSON numbers (`JSON.rawJSON`). jsonb
  columns round-trip integers as `bigint`. The ESLint rule `mintrail/no-number-money`
  rejects `number` on money-named fields and `z.number()` in money-named schema properties.
* **Database**: one Drizzle schema that matches M1 *exactly*, including M1's inherited
  double-prefixed check-constraint names (`ck_stations_ck_stations_mcc_format`). These
  are kept rather than renamed so that no data migration is needed. The baseline
  migration is drizzle-kit's DDL plus M1's trigger functions. Existing M1 databases
  (`alembic_version = '0002'`) are **adopted**: the baseline is recorded as applied with
  Drizzle's own hash and no DDL runs. The Alembic history is archived, not executed,
  under `docs/legacy/alembic/`.
* **Wire compatibility with data created under M1** is kept byte for byte, for:
  * API key hashes: HMAC-SHA256 with the pepper.
  * Request-signing key derivation, the canonical string and the 300 s window.
  * AES-256-GCM blobs: `0x01 ‖ nonce ‖ ct ‖ tag`, with the AAD bound to the row id.
  * scrypt staff hashes (`scrypt$16384$8$1$…`) and staff session token hashes.
  * Ledger transaction fingerprints. These reproduce Python's
    `json.dumps(sort_keys, separators, ensure_ascii)`, so an idempotent replay of an
    M1-era capture still replays.
  * Junction's seeded outcomes. `PyRandom` is a port of CPython's MT19937, including
    `seed(str)`, `random()`, `uniform()` and `choices()`.

## How parity was proven

1. **The contract was frozen before any Node code was written.**
   `docs/contract/openapi-m1.json` holds the FastAPI OpenAPI document and
   `docs/contract/schema-m1.sql` holds a `pg_dump --schema-only`. Reference vectors were
   recorded from the Python code (`tests/parity/fixtures/python-vectors.json`): money
   formatting and rounding (about 2,400 division cases), ID encoding, key hashes,
   signatures, AES-GCM blobs, scrypt hashes, fingerprints, Conductor rule outputs, and
   1,800 seeded Junction plans. Rows created by Python were dumped together with their
   secrets (`m1-legacy-rows.json`).
2. **A black-box parity harness** (`tests/parity`, TypeScript) runs **211 HTTP scenarios**
   covering every M1 endpoint and error path. For each one it records the status, selected
   headers, the normalised body, and the side effects across every M1 table: ledger,
   jobs, audit, payment events, idempotency records, Junction state and so on. The goldens
   were recorded from the Python stack and replayed twice against it to prove they are
   deterministic. Two harness bugs were found and fixed that way.
3. **Results**:

   | Target | Run | Result |
   |---|---|---|
   | Node, local | first run | 203 / 211 |
   | Node, local | after fixes | 211 / 211, twice |
   | Python, Docker | final harness | 211 / 211 |
   | Node, Docker | final harness | 211 / 211 |

   The fixes behind the jump from 203 were a `charset=utf-8` that Express appended to
   Junction's Content-Type, and two harness normalisations (below). In the end the same
   goldens pass on both implementations.
4. **Permanent checks**:
   * the schema-contract test: a freshly migrated database `pg_dump`s identically to
     `schema-m1.sql`, an M1 database is adopted in place, and an older Alembic revision
     is refused;
   * the legacy-credential test: Python-created keys, signing blobs and staff passwords
     work on Node;
   * the vector tests.

## Differences (intentional) — owner sign-off required

| # | Difference | Why |
|---|---|---|
| 1 | `MR_VALIDATION_FAILED` **message text** differs: Pydantic wording before, Zod wording now. Status, code and `param` are identical; the harness compares everything except this one string. | The wording comes from the framework, and reproducing Pydantic's English for every constraint would mean a second validation library. Clients key on `code` and `param`. |
| 2 | New **security headers** from helmet (CSP disabled for JSON APIs), **CORS allowlist** (`MINTRAIL_CORS_ALLOWED_ORIGINS`, empty by default, so no cross-origin access, the same as M1), and a **1 MiB body limit**. A larger body returns `413 MR_INVALID_REQUEST`; M1 had no limit. | Required by the company stack (STACK: helmet, CORS allowlist, body size limits). Purely additive for every request M1 accepted below 1 MiB. |
| 3 | **Rate limiting keeps M1's Postgres GCRA**, not `express-rate-limit`. Same buckets, limits, `RateLimit-*` and `Retry-After` behaviour. | The STACK names `express-rate-limit`, but its fixed-window semantics would change burst behaviour, which parity forbids. GCRA is now merchant-scoped middleware in the route wrapper. Revisit with a GCRA store if desired. |
| 4 | `/docs` (FastAPI's Swagger UI) is gone; `/openapi.json` remains, now generated from the Zod request schemas. Its structure differs from FastAPI's document; the frozen M1 document stays in `docs/contract/` for reference. | No UI framework in the API process; the OpenAPI JSON is the contract artefact. |
| 5 | Harness normalisations added after recording, applied identically to both implementations: client **IPs** (Docker NAT vs localhost), and **payment-event ids**. A duplicate callback hitting `ON CONFLICT DO NOTHING` burns an identity value at a point decided by worker interleaving, so only event *order and content* are contractual. | Neither is a behaviour of the code; both depend on the environment or a race. |
| 6 | The ESLint money rule and `bigint`-typed internals. | Stricter, invisible on the wire. |

Nothing else differs: status codes, error codes and messages (other than #1), parameters,
headers, JSON shapes, database rows, job rows, ledger postings and audit entries are all
covered by the harness.

## Consequences

* The Python services, tests, Alembic and Python tooling are deleted. `docs/contract/`, the
  parity harness and its goldens stay permanently and run in CI, so future phases can
  check they don't drift.
* A database at any Alembic revision before `0002` must be brought to `0002` with the
  M1 release first; the migrator refuses to adopt it otherwise.
* New schema changes go through `pnpm db:generate` (drizzle-kit) and are reviewed like any
  migration. Triggers and functions must be written into the generated SQL by hand.
