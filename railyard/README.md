# Railyard — internal ops console

Owned by **@mintrail/railyard**. Next.js 16 front end for the `/internal/v1` API. Staff sessions
(`rys_…`) live in httpOnly, SameSite=Strict cookies; navigation follows the staff role's
permissions. Every mutation is written to the append-only staff audit log by the API.

| Page           | Who           | What                                                                                                                   |
| -------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/`            | everyone      | Queues: KYC to review, disputes needing a response, payouts awaiting approval, open Derailments, latest reconciliation |
| `/kyc`         | ops           | Verify or reject pending merchants                                                                                     |
| `/merchants`   | all           | Search; merchant detail with 30-day stats, money policy (reserve, payout limits), suspend/reactivate, users, keys      |
| `/disputes`    | ops           | All disputes; evidence; accept or submit on the merchant's behalf                                                      |
| `/payouts`     | finance       | Approve or reject payouts above the merchant's threshold (single approver)                                             |
| `/webhooks`    | ops, security | Find failed deliveries and replay them                                                                                 |
| `/settlements` | finance       | Settlements, reconciliation report, run settlements or reconciliation                                                  |
| `/audit`       | security      | Staff audit log                                                                                                        |
| `/derailments` | everyone      | Open incidents, add timeline notes, resolve                                                                            |

Seeded staff (password in `.mintrail/demo-keys.json`): Riya Menon (ops, payments engineer),
Arjun Rao (finance, ledger lead), Meera Iyer (security), Kabir Shah (ops, intern), Dev Malhotra
(ops, contractor), plus the bootstrap admin.

```bash
pnpm --filter @mintrail/railyard dev     # http://localhost:3100
```
