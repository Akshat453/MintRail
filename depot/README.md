# Depot — settlement engine

Owned by **@mintrail/depot**. Daily settlement batches per Station, mode and currency (ADR-0014).

- `SettlementEngine.settle(station, mode, currency, date)` works like this:
  - Payments enter after the T+N cutoff (end of IST business day D−N,
    `MINTRAIL_SETTLEMENT_CUTOFF_HOUR_IST`).
  - Refunds, payouts and their reversals apply as they happen.
  - It holds the rolling reserve (`station_policies`) and recovers or returns chargebacks
    (`dispute_reserve`).
  - USD is converted at the day's FX snapshot (ADR-0017).
  - Invariant: `amount = Σ entries = gross − fees − GST`.
- `bankCredit(id)` simulates the bank credit, posts `settlement_paid` with a UTR, and emits
  `settlement.processed`.
- `reconcile(tx)` checks settlements against the ledger and writes a report (zero mismatches
  is the only acceptable result).
- **Worker** (`node depot/dist/main-worker.js`) handles queue `depot`. It runs the daily
  scheduler (FX snapshot → run → reconcile, deduplicated per IST date; disable with
  `MINTRAIL_DEPOT_SCHEDULER_ENABLED=false`) and the bank credits.
- **API** (`:8300`, bearer `MINTRAIL_DEPOT_API_KEY`): `POST /internal/depot/v1/runs {date}`,
  `POST /internal/depot/v1/reconciliations`, `GET /internal/depot/v1/settlements/:id/report.csv`.

Merchants read settlements through Platform (`/v1/settlements`, `/dashboard/v1/settlements`);
Railyard reads them through `/internal/v1/settlements` and `/internal/v1/reconciliation/latest`.
