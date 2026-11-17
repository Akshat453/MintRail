# Conductor — risk checks

Owned by **@mintrail/payments** and **@mintrail/security**. It runs synchronously inside
`POST /v1/payments`, before anything is sent to the bank. The decision is stored on the
payment as `risk.decision`, `risk.score` and `risk.reasons`.

| Rule                                                                                                   | Outcome |
| ------------------------------------------------------------------------------------------------------ | ------- |
| Amount over the method cap (UPI ₹1,00,000 · card ₹5,00,000 · netbanking ₹10,00,000 · USD card $10,000) | block   |
| Amount over the Station's `max_payment_amount`                                                         | block   |
| Card BIN or VPA on the blocklist                                                                       | block   |
| ≥ 10 attempts with the same instrument in 10 min                                                       | block   |
| ≥ 5 attempts with the same instrument in 10 min                                                        | review  |
| ≥ 3 failed payments with the same instrument in 1 h                                                    | review  |
| High value (> ₹2,00,000 or > $2,500)                                                                   | review  |

`block` → the payment fails with `risk_blocked` and never reaches Junction.
`review` → the payment authorizes, but capture waits for a Railyard reviewer
(`/internal/v1/payments/review_queue`, `…/risk_review`).

Conductor owns `conductor_blocklist`, which security staff manage through
`/internal/v1/risk/blocklist`. It never reads Platform's tables: velocity counts come
from the `VelocityCounter` protocol that Platform implements.
