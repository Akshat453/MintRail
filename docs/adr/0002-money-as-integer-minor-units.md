# ADR-0002: Money is integer minor units with explicit rounding

* Status: accepted
* Date: 2022-06-20
* Deciders: Money Movement, Staff Eng

## Context

Binary floats cannot represent 0.10. Payment bugs from float maths are subtle: an
amount ends up a paisa off, nobody notices, and reconciliation fails weeks later.

## Decision

* Every amount is an `int` count of the currency's minor unit (paise, cents, yen),
  stored as `BIGINT` and wrapped in `mintrail_common.money.Money`.
* `Money` refuses `float`, `bool` and `Decimal` amounts. Major-unit input goes through
  `Money.from_major`, which **rejects** extra precision instead of rounding it.
* Any operation that can produce a fraction (`apply_bps`, `apply_ratio`, `div_round`)
  requires a `Rounding` mode. There is no default rounding at the call site that the
  reader cannot see.
* Splits use `Money.allocate` (largest remainder), so the parts always sum to the whole.
* The API carries money as `{"amount": <int>, "currency": "INR"}`.

## Consequences

* Fee policy has to spell out its rounding. Ours: MDR rounds half-up, and GST on the
  fee rounds half-even.
* Currency exponents live in one table (`Currency.exponent`). To add a currency, add
  it there.
