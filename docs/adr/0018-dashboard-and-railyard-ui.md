# ADR-0018: Dashboard and Railyard web apps

* Status: accepted
* Date: 2026-11-18
* Deciders: Payments, Platform, Security

## Decision

* Two Next.js 16 (App Router) apps: `dashboard/` (merchants) and `railyard/` (MintRail staff).
  They share `@mintrail/web`: a server-only API client, CSRF helpers, formatting (bigint
  money, Indian grouping, IST dates), SVG charts and UI components.
* **Server-side only:** pages and Server Actions call the Platform API from the Next.js server.
  The browser never sees an API key or a session token.
* **Sessions:**
  * Dashboard users (`dashboard_users`, roles owner/admin/developer/viewer) sign in at
    `/dashboard/v1/auth/login` and get a `dss_…` token (stored as a peppered HMAC, with
    lockout like staff).
  * Railyard uses the M1 staff session (`rys_…`).
  * Tokens live in **httpOnly** cookies (`SameSite=Lax` for the dashboard, `Strict` for
    Railyard; `Secure` unless `MINTRAIL_COOKIE_SECURE=false` for local http).
* **CSRF:** a double-submit token (`mr_csrf` httpOnly SameSite=Strict cookie set by `proxy.ts`,
  echoed as a hidden form field) is verified with a constant-time compare in every Server
  Action. This is on top of Next.js's own Origin/Host check for Server Actions.
* **Dashboard API:** `/dashboard/v1/*` authenticates the session plus a `MintRail-Mode` header
  (live requires verified KYC) and reuses the *same handlers* as `/v1` for refunds, disputes,
  payouts, webhooks and settlements, with role checks instead of key scopes. Dashboard-only
  routes are me, overview analytics, filtered payments, API keys and CSV reports.
* One-time secrets (API keys, webhook secrets) go back to the page through action state and
  never appear in URLs.
* Mutations carry a per-render idempotency key, so a double submit cannot refund or pay twice.
* Security headers: X-Frame-Options DENY, nosniff, Referrer-Policy same-origin,
  Permissions-Policy.

## Consequences

* No MFA yet for either app (as in M1). It is the next security item.
