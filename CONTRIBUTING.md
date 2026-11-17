# Contributing to MintRail

> MintRail is a fictional company created to demonstrate AgentGuard; not affiliated with any real business.

## Setup

```bash
corepack enable        # pnpm (version pinned in package.json)
pnpm install
cp .env.example .env
make up                # postgres + migrations + api + junction + workers
make test              # needs Docker (Testcontainers)
```

## Before you open a PR

```bash
make fmt               # eslint --fix + prettier --write
make lint              # ESLint (incl. mintrail/no-number-money) + Prettier check
make typecheck         # tsc --noEmit, strict
make coverage          # all tests, 85% gate on api/ and ledger/
```

CI runs these steps plus the parity harness, the Docker stack and the M1 demo. All of them
must pass.

## Workspace layout

Each service is a pnpm workspace package with `src/`, `test/` and its own `package.json`:
`packages/shared`, `ledger`, `conductor`, `junction`, `api`. Packages export `src/*.ts`
under the `development` condition (used by Vitest, tsx and tsc) and `dist/*.js` otherwise
(used in Docker). Import shared code as `@mintrail/shared`, never by relative path across
packages.

Test files are named `*.test.ts` for unit tests (no database or network) and
`*.int.test.ts` for integration tests, which use real Postgres via `tests/support`.

## Rules for money code

These are hard rules. A PR review will block on any of them.

1. **No JS `number` for money.** Amounts are `bigint` minor units wrapped in `Money`. Request
   bodies are parsed with `parseJson`, which gives `bigint`; use `strictInt()` in Zod schemas.
   The `mintrail/no-number-money` lint rule catches most slips.
2. **Rounding is explicit.** `applyBps`, `applyRatio` and `divRound` take a `Rounding`. To
   split an amount, use `Money.allocate`, which never loses a paisa.
3. **The ledger is append-only.** Write only through `LedgerService.post` / `reverse` or
   a function in `ledger/src/recipes.ts`. To fix a mistake, post a reversal and never update
   the old rows. The database rejects `UPDATE` and `DELETE` on journal rows.
4. **Every money movement is idempotent.** Derive the idempotency key from the business
   object (`capture:<pay_id>`), not from a random value or a timestamp.
5. **Test and live never mix.** Pass `livemode` through explicitly. Don't default it.
6. **Callers own transactions.** Services take a `Tx`. Route handlers and job handlers open
   it with `db.transaction(...)`.

## Payments rules

7. **Never store a PAN or CVV**, not even in logs or job payloads. Keep the BIN, last 4 and
   the keyed fingerprint only (`api/src/payment-methods.ts`).
8. **Every public POST is idempotent.** Use `idempotent: true` in the route spec, and do the
   work inside `c.idem.run(tx => …)` so the writes and the stored response commit together.
9. **Payment state changes go through `PaymentService`.** It records a `payment_events` row
   for each change. Read the transition table in ADR-0008 before adding a status.
10. **Every Railyard mutation writes an audit entry** (`AuditService.record`) in the same
    transaction.
11. **Junction is an external bank.** Platform code must never import `@mintrail/junction`;
    only tests and `tests/support` may.

## M2 rules

12. **State changes emit events in the same transaction.** Call `emit(tx, …)` from
    `@mintrail/signal` next to the write. Never publish after commit (ADR-0013).
13. **Money movements reserve funds first.** Refunds and payouts debit the merchant when they
    are created and are reversed if they fail. Never wait for the bank to debit.
14. **Uploads use the route's `upload` spec** (multer, memory storage, hard size/count limits).
    Check file _content_, not names or declared types.
15. **Web apps call the API server-side only.** Session tokens stay in httpOnly cookies, and
    every Server Action checks the CSRF token (`csrfOk`) before doing anything.
16. **Settlement logic changes need a property test** showing that `amount = Σ entries =
gross − fees − GST` still holds and reconciliation still reports zero mismatches.

## Error codes

New failure modes get a new `ErrorCode` entry (`MR_<UPPER_SNAKE>`) and an
`HTTP_STATUS_BY_CODE` mapping in `packages/shared/src/errors.ts`. Codes are part of the
public API: never rename or reuse one.

## Database changes

- Change the Drizzle schema in the owning package (`*/src/schema*.ts`), then
  `pnpm db:generate --name <slug>` and review the generated SQL in `drizzle/`.
- Triggers and functions are hand-written into the migration SQL; Drizzle can't express them.
- The schema-contract test pins the M1 baseline. A _new_ migration changes the schema
  deliberately: update `docs/contract/` in the same PR, together with a note in the PR
  description.

## Behaviour changes and the parity harness

`tests/parity` replays 211 recorded M1 scenarios. If your change alters an M1 response or
side effect on purpose, re-record the affected goldens (`PARITY_RECORD=1 PARITY_ONLY=<regex>
make parity`), commit them with the change, and explain why in the PR. Unintended diffs
are bugs.

## Commits and reviews

- Use conventional-style subjects, for example `ledger: reject reversal of a reversal`.
- For API and flow tests, use `useHarness()` from `tests/support/harness.ts`. It runs Platform
  and Junction on ephemeral ports plus both workers; call `h().drain()` to run the jobs.
- [CODEOWNERS](.github/CODEOWNERS) decides who reviews. `ledger/`, `drizzle/` and
  `packages/shared/src/money.ts` need @mintrail/ledger; keys, signing and crypto need
  @mintrail/security.
- Architectural changes need an ADR in `docs/adr/` (copy `0000-template.md`).
