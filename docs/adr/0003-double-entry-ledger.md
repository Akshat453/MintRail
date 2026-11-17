# ADR-0003: Append-only double-entry ledger with database-enforced invariants

* Status: accepted
* Date: 2022-07-05
* Deciders: Money Movement

## Context

Balances held as a mutable `balance` column on the merchant row can't be audited,
and they drift under concurrent writes.

## Decision

* Every money movement is a `ledger_transaction` with at least two `ledger_postings`.
  In each currency, the debits equal the credits.
* Accounts carry a type (asset, liability, equity, revenue, expense). The normal-side
  balance is debits − credits for assets and expenses, and credits − debits for the others.
* `ledger_balances` caches the running totals. It is updated in the same transaction as
  the postings, under `SELECT … FOR UPDATE` taken in ascending account-id order, which
  is a global lock order, so posts cannot deadlock.
* Accounts are non-negative by default (`allow_negative = false`). The check runs
  against the locked balance.
* Every post requires an idempotency key, and a fingerprint of the money movement is
  stored with it. Replaying the same key with the same body returns the original
  transaction. The same key with a different body raises `MR_IDEMPOTENCY_KEY_REUSED`.
* Corrections are reversals. A transaction can be reversed at most once, enforced by a
  partial unique index.
* **The database enforces the invariants too**, so a bug or a manual `psql` session
  cannot corrupt the books:
  * a deferred constraint trigger rejects any transaction whose postings don't balance
    per currency, or that has fewer than two postings;
  * a trigger rejects postings whose currency differs from their account's currency;
  * triggers reject `UPDATE` and `DELETE` on `ledger_transactions` and `ledger_postings`.
* `LedgerService.reconcile()` recomputes balances from postings. The
  `ledger.reconcile_balances` job raises a Derailment if any cached balance has drifted.

## Consequences

* Changes to the ledger logic are slower to write and much safer.
* `TRUNCATE` still works (statement-level, no row triggers), which the test suite relies
  on. Production roles must not have `TRUNCATE` on ledger tables.
