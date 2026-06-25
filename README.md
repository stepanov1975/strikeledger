# StrikeLedger User Manual

App version: `1.1.0`

StrikeLedger helps moderators record rule violations in a durable warning ledger. It adds moderator menu actions for warnings, removal warnings, NSFW warnings, history, profile, and settings. The app records what happened, calculates active warning totals with decay, and keeps a reversible audit trail for future moderator review.

StrikeLedger moderation tools are for moderators only. Logged-in non-moderators who open the dashboard can see only their own active warning total and compact warning history. Public comments explain the rule violation but do not expose warning points or a user's active total. Private user notices, the limited user dashboard, and native moderator notes can include point totals when those options are enabled or available.

## What StrikeLedger Records

Each warning action creates one ledger entry for the affected user. A ledger entry includes the user's Reddit ID, display username, subreddit, target post or comment, rule, action, original point value, moderator, time, status, Reddit side-effect results, and reversal details if the entry is later reversed.

Active totals are recalculated from the ledger. If a cached total ever needs to be rebuilt, the ledger remains the source of truth.

## Menu Actions

Moderators can use these Reddit menu actions:

| Action                           | Where it appears   | What it does                                                                          |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| StrikeLedger: Warn               | Posts and comments | Records a warning and leaves the configured public explanation.                       |
| StrikeLedger: Warn and remove    | Posts and comments | Records a warning, leaves the configured public explanation, and removes the target.  |
| StrikeLedger: Warn and mark NSFW | Posts only         | Records a warning, leaves the configured public explanation, and marks the post NSFW. |
| StrikeLedger: History            | Posts and comments | Opens the user's ledger history.                                                      |
| StrikeLedger: Profile            | Posts and comments | Opens the user's summary profile.                                                     |
| StrikeLedger: Admin              | Subreddit menu     | Opens StrikeLedger admin tools.                                                       |

## First Setup

Configure stable subreddit settings on the standard Devvit app settings page. Boolean side-effect settings include help text that explains what each toggle does. Then open the subreddit menu and choose `StrikeLedger: Admin`. A moderator with full `all` permissions can create or open the StrikeLedger dashboard surface for the subreddit.

Before using enforcement actions, review native app settings:

1. Confirm point values for each action.
2. Set decay behavior.
3. Choose side effects such as private user notices, native mod notes, comment distinguish, sticky, and lock behavior.
4. Review public, private, and native mod note templates.

Then use `StrikeLedger: Admin` to configure rules, import Reddit rules, import or export Rules JSON, and run repair and maintenance tools.

Settings changes affect future calculations. Decay settings apply retroactively when active totals are recalculated.

## Rules

Rules determine what moderators can select in the enforcement form. Each rule has:

- Rule ID.
- Moderator-facing label.
- Enabled or disabled state.
- Optional point overrides for each action.
- Optional public comment template.
- Optional native mod note template.

Disabled rules stay in settings but are hidden from new enforcement forms.

### Importing Reddit Rules

In Admin, use `Import from Reddit rules` to copy the current subreddit rules into StrikeLedger. Imported rules are flattened into a simple numbered list: `Rule 1`, `Rule 2`, `Rule 3`, and so on.

Import modes:

| Mode                  | Use when                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Add missing rules     | You want to keep existing StrikeLedger rules and add subreddit rules that are not already present.                     |
| Replace active rules  | You want the active StrikeLedger rule list to match the imported subreddit rules.                                      |
| Sync labels and order | You want matching existing rules to use the imported labels and order while preserving their existing custom settings. |

After applying an import preview, click `Save admin changes` to make the changes active.

### Rules JSON Import And Export

Admin includes a `Rules JSON` editor for advanced rule transfer and backup. Click `Refresh export` to copy the current admin-owned rule configuration into the editor. Click `Save imported JSON` to validate and save edited or pasted Rules JSON.

Rules JSON saves use the same revision checks, validation, and audit trail as ordinary Admin rule edits. Use this editor for rules only; stable subreddit settings such as point defaults, decay, side-effect toggles, and default templates are still controlled by the standard Devvit app settings page.

## Points And Decay

