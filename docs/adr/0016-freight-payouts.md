# ADR-0016: Freight — payouts

* Status: accepted
* Date: 2026-11-18
* Deciders: Payments, Finance, Security

## Decision

* Payouts are paid from the Station's merchant_balance (INR only) to a bank account
  (IMPS/NEFT/RTGS: account number + IFSC) or a VPA (UPI). Per-rail limits apply: IMPS ≤ ₹5L,
  UPI ≤ ₹1L, RTGS ≥ ₹2L.
* **Funds are reserved at creation:** `payout_initiated` (merchant_balance → payouts_clearing).
  `payout.processed` posts `payout_paid` (payouts_clearing → customer_funds); a failure,
  rejection or cancellation posts `payout_reversed`.
* **Daily limit** per IST day (`station_policies.payout_daily_limit`): failed, rejected and
  cancelled payouts don't count. Creation is serialised per Station with a transaction-scoped
  advisory lock, so concurrent requests cannot race past the limit.
* **Approval:** amounts ≥ `payout_approval_threshold` wait in `pending_approval` for **one**
  Railyard approver with `payouts:approve` (finance/admin). Approve → `queued`; reject → funds
  returned. Both are audited. Merchants may cancel while pending. (Maker-checker with two
  approvers is future work.)
* **Bulk CSV:** a multipart upload (≤ 1 MB, ≤ 1000 rows, amounts in rupees). Each row is created
  in its own savepoint; bad rows are reported with line numbers and the good ones proceed
  (`payout_batches`).
* Junction simulates the bank: account ending `0000` fails with `invalid_account`, ending
  `1111` fails with `beneficiary_bank_offline`; otherwise the payout is processed with a UTR.
* Events: `payout.processed`, `payout.failed`.
