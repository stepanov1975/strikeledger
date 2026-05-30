# StrikeLedger Manual Playtest Checklist

Run automated checks first:

```sh
npm run type-check
npm test
npm run lint
npm run build
```

## Setup

- Install or playtest the app on a development subreddit.
- Use a moderator account with `all` permission for settings and dashboard creation.
- Use a separate test account or known test author for enforcement.
- Open `StrikeLedger: Settings` from the subreddit menu first and confirm the dashboard post opens.

## Enforcement

- On a test post, run `StrikeLedger: Warn`; confirm exactly one ledger entry appears in history.
- On a test comment, run `StrikeLedger: Warn`; confirm exactly one ledger entry appears in history.
- On a test post, run `StrikeLedger: Warn and remove`; confirm the post is removed and the ledger entry remains valid.
- On a test comment, run `StrikeLedger: Warn and remove`; confirm the comment is removed and the ledger entry remains valid.
- On a test post, run `StrikeLedger: Warn and mark NSFW`; confirm the post is marked NSFW and the ledger entry remains valid.
- Retry one submitted form from the same moderator action window; confirm it is idempotent and does not create a second entry.
- Attempt the same target/action/rule from another moderator; confirm the duplicate is blocked or deduplicated.

## Preconditions

- Try enforcement on locked content; confirm no ledger entry is created.
- Try `Warn and remove` on already removed content; confirm no ledger entry is created.
- Try `Warn and mark NSFW` on an already NSFW post; confirm no ledger entry is created.
- Try enforcement as a non-moderator; confirm it is blocked.

## Side Effects

- Confirm public comments do not show point totals or active totals.
- Confirm private notices include point details and active total when enabled.
- Confirm native mod notes are neutral and unlabeled when enabled.
- Temporarily disable user notices in settings; confirm new actions skip private notices.

## Dashboard

- Open `StrikeLedger: History` from a post and a comment; confirm the selected author's entries load.
- Open `StrikeLedger: Profile`; confirm active total, lifetime points, reversals, and removal counts are coherent.
- Reverse an active entry with a required reason; confirm the active total updates and the entry remains visible as reversed.
- Use settings to recalculate a selected user's active total; confirm the displayed result matches history/profile.

## Settings

- Change a point value in settings JSON; confirm the revision increments and the new value applies to a new enforcement action.
- Open settings in two windows, save one, then try saving the stale revision; confirm the stale save conflicts.
- Save invalid config JSON or invalid config values; confirm the save is rejected.

## Known Build Warnings

`npm run build` currently completes with Devvit/Vite warnings about `sourcemapFileNames` and deprecated `inlineDynamicImports`. Treat new build failures or new warning classes as issues before upload.
