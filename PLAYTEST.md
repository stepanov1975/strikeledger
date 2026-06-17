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
- Use a moderator account with `all` permission for Admin tools and dashboard creation.
- Use a separate test account or known test author for enforcement.
- Review the standard Devvit app settings page and confirm the native setting defaults are present.
- Confirm boolean native settings have readable help text for side-effect toggles such as private notices, native mod notes, distinguish, sticky, and lock.
- Open `StrikeLedger: Admin` from the subreddit menu first and confirm the dashboard post opens.

## Devvit Platform Validation

- Confirm moderation actions run under the app's explicit Reddit moderator permission scope by completing at least one `Warn and remove` action on a test post.
- Repeat the ordinary-call attempt for `/internal/triggers/on-app-install`. Expected result: unreachable, blocked, or no install-side Redis mutation.

## Logs

- Prefer the `npm run dev` terminal while playtesting. `devvit playtest` already streams logs and owns the local `:5678` connection used for browser-forwarded logs.
- Do not run another `devvit logs --connect` while `npm run dev` or another connected log stream is running. `listen EADDRINUSE: address already in use :::5678` means that connection is already owned by another process.
- To inspect recent server logs without the local browser connection, run:

```sh
npx devvit logs strikeledger_dev strikeledger --since 30m --show-timestamps --log-runtime
```

- To stream browser-forwarded playtest logs separately, stop other playtest/log streams first, then run:

```sh
npx devvit logs strikeledger_dev strikeledger --connect --show-timestamps --log-runtime
```

- Trigger Admin, Warn, History, Profile, and Reverse while the stream is open. Expected operational log prefixes look like `StrikeLedger menu.enforcement.form_opened`, `StrikeLedger enforcement.submit.created`, `StrikeLedger api.history.ok`, and `StrikeLedger api.profile.ok`.

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
- Confirm default public comments include the target permalink.
- Confirm default `Warn and remove` public comments do not claim the post or comment was removed.
- Confirm default `Warn and mark NSFW` public comments do not claim the post was marked NSFW.
- Confirm private notices include point details and active total when enabled.
- Confirm default private notices include the target permalink.
- Confirm default private notices for `Warn and remove` and `Warn and mark NSFW` state whether the action-specific side effect was confirmed.
- Confirm native mod notes are neutral and unlabeled when enabled.
- Temporarily disable user notices in native app settings; confirm new actions skip private notices.

## Dashboard

- Open `StrikeLedger: History` from a post and a comment; confirm the selected author's entries load.
- Open `StrikeLedger: Profile`; confirm active total, lifetime points, reversals, and removal counts are coherent.
- On a narrow/mobile viewport, confirm moderator History and Profile entries render as compact cards with date, rule, action/status, points, target link, moderator, and side-effect summary.
- Reverse an active entry with a required reason; confirm the active total updates and the entry remains visible as reversed.
- Use Admin to recalculate a selected user's active total; confirm the displayed result matches history/profile.
- Open the dashboard post as a logged-in non-moderator with prior test entries; confirm it shows only that user's active total and a narrow history list with date, rule name, and points.
- Open the dashboard post as a logged-in non-moderator with no entries; confirm it shows total points as `0` and an empty history state instead of `Request failed with 403`.
- As a non-moderator, confirm moderator History, Profile, Admin, reversal, cleanup, rule import, and manual recalculation APIs remain blocked.

## Settings And Admin

- Change a point value in native app settings; confirm the new value applies to a new enforcement action.
- Change a rule label in Admin; confirm the revision increments and the new label appears in new enforcement forms.
- Open Admin in two windows, save one, then try saving the stale revision; confirm the stale save conflicts.
- Save invalid rules JSON or invalid rule values; confirm the save is rejected.

## Known Build Warnings

`npm run build` should complete successfully before upload. Treat build failures or new warning classes as issues before upload.
