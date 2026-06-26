# Dashboard Workflow

## Purpose

The dashboard custom post is the launch surface for moderator History, compact inline Profile preview, Reversal, Admin, and the logged-in non-moderator limited self view. Expanded mode has History and Admin tabs only; Profile launches open an inline preview and then expanded History for the same target.

## Read First

- [MVP.md](../../../MVP.md): `Web UI Surfaces`, `Frontend And Routes`, `View Context Tokens`, `History View`, `Inline Profile Preview`, `Limited User View`, `Reversal`, `Permissions`.
- [../modules/routes.md](../modules/routes.md)
- [../modules/client-dashboard.md](../modules/client-dashboard.md)
- [../hotspots/api-routes.md](../hotspots/api-routes.md)

## Primary Files

- `src/routes/menu.ts`: creates or locates the dashboard post and stores pending view requests.
- `src/routes/api.ts`: bootstrap, inline profile preview, history, profile summary, self-summary, settings, reversal, and recalculation endpoints.
- `src/core/dashboard.ts`: dashboard post record and view-context storage.
- `src/client/dashboard.ts`: plain TypeScript dashboard UI.
- `src/client/dashboardLaunch.ts`: client launch resolution.
- `src/client/compactEntryRows.ts`: compact limited-view row model.
- `src/routes/permissions.ts`: server-side access checks.

## Key Invariants

- The dashboard post is not an authorization boundary.
- Protected API routes must re-check moderator access server-side.
- Query parameters are hints only; trusted view context comes from Redis bootstrap records.
- Inline mode must not consume `/api/bootstrap`; preview reads pending launch state without deleting it.
- Expanded-mode bootstrap must be single-flight in the client. Duplicate expanded callbacks while the first `/api/bootstrap` request is in flight must not issue a second consuming request.
- Async inline and expanded renders must verify the current webview mode before writing DOM. A stale inline preview response must not repaint over the expanded dashboard, and a stale expanded response must not repaint after returning inline.
- Non-moderators can only see their own active total and compact current-subreddit history.
- Reversal changes ledger state but does not undo Reddit side effects.

## Launch State Boundaries

- `src/routes/menu.ts` writes pending launch state with `DashboardRepository.saveDashboardBootstrap`.
- `/api/inline-profile-preview` peeks at pending Profile or History launches and must not delete the bootstrap record.
- `/api/bootstrap` is the only endpoint that consumes pending launch state; the expanded dashboard should call it when entering expanded mode, not on duplicate expanded-mode callbacks in the same client session.
- `src/client/dashboardLaunch.ts` owns URL-hint handling and the Profile-to-History expanded-mode mapping.

## Review Regression Directions

- Devvit lifecycle: duplicate mode callbacks, missing initial listener events, expanded reloads, and trusted-click requirements for `requestExpandedMode`.
- Async UI freshness: delayed inline preview fetches, delayed expanded bootstrap fetches, and mode changes before a fetch resolves.
- Bootstrap state: accidental `/api/bootstrap` calls from inline mode, consuming a pending menu launch twice, and stale bootstrap reuse after a new menu launch.
- Authorization/data exposure: selected-user context leaking to non-moderators, query params replacing Redis context, and raw user lookup without `all` permission.
- Inline layout safety: long rule labels, dense metrics, buttons/status text, and any table/list/form content that could reintroduce inline scroll.
- Platform compatibility: `devvit.json` entrypoint names, `submitCustomPost({ entry: 'dashboard' })`, menu `navigateTo` targets, and current Devvit view-mode APIs/types.

## Required Regression Coverage

- History launch: inline shows only `Open History`, expanded mode consumes bootstrap and opens History for the same context.
- Profile launch: inline shows cached, bounded compact preview without recent entries when preview data is available; expanded mode opens History for the same context.
- Non-moderator dashboard: bootstrap returns limited view and protected moderator routes still return `403`.
- Inline preview auth: non-moderators receive no context token, selected-user context, summary, or recent entries.
- Reused webview lifecycle: duplicate expanded callbacks reuse one in-flight bootstrap request and keep the pending context.
- Stale async rendering: inline preview responses cannot repaint after expanded mode renders, and expanded responses cannot repaint after returning inline.
- Inline overflow: long rule labels and dense preview text stay bounded in the regular-height inline post.

## Stale Wording Checks

Before finishing dashboard launch-surface changes, grep docs and code for old approval-sensitive phrases: `Profile View`, `Profile tab`, `expanded Profile`, `History and Profile`, `inline scroll`, and claims that inline mode calls or consumes `/api/bootstrap`.

## Targeted Checks

```sh
npm test -- src/routes/api.test.ts src/routes/menu.test.ts src/core/dashboard.test.ts src/client/dashboard.test.ts src/client/dashboardLaunch.test.ts src/client/compactEntryRows.test.ts src/core/ledgerRepository.test.ts
```
