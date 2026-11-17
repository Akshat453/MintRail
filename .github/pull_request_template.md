## What & why

<!-- One paragraph. Link the issue / Derailment if there is one. -->

## Money checklist

- [ ] No JS `number` anywhere near an amount (`bigint` + `Money`, explicit `Rounding`); `mintrail/no-number-money` is clean
- [ ] Ledger changes go through `LedgerService` / `recipes` (no direct writes to `ledger_*`)
- [ ] New ledger-affecting flows are idempotent (stable idempotency key)
- [ ] Schema change has a drizzle-kit migration (`pnpm db:generate`) and `docs/contract/` is updated if intended
- [ ] New error paths use an `MR_` code (added to `ErrorCode` + HTTP map, never renamed)

## Testing

<!-- Unit / integration / property tests added. Paste anything non-obvious. -->
