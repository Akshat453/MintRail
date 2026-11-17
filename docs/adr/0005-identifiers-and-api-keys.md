# ADR-0005: Prefixed time-sortable IDs and peppered API-key hashes

* Status: accepted
* Date: 2022-08-10
* Deciders: Platform Eng, Security

## Context

Support engineers paste IDs into Slack all day, so an ID should say what kind of
object it is. Integer IDs leak volume and are easy to enumerate.

## Decision

### Identifiers

`<prefix>_<26 lowercase Crockford base32>`, where the body is a ULID: a 48-bit
millisecond timestamp followed by 80 random bits.

| Prefix | Object | Prefix | Object |
|---|---|---|---|
| `mer_` | Station | `stl_` | Settlement |
| `key_` | API key | `pout_` | Payout |
| `ord_` | Order | `whk_` | Webhook endpoint |
| `pay_` | Payment | `evt_` | Event |
| `rfd_` | Refund | `lac_`, `ltx_` | Ledger account / transaction (internal) |
| `stf_`, `ses_` | Staff user / session (internal) | `blk_` | Conductor blocklist entry (internal) |
| `dsp_` | Dispute | `req_` | Request ID |

IDs sort by creation time, so cursor pagination is `WHERE id < :cursor ORDER BY id DESC`.

### API keys

* Format: `mr_test_<40 base62>` / `mr_live_<40 base62>` (≈238 bits).
* We store `HMAC-SHA256(pepper, key)` hex, never the key. The pepper lives in the
  secret manager (`MINTRAIL_API_KEY_PEPPER`), not in the database.
* A key is shown exactly once, at creation. After that only its `hint` (`mr_test_…k3Zq`)
  is displayed.
* Lookup is one indexed equality match on the hash, which removes the timing oracle
  that comparing against a stored prefix would create.
* Live keys require verified KYC (`stations.kyc_status = 'verified'`, set in Railyard). See also ADR-0006 for request signing and scopes.
* At most 5 active keys per mode per Station.

## Consequences

* Rotating the pepper invalidates every key. Doing that needs dual-pepper verification,
  which is not built yet.
