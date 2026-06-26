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
- Open `StrikeLedger: Admin` from the subreddit menu first and confirm the dashboard post opens with no inline scrolling, then click `Open StrikeLedger` and confirm the full dashboard opens in expanded mode.

## Devvit Platform Validation

- Confirm moderation actions run under the app's explicit Reddit moderator permission scope by completing at least one `Warn and remove` action on a test post.
- Repeat the ordinary-call attempt for `/internal/triggers/on-app-install`. Expected result: unreachable, blocked, or no install-side Redis mutation.
- From the dashboard webview console, probe scheduler route isolation with the wrong task name:

```js
fetch('/internal/scheduler/ledger-cleanup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'probe' }),
}).then((response) => response.status);
```

Expected result: unreachable, blocked, `403`, or `404`. A `400` response means the webview reached the app's scheduler route and the route rejected only the task name; treat that as a pre-production finding and harden the route before launch. Do not probe this route with `{ name: 'ledgerCleanup' }` on real data.
- Confirm the real scheduled cleanup still runs by watching logs for `StrikeLedger scheduler.cleanup.ok` after install/playtest. The scheduled cleanup task is expected to use `/internal/scheduler/ledger-cleanup`; the webview probe above must not be the source of that log.

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

- Trigger Admin, Warn, History, Profile, and Reverse while the stream is open. Expected operational log prefixes look like `StrikeLedger menu.enforcement.form_opened`, `StrikeLedger enforcement.submit.created`, `StrikeLedger api.history.ok`, and `StrikeLedger api.inline_profile_preview.ok`.

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

- Open `StrikeLedger: History` from a post and a comment; confirm the inline dashboard shows only an `Open History` launcher, then click it and confirm the selected author's entries load in expanded History.
- Open `StrikeLedger: Profile`; confirm the inline dashboard shows a compact non-scrolling Profile preview with cached active total, bounded summary-window points, decayed points, reversals, and removal counts when cached preview data is available. Click `Open StrikeLedger` and confirm expanded mode opens History for the same author.
- Open `StrikeLedger: Profile` for a user whose cached preview data is unavailable; confirm the inline dashboard shows the generic non-scrolling `Open StrikeLedger` launcher, then click it and confirm expanded History opens for the same author.
- On a narrow/mobile viewport, confirm moderator History entries render as compact cards with date, rule, action/status, points, target link, moderator, and side-effect summary.
- Reverse an active entry with a required reason; confirm the active total updates and the entry remains visible as reversed.
- Use Admin to recalculate a selected user's active total; confirm the displayed result matches History and the inline Profile preview.
- Open the dashboard post as a logged-in non-moderator with prior test entries; click `Open StrikeLedger` and confirm it shows only that user's active total and a narrow history list with date, rule name, and points.
- Open the dashboard post as a logged-in non-moderator with no entries; click `Open StrikeLedger` and confirm it shows total points as `0` and an empty history state instead of `Request failed with 403`.
- As a non-moderator, confirm moderator History, Profile, Admin, reversal, cleanup, rule import, and manual recalculation APIs remain blocked.

## Settings And Admin

- Change a point value in native app settings; confirm the new value applies to a new enforcement action.
- Change a rule label in Admin; confirm the revision increments and the new label appears in new enforcement forms.
- Open Admin in two windows, save one, then try saving the stale revision; confirm the stale save conflicts.
- Save invalid rules JSON or invalid rule values; confirm the save is rejected.

## Known Build Warnings

`npm run build` should complete successfully before upload. Treat build failures or new warning classes as issues before upload.
