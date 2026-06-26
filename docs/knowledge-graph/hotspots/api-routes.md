# Hotspot: API Routes

## Why Risky

`src/routes/api.ts` is the dashboard server boundary. It reads protected ledger data, serves non-consuming inline Profile previews, writes reversals and settings, recalculates totals, and also serves the limited non-moderator self view.

## Symbols To Understand

- `api`
- bootstrap endpoint handlers
- inline profile preview and history/profile summary endpoint handlers
- self-summary handler
- settings handlers
- reversal and recalculation handlers

## Invariants

- Re-check moderator access before protected reads or writes.
- Limited user responses must be derived from the current logged-in user.
- View context tokens are short-lived and server-owned.
- Inline Profile preview must not consume dashboard bootstrap records or run full active-total recalculation; expanded bootstrap still owns consumption.
- Reversal must preserve the audit trail and avoid claiming Reddit side effects were undone.

## Route Risk Notes

- Consumes pending launch state: `GET /api/bootstrap`.
- Peeks at pending launch state: `GET /api/inline-profile-preview`.
- Non-moderator data route: `GET /api/self-summary`, derived only from `reddit.getCurrentUser()`.
- Moderator-only reads: `GET /api/history`, `GET /api/profile`, `GET /api/settings`, `GET /api/settings/audit`, and `GET /api/settings/reddit-rules`.
- Moderator-only writes: `POST /api/settings`, `POST /api/recalculate-user-total`, `POST /api/cleanup-ledger`, and `POST /api/reverse`.

## Required Regression Coverage

- Every new protected route needs a non-moderator denial test.
- Every route that reads a context token needs a wrong-subreddit or invalid-context test.
- Every route that consumes or peeks at bootstrap state needs a test proving whether the Redis record is preserved or deleted.
- Every new limited-view route needs a test proving it ignores client-submitted usernames, user keys, target IDs, and subreddit identity.

## Targeted Checks

```sh
npm test -- src/routes/api.test.ts src/core/dashboard.test.ts src/core/ledgerRepository.test.ts src/client/dashboardLaunch.test.ts
```
