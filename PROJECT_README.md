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

Logged-in non-moderators who open the dashboard post and click `Open StrikeLedger` get a limited self view in expanded mode. It uses a server-derived current user identity, shows only that user's active total and compact current-subreddit history, and does not expose moderator History, Profile preview, Admin, side-effect, target, or reversal data.

## Core Defaults

| Action | Default points | Targets |
| --- | ---: | --- |
| Warn | 1 | Posts and comments |
| Warn and remove | 3 | Posts and comments |
| Warn and mark NSFW | 1 | Posts only |

Default decay subtracts `1` active point every `30` days, clamped at zero. Decay settings apply retroactively when totals are recalculated.

## Architecture

- Devvit menu actions and forms handle enforcement.
- Redis stores config, ledger entries, indexes, tracked user IDs for account deletion checks, active-total cache, settings audit, form nonces, and view context tokens.
- A small Vite app with plain TypeScript renders a non-scrolling inline launcher or compact Profile preview, then moderator History, reversal, Admin, and the limited user self view in expanded mode.
- Hono JSON endpoints back the web UI, including `/api/self-summary` for the logged-in user's own limited dashboard data.
- `vitest` covers unit, repository, and route tests.

Native Devvit boolean settings include help text so first-time installers can understand side-effect toggles from the app settings page.

Native Devvit setting defaults in `devvit.json` are generated from the TypeScript defaults and placeholder lists in `src/core/config.ts` and `src/core/templates.ts`. After editing those defaults, run `npm run sync-devvit-settings`; `npm run build` and `npm run deploy` check that the generated manifest has not drifted.

## Devvit Triggers

Account deletion cleanup is handled by the scheduled `accountDeletionCheck` task. New ledger entries must use `id:t2_*` user keys only and add the `t2_*` user ID to `users:tracked`; do not reintroduce username-derived `name:*` ledger keys. When Reddit no longer resolves a tracked user ID, the task deletes that user's ledger entries, active-total cache, and related author-identifying Redis indexes.

`onPostDelete` and `onCommentDelete` are registered for Reddit compliance scrubbing. They clear stored `targetPermalink` values and set `targetDeletedAtMs` for deleted post/comment targets, including comments indexed under a deleted post. The trigger handles one bounded page and the scheduled `targetDeleteScrub` task drains any saved continuation so large deleted posts do not make trigger handling unbounded. These handlers must not be deleted unless another code path provides the same scrub behavior.

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

StrikeLedger stores ledger history in Devvit Redis scoped to the app installation. Uninstalling or reinstalling the app may remove or orphan ledger history unless Reddit provides a retention path for that installation. Deleted-account cleanup can also remove all ledger records for a tracked Reddit user ID.

## Manual Playtest

Use [PLAYTEST.md](./PLAYTEST.md) before uploading or publishing a build.

## Accepted Future Extensions

- Moderator daily review digest.
- Severe violation fast-ban flow.
- NSFW review helper.
- Post-rate ledger.