Default action points:

| Action             | Default points |
| ------------------ | -------------: |
| Warn               |              1 |
| Warn and remove    |              3 |
| Warn and mark NSFW |              1 |

Rules can override these values per action. A zero-point warning is allowed; it still records a ledger entry and can still run configured notices and mod notes.

Default decay subtracts `1` active point every `30` days from each non-reversed entry, clamped at zero. The native settings page accepts decay intervals from 1 to 36 days. For example, a 3-point warning is worth 3 active points for days 0-29, 2 active points for days 30-59, 1 active point for days 60-89, and 0 active points after 90 days.

## Profile Metrics

The Profile view shows ledger totals for the selected user: active points, original points in the summary window, decayed points, reversed entries, and removals by rule.

## Templates

Templates let moderators control the text StrikeLedger posts or records.

Template types:

| Template                       | Audience                                                    |
| ------------------------------ | ----------------------------------------------------------- |
| Default public comment         | Public thread comment. Do not include private point totals. |
| Default private user notice    | Private message sent to the user when notices are enabled.  |
| Zero-point private user notice | Private message for zero-point actions.                     |
| Default native mod note        | Native Reddit mod note when mod notes are enabled.          |
| Zero-point native mod note     | Native mod note for zero-point actions.                     |
| Rule public comment template   | Optional public template for a specific rule.               |
| Rule native mod note template  | Optional native mod note template for a specific rule.      |

Public templates may use `{ruleLabel}`, `{action}`, `{actionEffect}`, and `{targetPermalink}`. Private notices and native mod notes may use `{subredditName}`, `{ruleLabel}`, `{action}`, `{actionOutcome}`, `{pointsAdded}`, `{activeTotal}`, and `{targetPermalink}`.

The default public comment, private notice, zero-point private notice, and native mod note templates include the target permalink when the placeholder is available. The default public comment uses outcome-neutral action text. The default private notices tell the user whether removal or NSFW marking was confirmed when those actions are used.

## Recording A Warning

To record a warning:

1. Open the moderator menu on a post or comment.
2. Choose the appropriate StrikeLedger action.
3. Select the violated rule.
4. Add an optional moderator note.
5. Add an optional public comment override if the default rule or global template is not appropriate.
6. Submit the form.

StrikeLedger checks the target before creating a ledger entry. It blocks actions when the author cannot be identified by Reddit user ID, the target is locked, the action is not valid for the target type, or the target has already reached a state that makes the selected action invalid.

StrikeLedger also prevents accidental duplicate warnings. A repeat submit by the same moderator for the same target, action, and rule within the retry window returns the existing ledger entry. A duplicate submit by another moderator is blocked while the existing entry is still active or partial. To record a separate issue on the same target, choose a different rule or action. To reissue the same rule and action after a mistake, reverse the existing entry first, then submit a new warning.

After a successful submission, the ledger entry counts toward the user's active total even if a configured side effect, such as a private notice or mod note, fails. History and Profile show side-effect status so moderators can see what happened.

## History

Use `StrikeLedger: History` from a post or comment to open that author's ledger history. The History tab shows:

- Active total.
- Ledger entries in reverse chronological order.
- Rule and action.
- Active points compared with original points.
- Status.
- Target link.
- Moderator.
- Side-effect summary.
- Reversal controls for entries that can still be reversed.

History is loaded from a short-lived server-issued context token. Open History from a post or comment menu item when you need a selected user's ledger. On narrow/mobile screens, History shows the same entries as compact cards instead of a wide table.

Moderators with full `all` permission can also open History from Admin by entering a username or `id:t2_*` user key in User lookup and clicking `History`. Username lookup resolves the live Reddit user first, then reads the ID-keyed ledger. Use direct lookup for repair or review when no current post or comment menu context is available.

## Profile

Use `StrikeLedger: Profile` from a post or comment to open the author's profile summary. The Profile tab shows:

- Active total.
- Original points in the summary window.
- Decayed points.
- Reversed entry count.
- Removals grouped by rule.
- Recent ledger entries.

