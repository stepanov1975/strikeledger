# Dashboard Workflow

## Purpose

The dashboard custom post is the launch surface for moderator History, Profile, Reversal, Admin, and the logged-in non-moderator limited self view.

## Read First

- [MVP.md](../../../MVP.md): `Web UI Surfaces`, `Frontend And Routes`, `View Context Tokens`, `History View`, `Profile View`, `Limited User View`, `Reversal`, `Permissions`.
- [../modules/routes.md](../modules/routes.md)
- [../modules/client-dashboard.md](../modules/client-dashboard.md)
- [../hotspots/api-routes.md](../hotspots/api-routes.md)

## Primary Files

- `src/routes/menu.ts`: creates or locates the dashboard post and stores pending view requests.
- `src/routes/api.ts`: bootstrap, history, profile, self-summary, settings, reversal, and recalculation endpoints.
- `src/core/dashboard.ts`: dashboard post record and view-context storage.
- `src/client/dashboard.ts`: plain TypeScript dashboard UI.
- `src/client/dashboardLaunch.ts`: client launch resolution.
- `src/client/compactEntryRows.ts`: compact limited-view row model.
- `src/routes/permissions.ts`: server-side access checks.

## Key Invariants

- The dashboard post is not an authorization boundary.
- Protected API routes must re-check moderator access server-side.
- Query parameters are hints only; trusted view context comes from Redis bootstrap records.
- Non-moderators can only see their own active total and compact current-subreddit history.
- Reversal changes ledger state but does not undo Reddit side effects.

## Targeted Checks

```sh
npm test -- src/routes/api.test.ts src/routes/menu.test.ts src/core/dashboard.test.ts src/client/dashboardLaunch.test.ts src/client/compactEntryRows.test.ts src/core/ledgerRepository.test.ts
```
