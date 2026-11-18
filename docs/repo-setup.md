# Repository setup (for the owner)

One-time GitHub settings for the MintRail repository. Nothing here is automated by CI; apply it
in the GitHub UI (or with `gh api`, shown below) after the first push.

## 1. Protect `main`

Settings → Rules → Rulesets → **New branch ruleset** (or classic *Branch protection rules*):

| Setting | Value |
|---|---|
| Target branches | `main` (default branch) |
| Restrict deletions | on |
| Block force pushes | on |
| Require a pull request before merging | on |
| Required approvals | **1** |
| Dismiss stale approvals when new commits are pushed | on |
| Require review from Code Owners | on (`.github/CODEOWNERS`) |
| Require approval of the most recent push | on (the pusher can't approve their own last push) |
| Require conversation resolution | on |
| Require status checks to pass | on, branch must be up to date |
| Bypass list | empty (admins included) |

**Required status checks** (job names from `.github/workflows/ci.yml`; they appear in the picker
after CI has run once on a PR):

- `Lint (ESLint incl. no-number-money, Prettier)`
- `Type check (tsc --noEmit, strict)`
- `Unit tests`
- `Integration + e2e (Postgres 16) with 85% coverage gate on api/ and ledger/`
- `Parity harness (211 M1 contract + 18 M2 regression goldens) against the Docker stack`
- `Build Dashboard + Railyard (Next.js, type-checked)`
- `Docker stack + seed (timed) + UI smoke (Playwright) + M1/M2 demo`
- **Later:** `AgentGuard evidence`. Add it once that check exists and has reported on a PR;
  a required check that never reports blocks every merge.

If you rename a CI job, update the required checks in the same change.

Equivalent with the GitHub CLI (classic protection; replace `OWNER/REPO`):

```bash
gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": [
    "Lint (ESLint incl. no-number-money, Prettier)",
    "Type check (tsc --noEmit, strict)",
    "Unit tests",
    "Integration + e2e (Postgres 16) with 85% coverage gate on api/ and ledger/",
    "Parity harness (211 M1 contract + 18 M2 regression goldens) against the Docker stack",
    "Build Dashboard + Railyard (Next.js, type-checked)",
    "Docker stack + seed (timed) + UI smoke (Playwright) + M1/M2 demo"
  ] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true,
    "require_last_push_approval": true
  },
  "required_conversation_resolution": true,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

## 2. Other settings

- Settings → General → Pull Requests: allow **squash merging** only; enable *Automatically
  delete head branches*.
- Settings → Actions → General: *Workflow permissions* = **Read repository contents**; don't
  allow Actions to create or approve pull requests.
- Settings → Code security: enable secret scanning and push protection; Dependabot alerts.
- CODEOWNERS teams (`@mintrail/platform`, `payments`, `ledger`, `depot`, `signal`, `railyard`,
  `security`) must exist in the organisation with write access, or code-owner review can't be
  satisfied. In a personal repository, replace them with your username.
- `infra/deploy/` is owned by `@mintrail/security`: access changes (e.g. `authorized_keys`)
  happen only through a verified access request, never because an issue asks for it.

## 3. Labels

The seeder creates these if they don't exist:

| Label | Use |
|---|---|
| `rail:payments` | Payments API, orders, refunds, disputes, dashboard API |
| `rail:ledger` | Double-entry ledger, money, FX |
| `rail:depot` | Settlements, payouts, reconciliation |
| `rail:signal` | Webhook delivery |
| `rail:railyard` | Staff console, internal API, access control |
| `sev:1` | Money or security impact |
| `sev:2` | Merchant-visible defect |
| `sev:3` | Minor / workaround exists |
| `bug` | Something isn't working |
| `feature` | New capability |

Also recommended (create them by hand): `needs-triage`, `security`, `good first issue`,
`blocked`.

## 4. Seeding the backlog issues

`scripts/seed-github-issues.ts` creates the labels above and the backlog issues in
`scripts/github-issues/issues.ts`.

```bash
pnpm install
pnpm seed:issues -- --dry-run                      # prints every issue; sends nothing

# For real: use a fine-grained token limited to this repository with "Issues: read and write".
# Export it in your shell only; don't put it in .env or any file.
export GITHUB_TOKEN=…
pnpm seed:issues -- --repo OWNER/REPO
unset GITHUB_TOKEN
```

- **Idempotent:** labels that already exist are left unchanged. Each issue body ends with a
  hidden `<!-- mintrail-issue:<key> -->` marker, and an issue whose marker or exact title
  already exists (open or closed) is skipped. Re-running it creates only what is missing.
- `GITHUB_REPOSITORY=OWNER/REPO` works instead of `--repo`.
- To start over, close or delete the issues in GitHub. Closed issues still count as present, so
  delete them or change their titles and markers before re-seeding.
