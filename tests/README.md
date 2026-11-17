# Cross-service tests

Service-level tests live next to each service (`api/test`, `ledger/test`, …).

- `e2e/money-path.int.test.ts` — the M1 acceptance flow (merchant → signed request → UPI via
  Junction → ledger balances).
- `support/` — the Vitest global setup (Testcontainers Postgres + real migrations), DB helpers
  and the `useHarness()` fixture.
- `parity/` — the **parity harness**: black-box HTTP scenarios replayed against a running
  stack and compared with goldens. It holds:
  - 211 **M1 contract** goldens recorded from the original Python implementation, plus
    reference vectors (`fixtures/`), kept permanently (ADR-0011). Three were re-recorded in M2
    for intentional changes: new staff permissions in `staff/login-me-logout` and
    `staff/create-and-disable`, and `refunds:write` becoming a real scope in
    `keys/scope-normalisation`.
  - 18 **M2 regression** goldens (`golden/m2/…`, recorded from Node): refunds, disputes,
    payouts, webhooks (a real receiver on this host), settlements via Depot's API, dashboard and
    Railyard. They snapshot the M2 tables too.

  Run against `make up` with `MINTRAIL_JUNCTION_LATENCY_SCALE=0` and
  `MINTRAIL_DEPOT_SCHEDULER_ENABLED=false`. Re-record with
  `PARITY_RECORD=1 PARITY_ONLY=<regex> make parity` and say why in the PR.
