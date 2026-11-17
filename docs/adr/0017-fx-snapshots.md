# ADR-0017: Currency and FX snapshots

* Status: accepted
* Date: 2026-11-18
* Deciders: Ledger, Finance

## Context

INR is the primary currency. International card payments are captured in USD and settled to
merchants in INR.

## Decision

* Amounts stay bigint minor units in their own currency throughout. USD payments, fees, GST,
  refunds and disputes are all booked in USD ledger accounts.
* **Snapshots:** one USD→INR rate per IST day in `fx_rates` (decimal stored as
  `numeric(20,10)`, never a float), fetched from Junction's simulated feed by the Depot worker
  and reused for every conversion that day. `GET /v1/fx_rates/latest` exposes it.
* **Math:** decimal.js (`@mintrail/shared/fx`). We convert minor units to minor units and round
  once, half-even:

  `inr_paise = round_half_even(usd_cents × rate × 10^(2−2))`

  Banker's rounding avoids a systematic bias over many conversions.
* **Settlement:** a USD batch is computed in USD, then converted at the day's snapshot. The
  settlement row records `fx_rate` and `fx_rate_id`. The ledger transaction is balanced per
  currency: merchant_balance (USD) → customer_funds (USD), which is treasury selling the USD,
  and customer_funds (INR) → settlement_clearing (INR).

## Consequences

* FX gain/loss between capture and settlement is not tracked separately; treasury converts at
  the snapshot rate on settlement day.
