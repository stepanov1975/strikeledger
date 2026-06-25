# Hotspot: API Routes

## Why Risky

`src/routes/api.ts` is the dashboard server boundary. It reads protected ledger data, writes reversals and settings, recalculates totals, and also serves the limited non-moderator self view.

## Symbols To Understand

- `api`
- bootstrap endpoint handlers
- history/profile endpoint handlers
- self-summary handler
- settings handlers
- reversal and recalculation handlers

## Invariants

- Re-check moderator access before protected reads or writes.
- Limited user responses must be derived from the current logged-in user.
- View context tokens are short-lived and server-owned.
- Reversal must preserve the audit trail and avoid claiming Reddit side effects were undone.

## Targeted Checks

```sh
npm test -- src/routes/api.test.ts src/core/dashboard.test.ts src/core/ledgerRepository.test.ts src/client/dashboardLaunch.test.ts
```
