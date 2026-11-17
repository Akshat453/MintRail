# ADR-0014: Depot — settlements, reserves and reconciliation

* Status: accepted
* Date: 2026-11-18
* Deciders: Ledger, Finance, Payments

## Context

Merchants are paid out daily on a T+N schedule (`settlement_schedule` T+1/T+2/T+3) with an IST
cutoff. Settlements must net fees, GST, refunds, payouts, chargebacks and rolling reserves,
must be explainable line by line (CSV), and must reconcile with the ledger every day.

## Decision

One batch per (Station, mode, currency, IST business date D).

* **Credits enter after the cutoff:** captured payments (net of MDR + GST), failed-refund and
  failed/rejected/cancelled-payout reversals, reserve releases due by D, dispute releases. The
  cutoff is the end of business day D−N at `MINTRAIL_SETTLEMENT_CUTOFF_HOUR_IST`:00 IST
  (0 = midnight), computed with Luxon in `Asia/Kolkata`.
* **Debits apply as soon as they happen:** refunds (+ instant fee + GST), payouts. This keeps
  `net ≤ merchant balance` by construction.
* **Rolling reserve:** `reserve_bps` of the batch's payment net is held for
  `reserve_hold_days` (entry `reserve_hold`, `release_on`), and released by a later batch.
* **Chargebacks:** disputes debit the Station's `dispute_reserve` account, which may go
  negative (the merchant owes it). Each batch recovers that debt up to the batch net
  (`dispute_recovery`), or returns a positive balance from won disputes (`dispute_release`).
  A recovery may consume the whole batch, which gives a zero-amount settlement.
* **Invariant:** `amount = Σ entries = Σ gross − Σ fees − Σ GST`. It is enforced by check
  constraints on both tables and by property tests.
* **Ledger:** sweeps move money between merchant_balance and the reserve / dispute_reserve
  sub-accounts; `settlement_initiated` moves the net to settlement_clearing; `depot.bank_credit`
  later posts `settlement_paid` with a UTR and emits `settlement.processed`.
* Each item can be settled once: `UNIQUE (kind, reference_id)` on `settlement_entries`. Scans
  start at the previous batch's cutoff or run time, with a 2-day overlap for late commits.
* **Scheduling:** the Depot worker enqueues the FX snapshot and the settlement run once per
  IST day (deduplicated); reconciliation runs after every run. Railyard (finance) can request
  runs; runs are idempotent per batch.
* **Reconciliation** writes a report every run. The checks:
  * entries = settlement;
  * settlement = `settlement_initiated` debit;
  * processed ⇒ `settlement_paid`;
  * every settled payment, refund and payout equals its own ledger movement;
  * per-merchant balance identity (ledger merchant_balance = source-table movements +
    sweeps − settlements);
  * ledger cache drift;
  * trial balance.
* Depot is a library plus a small internal API (run, reconcile, report CSV; service token)
  plus a worker. Settlement data lives in Platform's schema so Platform can serve it.

## Consequences

* Holidays and bank cut-offs are not modelled: batches settle every day (NEFT/RTGS run 24×7
  in this simulation).
* Seed data runs the real engine day by day, so seeded settlements reconcile exactly.
