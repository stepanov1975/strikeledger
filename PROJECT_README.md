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

Each enforcement action records a ledger entry, applies configured points, leaves a public explanation comment, sends a private user notice with points and active total when enabled, and writes a neutral native mod note when enabled. Public comments never expose point totals or strike totals.

The ledger is the source of truth. Cached active totals are rebuildable, decay is calculated from ledger entries, and reversals remove an entry's contribution without deleting the audit trail or undoing Reddit side effects.

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
- A small Vite app with plain TypeScript renders history, profile, reversal, and settings UI.
- Hono JSON endpoints back the web UI.
- `vitest` covers unit, repository, and route tests.

## Reserved Devvit Triggers

`devvit.json` intentionally registers no-op placeholders for `onPostSubmit`, `onPostCreate`, `onPostUpdate`, `onPostFlairUpdate`, `onPostNsfwUpdate`, `onPostSpoilerUpdate`, and `onModAction`. They currently return success without reading Reddit data or writing Redis. Keep these placeholders unless the Devvit platform no longer supports them; registering them now avoids requiring moderators to reinstall the app when future trigger-backed functionality is added.

## Development

Useful commands:

```sh
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
