# Dashboard — merchant UI

Owned by **@mintrail/payments**. Next.js 16 (App Router) + TypeScript (strict), styled with
`@mintrail/web`. It calls the Platform API **server-side only** (`/dashboard/v1`). The session
token lives in an httpOnly cookie, and every form is CSRF-protected (ADR-0018).

| Page           | What                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`            | Volume, success rate and average ticket KPIs; daily volume and success-rate charts; method mix; balance and reserve; refunds; open disputes |
| `/payments`    | Search (id / order / email), status, method and IST date filters; cursor pagination. Detail page: fees, timeline, **issue refund**          |
| `/refunds`     | All refunds with fee + GST                                                                                                                  |
| `/settlements` | Daily settlements with UTR and FX rate; detail breakdown; **CSV report**                                                                    |
| `/disputes`    | Respond: upload evidence (PDF/PNG/JPEG), submit, or accept                                                                                  |
| `/payouts`     | Single payout, bulk CSV upload, history                                                                                                     |
| `/webhooks`    | Endpoints (secret shown once), delivery log, **replay**, **rotate secret**, enable/disable                                                  |
| `/api-keys`    | Create (secret shown once) and revoke                                                                                                       |
| `/reports`     | CSV exports: payments, refunds, settlements, payouts                                                                                        |

Roles: `owner`/`admin` (everything), `developer` (keys and webhooks), `viewer` (read and reports).
Test/live mode is a toggle; live requires verified KYC.

```bash
pnpm --filter @mintrail/dashboard dev    # http://localhost:3000, API at MINTRAIL_UI_API_URL (default :8000)
make test-ui                             # Playwright smoke against the running, seeded stack
```

Seeded logins: `owner@<merchant-slug>.example` (e.g. `owner@kesari-threads.example`) with the
demo password in `.mintrail/demo-keys.json`.
