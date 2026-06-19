# StrikeLedger Playtest Results - 2026-06-19

Environment:
- Subreddit: `r/strikeledger_dev`
- Browser: logged-in Chrome profile through Codex browser extension
- Moderator account observed: `AlexSt1975`
- Existing test target observed: `u/FeelingAd9932`
- Dashboard post observed: `https://www.reddit.com/r/strikeledger_dev/comments/1u4t1h2/strikeledger_dashboard/`

## Automated Checks

- [x] `npm run type-check` passed.
- [x] `npm test` passed: 21 files, 178 tests.
- [x] `npm run lint` passed.
- [x] `npm run build` passed.

## Setup

- [x] Development subreddit opened with the app installed.
- [x] Moderator account with moderator UI access confirmed.
- [x] App appears in the subreddit sidebar as `strikeledger`.
- [x] Existing dashboard post opens.
- [x] Native Reddit app settings page defaults reviewed.
- [x] Native setting help text reviewed.

## Devvit Platform Validation

- [x] `Warn and remove` completed live to confirm explicit Reddit moderator permission scope.
- [ ] Ordinary-call attempt for `/internal/triggers/on-app-install` repeated.
- [~] Scheduler route isolation probe attempted. Direct webview URL returned `401`, and the controlled browser context could not issue the documented fetch from inside the embedded dashboard iframe.
- [x] Real scheduled cleanup confirmed from logs.

## Logs

- [x] Live operational log stream checked while triggering Admin, Warn, History, Profile, and Reverse. Logs were checked for Admin/settings, History/Profile, post Warn, post Warn and remove, post Warn and mark NSFW, comment Warn, comment Warn and remove, Reverse, precondition failures, and scheduler cleanup.

## Enforcement

- [x] Post `Warn` submitted successfully. Reddit displayed `Strike recorded: Warn for Rule 1. Active total: 2.` Live logs later showed `enforcement.submit.created` for `t3_1u4tmuy` and `api.history.ok` with `entryCount: 2`, `activeTotal: 2`.
- [x] Comment `Warn` submitted and verified.
- [x] Post `Warn and remove` submitted and verified.
- [x] Comment `Warn and remove` submitted and verified.
- [x] Post `Warn and mark NSFW` submitted and verified.
- [ ] Same moderator retry/idempotency checked.
- [ ] Cross-moderator duplicate handling checked.

## Preconditions

- [x] Locked content enforcement rejection checked.
- [x] Already removed content rejection checked.
- [x] Already NSFW content rejection checked.
- [ ] Non-moderator enforcement rejection checked.

## Side Effects

- [x] Public comments checked for no point totals or active totals.
- [x] Public comments checked for target permalink.
- [x] `Warn and remove` public comment wording checked.
- [x] `Warn and mark NSFW` public comment wording checked.
- [~] Private notices checked. Live logs showed `userNotice:"succeeded"` for post Warn, post Warn and remove, post Warn and mark NSFW, comment Warn, and comment Warn and remove, plus `reversalUserNotice:"succeeded"` for Reverse; Reddit inbox/private-message content was not inspected.
- [ ] Private notice permalink checked.
- [ ] Action-specific private notice wording checked.
- [~] Native mod notes checked. Live logs showed `modNote:"succeeded"` for post Warn, post Warn and remove, post Warn and mark NSFW, comment Warn, and comment Warn and remove, plus `reversalModNote:"succeeded"` for Reverse; native mod-note UI content was not inspected.
- [ ] User-notice opt-out checked through native app settings.

## Dashboard

- [x] `StrikeLedger: History` opened from a post menu and loaded the selected author.
- [x] `StrikeLedger: Profile` opened from dashboard context and loaded coherent totals for the selected author.
- [x] Reversal dialog opened, required reason was submitted, and the native mod-note checkbox was visible.
- [x] History opened from a comment menu.
- [x] Profile opened from a comment menu.
- [ ] Narrow/mobile rendering checked.
- [x] Active entry reversed with a required reason.
- [x] Admin recalculate checked for a selected user.
- [ ] Non-moderator dashboard view checked for a user with entries.
- [ ] Non-moderator dashboard empty state checked.
- [ ] Non-moderator protected API blocking checked.

