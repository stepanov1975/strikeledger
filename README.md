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
- `StrikeLedger: Settings` from the subreddit menu

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

## Development

Useful commands:

```sh
npm run type-check
npm run lint
```

Use the MVP implementation plan in [MVP.md](./MVP.md) before adding code.

## Accepted Future Extensions

- Moderator daily review digest.
- Severe violation fast-ban flow.
- NSFW review helper.
- Post-rate ledger.
