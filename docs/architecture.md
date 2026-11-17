# MintRail architecture

> MintRail is a fictional company created to demonstrate AgentGuard; not affiliated with any real business.

## Services (as of M2)

```
 merchants ── API keys (signed live) ─┐   Dashboard (Next.js :3000) ─┐   Railyard (Next.js :3100) ─┐
 @mintrail/node SDK ──────────────────┤      dss_ session, server-side│      rys_ session, server-side│
                                      ▼                               ▼                               ▼
                ┌──────────────────────────── Platform API (Express :8000) ─────────────────────────────┐
                │ /v1/*            orders · payments · refunds · disputes · payouts · webhooks · events  │
                │                  settlements · fx_rates · balance · station                            │
                │ /dashboard/v1/*  same handlers + overview, filters, keys, CSV reports (role-checked)   │
                │ /internal/v1/*   Railyard: KYC, merchants, risk, disputes, payout approvals, replay,   │
                │                  settlements & reconciliation, policies, Derailments, audit           │
                │ /internal/junction/v1/callbacks ◀── signed bank callbacks ─────────────────────┐      │
                └──┬───────────┬──────────────┬──────────────────┬───────────────────────────────┼──────┘
       in-process  │           │ outbox_events│ jobs (payments)  │ jobs (depot)                  │
              Conductor · Ledger      │       payments-worker ──HTTP──▶ Junction (:8100) ── junction-worker
                                      ▼        submit · capture ·        bank simulator: auth, capture,
                          Signal worker ◀ LISTEN refunds · payouts ·     refunds, chargebacks, payouts,
                          (+ Signal :8200)       dispute deadlines        FX feed
                          fan-out → signed POSTs                 Depot worker (+ Depot :8300)
                          to merchant endpoints                  daily T+N settlements, reserves,
                                                                 bank credits, reconciliation
```

There are two images: `infra/docker/Dockerfile` for every Node service and
`infra/docker/Dockerfile.ui` for the two Next.js apps. Compose starts `postgres`, `migrate`,
`api`, `junction`, `signal`, `depot`, the workers (`payments-worker`, `junction-worker`,
`ledger-worker`, `signal-worker`, `depot-worker`) and `dashboard` + `railyard`.

## Data ownership (ADR-0001)

| Owner | Tables |
|---|---|
| shared | `jobs` |
| Ledger | `ledger_accounts`, `ledger_balances`, `ledger_transactions`, `ledger_postings` |
| Platform | M1 tables plus `refunds`, `disputes`, `dispute_evidence`, `payouts`, `payout_batches`, `station_policies`, `dashboard_users`, `dashboard_sessions`, `derailments`, `derailment_notes`, `junction_inbox` |
| Platform (written by Depot) | `settlements`, `settlement_entries`, `reconciliation_reports`, `reconciliation_items`, `fx_rates` |
| Signal | `outbox_events`, `webhook_endpoints`, `webhook_deliveries`, `webhook_delivery_attempts` |
| Conductor | `conductor_blocklist` |
| Junction | `junction_authorizations`, `junction_refunds`, `junction_disputes`, `junction_payouts` (simulated bank; reached only over HTTP) |

## The money path

1. `POST /v1/orders` → `POST /v1/payments` → Junction authorises → `capture` posts MDR + 18% GST.
   (M1 unchanged: ADR-0008.)
2. **Refunds** (ADR-0012) debit the merchant at creation, are paid out by Junction, and are
   reversed if the bank fails them.
3. **Disputes** (ADR-0015) withdraw the amount into the Station's `dispute_reserve`; won returns
   it, lost pays the network.
4. **Payouts** (ADR-0016) reserve funds at creation, wait for Railyard approval above a
   threshold, and are paid or returned by Junction.
5. **Settlements** (ADR-0014): Depot nets credits after the T+N IST cutoff against debits
   immediately, holds a rolling reserve, recovers chargebacks, converts USD at the day's FX
   snapshot (ADR-0017), and then reconciles everything with the ledger.
6. **Webhooks** (ADR-0013): every state change above emits an outbox event in the same
   transaction; Signal delivers it signed, with retries and replay.

| Ledger event | Dr | Cr |
|---|---|---|
| capture | customer_funds | merchant_balance, mintrail_fees, gst_payable |
| refund initiated (+ instant fee) | merchant_balance | refunds_payable (+ mintrail_fees, gst_payable) |
| refund paid / failed | refunds_payable / reversal | customer_funds / reversal |
| dispute opened / won / lost | dispute_reserve / dispute_clearing / dispute_clearing | dispute_clearing / dispute_reserve / customer_funds |
| payout initiated / paid / returned | merchant_balance / payouts_clearing / reversal | payouts_clearing / customer_funds / reversal |
| reserve hold / release, dispute sweep | merchant_balance ⇄ reserve / dispute_reserve | |
| settlement initiated (INR) | merchant_balance | settlement_clearing |
| settlement initiated (USD) | merchant_balance (USD); customer_funds (INR) | customer_funds (USD); settlement_clearing (INR) |
| settlement paid | settlement_clearing | customer_funds |

## Request lifecycle (Platform)

1. Middleware assigns `X-Request-Id`, adds `MintRail-Version` and `RateLimit-*` headers, and logs one line.
2. Authentication is one of:
   * a bearer key (test mode) or an HMAC signature (ADR-0006), then the GCRA rate limit and
     scopes;
   * a dashboard session plus `MintRail-Mode` and a role check;
   * a staff session plus a permission check.
3. Multipart uploads (dispute evidence, bulk payout CSV) go through multer with hard limits;
   everything else is read raw (1 MiB).
4. POSTs go through `Idempotency.run`: the handler's writes, its outbox events and the stored
   response commit together (ADR-0009).
5. Errors are `{"error": {"code": "MR_…", "message", "param", "request_id"}}`.

## Incidents

A **Derailment** threatens money correctness. Code that detects one logs `DERAILMENT: …`
with a `derailment` field. Producers:
* ledger cache drift;
* a bank failure event for a payment that already succeeded;
* an undecryptable signing key;
* a chargeback for an unknown payment;
* a settlement that would exceed the merchant's balance;
* reconciliation mismatches.

Railyard records incidents and their timelines (`/derailments`).