## Settings And Admin

- [x] Admin tab opened and current revision/rules displayed.
- [x] Native point value setting changed and applied to a new action.
- [x] Admin rule label changed and applied to new enforcement forms.
- [x] Admin stale revision conflict checked. After deploying `strikeledger@0.8.5`, a stale revision `5` JSON import after revision `6` saved produced `Settings changed. Current revision: 6.` and did not overwrite the newer settings.
- [x] Invalid rules JSON or values rejected.

## Notes

- Dashboard iframe loaded with tabs `History`, `Profile`, and `Admin`.
- Admin view showed revision `3`, decay `1/30d`, user notices on, and native mod notes on.
- Existing history for `u/FeelingAd9932` showed one active Rule 1 `Warn` entry with succeeded side effects.
- Post `Warn` was submitted on `https://www.reddit.com/r/strikeledger_dev/comments/1u4tmuy/my_next_post/` with moderator note `Live playtest post Warn 2026-06-19`.
- After the post `Warn`, post-menu `History` and `Profile` rows repeatedly closed without navigating in the controlled browser, even though the menu rows were visible. Dashboard direct lookup was started as a fallback but Chrome blocked automation because an extension UI was open.
- Exact scheduler-route isolation still needs live Devvit validation from the embedded dashboard console or a more capable browser console path.
- Continuation performed on 2026-06-19:
  - Non-connected Devvit logs showed repeated `StrikeLedger scheduler.cleanup.ok` with `retentionDays:365`, `maxEntries:2000`, and no deletions.
  - Logs confirmed the earlier post `Warn` entry `0df78507-a8d0-4550-a858-95f56698e694` for `t3_1u4tmuy`, action `warn`, status `succeeded`, `activeTotal:2`, and side effects `publicComment`, `modNote`, and `userNotice` all `succeeded`.
  - Post `Warn and remove` was submitted on `https://www.reddit.com/r/strikeledger_dev/comments/1u4tn1z/remove_this_post/` with moderator note `Live playtest post Warn and remove 2026-06-19`. Reddit displayed `Strike recorded: Warn and remove for Rule 1. Active total: 5.`
  - Logs confirmed post `Warn and remove` entry `98ffbbef-9b59-4b28-8b44-ddb494c153c6` for `t3_1u4tn1z`, action `warn_remove`, status `succeeded`, `activeTotal:5`, `remove:"succeeded"`, `publicComment:"succeeded"`, `modNote:"succeeded"`, and `userNotice:"succeeded"`.
  - The removed post showed Reddit moderation state via `Add removal reason` and a new locked/distinguished app comment from `u/strikeledger`. The public text was `Moderator notice: this content violates Rule 1. This moderator action has been recorded in subreddit warning history. Target: ...`; it included the target permalink and did not include point totals, active totals, or a claim that the post was removed.
  - A fresh comment target was created on `https://www.reddit.com/r/strikeledger_dev/comments/1u4rwrp/my_first_post/`: `Live playtest comment target for StrikeLedger Warn 2026-06-19`, permalink `https://www.reddit.com/r/strikeledger_dev/comments/1u4rwrp/comment/osl667e/`.
  - Comment `Warn` was submitted against `t1_osl667e` with moderator note `Live playtest comment Warn 2026-06-19`. Reddit displayed `Strike recorded: Warn for Rule 1. Active total: 1.`
  - Logs confirmed comment `Warn` entry `1e703298-cc52-499f-9c10-77246487fc0e` for `t1_osl667e`, action `warn`, status `succeeded`, `activeTotal:1`, and side effects `publicComment`, `modNote`, and `userNotice` all `succeeded`.
  - After reload, the comment thread showed a locked/distinguished app reply under `osl667e` with the target permalink. The public text did not include point totals or active totals.
  - The native Devvit app settings page showed installed app settings with defaults and help text for point values, decay, public/private/native templates, private notices, native mod notes, reversal mod notes, distinguished/locked app comments, and sticky-comment toggles. Observed defaults included Warn `1`, Warn and remove `3`, Warn and mark NSFW `1`, decay amount `1`, decay interval `30`, user notices on, native mod notes on, reversal mod notes on, distinguished comments on, and locked comments on.
  - Post `Warn and mark NSFW` was submitted on `https://www.reddit.com/r/strikeledger_dev/comments/1u4tmuy/my_next_post/` with moderator note `Live playtest post Warn and mark NSFW 2026-06-19`. Reddit displayed `Strike recorded: Warn and mark NSFW for Rule 1. Active total: 6.`
  - The Warn/NSFW target showed the `NSFW` label and a locked/distinguished app comment from `u/strikeledger`. The public text was `Moderator notice: this content violates Rule 1. This moderator action has been recorded in subreddit warning history. Target: ...`; it included the target permalink and did not include point totals, active totals, or a claim that the post was marked NSFW.
  - Logs confirmed post `Warn and mark NSFW` entry `455e2456-f5c3-4341-9a2e-607c7c9ec1eb` for `t3_1u4tmuy`, action `warn_nsfw`, status `succeeded`, `activeTotal:6`, `markNsfw:"succeeded"`, `publicComment:"succeeded"`, `modNote:"succeeded"`, and `userNotice:"succeeded"`.
  - Comment `Warn and remove` was submitted against `t1_osl667e` with moderator note `Live playtest comment Warn and remove 2026-06-19`. Reddit displayed `Strike recorded: Warn and remove for Rule 1. Active total: 4.`
  - Logs confirmed comment `Warn and remove` entry `aefb3186-5e81-4531-bf95-c06b3d429878` for `t1_osl667e`, action `warn_remove`, status `succeeded`, `activeTotal:4`, `remove:"succeeded"`, `publicComment:"succeeded"`, `modNote:"succeeded"`, and `userNotice:"succeeded"`. The Reddit thread also exposed `Add removal reason` on the target comment, consistent with removed moderator state.
  - The comment `Warn and remove` app reply was locked/distinguished, included the target permalink, and did not include point totals or active totals.
  - Comment-menu `History` opened the dashboard for `u/AlexSt1975`; the iframe showed active total `4` and the two comment entries, `Warn and remove` and `Warn`.
  - Comment-menu `Profile` opened the dashboard for `u/AlexSt1975`; the iframe showed active total `4`, lifetime points `4`, reversed entries `0`, and the two comment entries.
  - Dashboard Admin was reopened and still showed revision `3`, decay `1/30d`, user notices on, mod notes on, typed rule controls, and the `Recalculate` user lookup control. Attempting to enter the selected user and run Recalculate was blocked by a Chrome extension UI; dismiss the extension UI before continuing browser automation.
  - Admin Recalculate was later submitted for `AlexSt1975`. The dashboard returned `name:alexst1975: active total 4.`, matching the previously observed History/Profile total. Logs confirmed `api.recalculate.ok` with `userKey:"name:alexst1975"` and `activeTotal:4`.
  - The active one-point `Warn` entry `1e703298-cc52-499f-9c10-77246487fc0e` was reversed with reason `Live playtest reversal 2026-06-19`. The dashboard updated to active total `3`, kept the entry visible as `Reversed`, and showed the reason plus `By: u/AlexSt1975`.
  - Logs confirmed `api.reverse.ok` for entry `1e703298-cc52-499f-9c10-77246487fc0e`, target `t1_osl667e`, action `warn`, status `reversed`, `activeTotal:3`, `reversalModNote:"succeeded"`, and `reversalUserNotice:"succeeded"`.
  - Already-NSFW precondition was checked by submitting `Warn and mark NSFW` against `https://www.reddit.com/r/strikeledger_dev/comments/1u4tmuy/my_next_post/`, which already displayed `View NSFW content`. No `Strike recorded` success toast appeared. Logs confirmed `enforcement.submit.precondition_failed` for `t3_1u4tmuy` with reason `Already NSFW posts cannot be warned and marked NSFW.`
  - Already-removed precondition was checked by submitting `Warn and remove` against `https://www.reddit.com/r/strikeledger_dev/comments/1u4tn1z/remove_this_post/`, which displayed `Add removal reason`. No `Strike recorded` success toast appeared. Logs confirmed `enforcement.submit.precondition_failed` for `t3_1u4tn1z` with reason `Already removed content cannot be warned and removed.`
  - Invalid Admin rules JSON was rejected in the dashboard. Submitting `{ "schemaVersion": 1, "revision": 3, "rules": [ }` produced `Unexpected token '}', ... is not valid JSON`, left the saved revision at `3`, and the Rules JSON field was refreshed afterward.
  - Admin Rule 1 label was changed to `Rule 1 Playtest` and saved. The dashboard advanced to revision `4`, and a newly opened `StrikeLedger: Warn` form showed the rule selector value `Rule 1 Playtest (+1)`. The form was canceled without submitting enforcement.
  - A stale revision probe then submitted the earlier revision `3` rules JSON. Expected stale-conflict behavior was not observed: logs showed another `api.settings.save.ok` and the dashboard advanced to revision `5`. The imported JSON restored the label back to `Rule 1`, and the final Admin view showed revision `5` with heading `Rule 1`.
  - Local fix added after the stale revision probe: Rules JSON import now submits the imported config revision, and `/api/settings` rejects mismatched request/config revisions without overwriting current settings.
  - Local verification after the fix passed: `npx vitest run src/routes/api.test.ts` (37 tests), `npm run type-check`, `npm test` (21 files, 178 tests), `npm run lint`, and `npm run build`.
  - Uploaded and installed `strikeledger@0.8.5` to `r/strikeledger_dev`. `npx devvit view --json` showed uploaded version `0.8.5`, and the embedded app-page README reported `App version: 0.8.5`.
  - Live stale revision retest passed on `strikeledger@0.8.5`: Admin started at revision `5`; saving revision `5` Rules JSON with a temporary Rule 1 label advanced settings to revision `6`; submitting the old revision `5` Rules JSON produced `Settings changed. Current revision: 6.`
  - Reloading Admin after the stale conflict showed revision `6` with the temporary Rule 1 label still present, confirming the stale JSON did not overwrite current settings. The temporary label was then restored to `Rule 1`, advancing Admin to revision `7`.
  - Recent non-connected Devvit logs corroborated the stale retest: `api.settings.save.ok` at revision `6`, `api.settings.save.conflict` with `expectedRevision:5` and `currentRevision:6`, then `api.settings.save.ok` at revision `7` for the restore.
  - Native Warn point value was temporarily changed from `1` to `2` on the Reddit for Developers install settings page. After reload, the settings page showed Warn point value `2`, and the dashboard summary showed `Warn: 2, Warn and remove: 3, Warn and mark NSFW: 1`.
  - A new `StrikeLedger: Warn` form on post `t3_1u4tmuy` showed `Rule 1 (+2)` and `Rule 2 (+2)`. Rule 2 was selected and submitted with moderator note `Live playtest native Warn point value 2 retry 2026-06-19`.
  - Recent non-connected Devvit logs confirmed `enforcement.submit.created` for entry `68af88b6-bff6-488b-9472-8d75c481e68b`, target `t3_1u4tmuy`, action `warn`, `ruleId:"rule-2"`, status `succeeded`, and `activeTotal:8`, consistent with the previous active total `6` plus the temporary 2-point Warn value.
  - Native Warn point value was restored to `1`; after reload, the settings page showed Warn point value `1`, and the dashboard summary returned to `Warn: 1, Warn and remove: 3, Warn and mark NSFW: 1`.
  - Locked content rejection was checked against locked app comment `t1_osk95mk`. Submitting `StrikeLedger: Warn` showed `Locked content cannot be warned.` and no success toast. Recent non-connected Devvit logs confirmed `enforcement.submit.precondition_failed` for `targetId:"t1_osk95mk"`, `targetKind:"comment"`, and reason `Locked content cannot be warned.`