Profile is loaded from a short-lived server-issued context token. Open Profile from a post or comment menu item when you need a selected user's summary. Active total is recalculated from the active ledger window; historical summary metrics are bounded to the latest entries on very large ledgers. On narrow/mobile screens, recent Profile entries use the compact card layout.

Moderators with full `all` permission can also open Profile from Admin by entering a username or `id:t2_*` user key in User lookup and clicking `Profile`. Username lookup resolves the live Reddit user first, then reads the ID-keyed ledger.

## Limited User Dashboard

If a logged-in non-moderator opens the StrikeLedger dashboard post, the dashboard shows a limited self view instead of an error. The view shows:

- The user's own active warning total for the current subreddit.
- A compact mobile-friendly history list.
- Each history row contains only date, rule name, and active points.

The limited view does not show target links, moderator names, side-effect details, reversal controls, Profile metrics, Admin settings, or any other user's ledger data.

## Reversing A Ledger Entry

A reversal removes a ledger entry's contribution from active totals without deleting the audit trail. Reversal does not undo Reddit side effects such as a removed post, public comment, private notice, or native mod note.

To reverse an entry:

1. Open History for the user.
2. Find the ledger entry.
3. Click `Reverse`.
4. Enter a reversal reason.
5. Optionally enter a reversal note.
6. Submit the reversal.

If reversal mod notes are enabled, StrikeLedger records a native mod note for the reversal.

## Manual Recalculation

Moderators with full settings access can recalculate a user's active total from Admin. Enter a username or `id:t2_*` user key, then click `Recalculate`. Username input resolves the live Reddit user first. Recalculation rebuilds the cached active total from the ID-keyed ledger and current decay settings.

## Admin Maintenance

Moderators with full settings access can run ledger cleanup from Admin by clicking `Run cleanup`. This uses the same retention policy as the hourly cleanup job and reports how many entries were scanned and deleted.

Click `Load audit` in Admin to view recent settings audit records. Audit rows show when Admin settings changed, which moderator saved the change, the changed top-level fields, and compact before/after hashes.

## Permissions

Moderator access is required for moderator dashboard data. The `posts` or `all` permission is required for enforcement actions and reversals. Full `all` permission is required for Admin rule changes, Reddit rule import, Rules JSON import, dashboard creation, direct user lookup, settings audit, ledger cleanup, and manual recalculation. Logged-in non-moderators can open only the limited self dashboard.

If a moderator can open the dashboard but cannot edit Admin settings, the Admin view shows read-only rule information.

## Status Meanings

| Status    | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| Succeeded | The ledger entry and all required/enabled side effects completed.            |
| Partial   | The ledger entry was recorded, but one or more side effects failed.          |
| Pending   | The ledger entry was created but final side-effect status was not completed. |
| Reversed  | A moderator reversed the entry; it no longer contributes active points.      |

## Data Retention

StrikeLedger stores ledger history, active-total caches, dashboard records, and short-lived form/view tokens in Devvit Redis for the app installation.

The app runs an hourly cleanup job. Cleanup deletes old reversed entries and old entries that have no active points; entries that still contribute active points are kept. The default cleanup retention window is 365 days, and Admin users can run the same cleanup from the dashboard.

The app also runs an hourly account deletion check. When Reddit no longer resolves a stored Reddit user ID, StrikeLedger removes that user's ledger records, active-total cache, and related author-identifying stored data.

Reddit delete-event triggers are also part of the compliance path. `onPostDelete` and `onCommentDelete` scrub stored target permalinks because Reddit permalinks can include author-identifying or content-derived URL text. They keep the moderation audit entry but clear the permalink and record when the target was deleted; do not remove these trigger registrations without replacing the scrub path.

Uninstalling or reinstalling the app may remove or orphan stored data. Treat uninstall and reinstall actions as data-retention events.

## Practical Moderation Notes

- Public comments should explain the rule issue without exposing point totals.
- Use private notices or native mod notes when moderators need point and active-total details.
- Keep rule labels clear and stable so history remains easy to read.
- Use reversals for mistakes instead of deleting or editing history.
- Recalculate totals after major decay setting changes if you need a fresh cached value immediately.
