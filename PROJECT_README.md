# Reddit Strike System

StrikeLedger is a Devvit moderation app for tracking subreddit rule violations with a weighted, rule-specific ledger.

The MVP specification is maintained in [MVP.md](./MVP.md). That file is the source of truth for product behavior, data model, permissions, settings, tests, and acceptance criteria.

## MVP Summary

Moderators can access these actions from Reddit menus:

- `StrikeLedger: Warn`
- `StrikeLedger: Warn and remove`
- `StrikeLedger: Warn and mark NSFW` for posts only
- `StrikeLedger: History`
- `StrikeLedger: Profile`
- `StrikeLedger: Admin` from the subreddit menu

Each enforcement action records a ledger entry, applies configured points, leaves a public explanation comment, sends a private user notice with points and active total when enabled, and writes a neutral native mod note when enabled. Public comments never expose point totals or strike totals and use outcome-neutral action text. Default public, private notice, and native mod note templates include the target permalink placeholder where supported. The default private notices state removal and NSFW outcomes for those actions.

The ledger is the source of truth. Cached active totals are rebuildable, decay is calculated from ledger entries, and reversals remove an entry's contribution without deleting the audit trail or undoing Reddit side effects.

Logged-in non-moderators who open the dashboard get a limited self view. It uses a server-derived current user identity, shows only that user's active total and compact current-subreddit history, and does not expose moderator History, Profile, Admin, side-effect, target, or reversal data.

## Core Defaults

| Action | Default points | Targets |
| --- | ---: | --- |
| Warn | 1 | Posts and comments |
| Warn and remove | 3 | Posts and comments |
| Warn and mark NSFW | 1 | Posts only |

Default decay subtracts `1` active point every `30` days, clamped at zero. Decay settings apply retroactively when totals are recalculated.

## Architecture

- Devvit menu actions and forms handle enforcement.
- Redis stores config, ledger entries, indexes, active-total cache, settings audit, form nonces, and view context tokens.
- A small Vite app with plain TypeScript renders moderator history, profile, reversal, settings UI, and the limited user self view.
- Hono JSON endpoints back the web UI, including `/api/self-summary` for the logged-in user's own limited dashboard data.
- `vitest` covers unit, repository, and route tests.

Native Devvit boolean settings include help text so first-time installers can understand side-effect toggles from the app settings page.

Native Devvit setting defaults in `devvit.json` are generated from the TypeScript defaults and placeholder lists in `src/core/config.ts` and `src/core/templates.ts`. After editing those defaults, run `npm run sync-devvit-settings`; `npm run build` and `npm run deploy` check that the generated manifest has not drifted.

## Devvit Triggers

`onPostDelete` and `onCommentDelete` are registered because StrikeLedger stores target permalinks in ledger entries. The app does not intentionally store post or comment body text, but Reddit permalinks can include post-title slugs, so they are content-derived data. When Reddit reports a deleted post or comment, the trigger marks the related ledger entries as deleted and clears `targetPermalink` while preserving the audit record: target ID, user/moderator IDs, timestamps, rule/action, point values, side-effect status, and reversal state remain available for moderation accountability.

Post deletion also scrubs indexed comment ledger entries under the deleted post. This is why new entries carry `targetPostId` and why the repository keeps a `post:{postId}:entries` index in addition to the exact `target:{targetId}:entries` index. Without that parent-post index, a deleted post could leave warned comment permalinks containing the deleted post title.

`devvit.json` still intentionally registers no-op placeholders for `onPostSubmit`, `onPostCreate`, `onPostUpdate`, `onPostFlairUpdate`, `onPostNsfwUpdate`, `onPostSpoilerUpdate`, and `onModAction`. They return success without reading Reddit data or writing Redis. Keep these placeholders unless the Devvit platform no longer supports them; registering them now avoids requiring moderators to reinstall the app when future trigger-backed functionality is added.

## Development

Useful commands:

```sh
npm run sync-devvit-settings
npm run check-devvit-settings
npm run type-check
npm test
npm run lint
npm run build
```

Use the MVP implementation plan in [MVP.md](./MVP.md) before adding code.

## Data Retention Warning

StrikeLedger stores ledger history in Devvit Redis scoped to the app installation. Uninstalling or reinstalling the app may remove or orphan ledger history unless Reddit provides a retention path for that installation.

## Manual Playtest

Use [PLAYTEST.md](./PLAYTEST.md) before uploading or publishing a build.

## Accepted Future Extensions

- Moderator daily review digest.
- Severe violation fast-ban flow.
- NSFW review helper.
- Post-rate ledger.
