# StrikeLedger User Manual

App version: `0.1.0`

StrikeLedger helps moderators record rule violations in a durable warning ledger. It adds moderator menu actions for warnings, removal warnings, NSFW warnings, history, profile, and settings. The app records what happened, calculates active warning totals with decay, and keeps a reversible audit trail for future moderator review.

StrikeLedger is for moderator use only. Public comments explain the rule violation but do not expose warning points or a user's active total. Private user notices and native moderator notes can include point totals when those options are enabled.

## What StrikeLedger Records

Each warning action creates one ledger entry for the affected user. A ledger entry includes the subreddit, target post or comment, rule, action, original point value, moderator, time, status, Reddit side-effect results, and reversal details if the entry is later reversed.

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

Configure stable subreddit settings on the standard Devvit app settings page. Then open the subreddit menu and choose `StrikeLedger: Admin`. A moderator with full `all` permissions can create or open the StrikeLedger dashboard surface for the subreddit.

Before using enforcement actions, review native app settings:

1. Confirm point values for each action.
2. Set decay behavior.
3. Configure profile metrics.
4. Choose side effects such as private user notices, native mod notes, comment distinguish, sticky, and lock behavior.
5. Review public, private, and native mod note templates.

Then use `StrikeLedger: Admin` to configure rules, import Reddit rules, and run repair tools.

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
| Replace current rules | You want the StrikeLedger rule list to match the imported subreddit rules.                                             |
| Sync labels and order | You want matching existing rules to use the imported labels and order while preserving their existing custom settings. |

After applying an import preview, click `Save admin changes` to make the changes active.

## Points And Decay

Default action points:

| Action             | Default points |
| ------------------ | -------------: |
| Warn               |              1 |
| Warn and remove    |              3 |
| Warn and mark NSFW |              1 |

Rules can override these values per action. A zero-point warning is allowed; it still records a ledger entry and can still run configured notices and mod notes.

Default decay subtracts `1` active point every `30` days from each non-reversed entry, clamped at zero. For example, a 3-point warning is worth 3 active points for days 0-29, 2 active points for days 30-59, 1 active point for days 60-89, and 0 active points after 90 days.

## Profile Metrics

The Profile view shows ledger totals and subreddit-specific post activity for the selected user.

`Avg post score, last 30 days` is calculated from retrievable Reddit posts by that user in the current subreddit. The timeframe is configurable in native app settings with `Post score window days`; the default is 30 days. If no matching retrievable posts are found, the metric shows `n/a`.

Reddit exposes post score, not exact upvote count, so this metric uses average post score as the available approximation.

StrikeLedger caches the post score summary for a short period to avoid repeated Reddit lookups. The cache is refreshed when Profile needs a fresh value and after new post submissions are received by the app. If Reddit cannot return the user's post history, the profile remains usable and shows `n/a` for the metric.

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

Public templates may use `{ruleLabel}`, `{action}`, and `{targetPermalink}`. Private notices and native mod notes may use `{subredditName}`, `{ruleLabel}`, `{action}`, `{pointsAdded}`, `{activeTotal}`, and `{targetPermalink}`.

## Recording A Warning

To record a warning:

1. Open the moderator menu on a post or comment.
2. Choose the appropriate StrikeLedger action.
3. Select the violated rule.
4. Add an optional moderator note.
5. Add an optional public comment override if the default rule or global template is not appropriate.
6. Submit the form.

StrikeLedger checks the target before creating a ledger entry. It blocks actions when the author cannot be identified, the target is locked, the action is not valid for the target type, or the target has already reached a state that makes the selected action invalid.

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

History is loaded from a short-lived server-issued context token. Open History from a post or comment menu item when you need a selected user's ledger.

## Profile

Use `StrikeLedger: Profile` from a post or comment to open the author's profile summary. The Profile tab shows:

- Active total.
- Lifetime original points.
- Decayed points.
- Reversed entry count.
- Average post score for the configured recent window.
- Removals grouped by rule.
- Recent ledger entries.

Profile is loaded from a short-lived server-issued context token. Open Profile from a post or comment menu item when you need a selected user's summary.

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

Moderators with full settings access can recalculate a user's active total from Admin. Enter a username or user key, then click `Recalculate`. This rebuilds the cached active total from the ledger and current decay settings.

## Permissions

Moderator access is required to open dashboard data. The `posts` or `all` permission is required for enforcement actions. Full `all` permission is required for Admin rule changes, Reddit rule import, dashboard creation, and manual recalculation.

If a moderator can open the dashboard but cannot edit Admin settings, the Admin view shows read-only rule information.

## Status Meanings

| Status    | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| Succeeded | The ledger entry and all required/enabled side effects completed.            |
| Partial   | The ledger entry was recorded, but one or more side effects failed.          |
| Pending   | The ledger entry was created but final side-effect status was not completed. |
| Reversed  | A moderator reversed the entry; it no longer contributes active points.      |

## Data Retention

StrikeLedger stores ledger history, active-total caches, profile metric caches, and post submission counters in Devvit Redis for the app installation. Uninstalling or reinstalling the app may remove or orphan stored data. Treat uninstall and reinstall actions as data-retention events.

## Practical Moderation Notes

- Public comments should explain the rule issue without exposing point totals.
- Use private notices or native mod notes when moderators need point and active-total details.
- Keep rule labels clear and stable so history remains easy to read.
- Use reversals for mistakes instead of deleting or editing history.
- Recalculate totals after major decay setting changes if you need a fresh cached value immediately.
