# ADR-0010: Railyard staff authentication, roles and append-only audit log

* Status: accepted (supersedes the Phase-1 shared `X-Railyard-Token`)
* Date: 2026-11-17
* Deciders: Railyard, Security

## Decision

* Staff accounts (`staff_users`) are separate from merchants: their own table, tokens
  and routes. Passwords use **scrypt** (N=2^14, r=8, p=1, per-user salt) and must be at
  least 12 characters.
* `POST /internal/v1/auth/login` issues an opaque `rys_…` session token. Only its HMAC
  is stored. Sessions last 8 h, can be revoked by logging out, and are revoked
  automatically when the account is disabled. After 5 failed logins the account locks
  for 15 min (`MR_STAFF_ACCOUNT_LOCKED`). A wrong password and an unknown email produce
  the same error and take the same time.
* Roles map to permissions:

  | Role | Permissions |
  |---|---|
  | ops | stations read/write, KYC review, payments read, risk review |
  | finance | stations read/write, payments read, ledger read |
  | security | stations read, suspend, API keys, payments read, risk rules, audit read |
  | admin | everything, including staff management |

* Every mutating staff action, including failed logins, writes to `staff_audit_log` **in
  the same transaction** as the action. The entry records the actor, action, target,
  details (before and after values for settings), request id and IP. A trigger rejects
  `UPDATE` and `DELETE` on the table.
* The first admin comes from `MINTRAIL_BOOTSTRAP_ADMIN_*`, created by the migrate step.

## Consequences

* MFA and SSO are not implemented. They are needed before real staff use this.
