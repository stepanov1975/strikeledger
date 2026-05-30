# MVP Specification

This file is the authoritative MVP specification for StrikeLedger, a Devvit moderation app for recording subreddit rule violations in a reversible, decaying ledger.

## Goal

Moderators can apply a rule-specific warning action to a post or comment. The app records a durable ledger entry, updates the user's active warning total with configurable step decay, performs configured Reddit side effects, and exposes history, profile, reversal, and settings workflows in an in-app web UI.

## Scope

### Menu Actions

Add moderator-only Devvit menu actions:

- `StrikeLedger: Warn`
- `StrikeLedger: Warn and remove`
- `StrikeLedger: Warn and mark NSFW` on posts only
- `StrikeLedger: History`
- `StrikeLedger: Profile`
- `StrikeLedger: Settings` at subreddit level

The product name shown to moderators is `StrikeLedger`. The internal package and app name may remain `strikeledger`.

### Web UI Surfaces

The MVP includes these in-app web UI views:

- History for the selected author or target.
- Profile for the selected author.
- Reversal launched from an individual history entry.
- Settings for rules, templates, points, decay, notices, side-effect options, config import/export, and manual user-total recalculation.

History and profile menu handlers create short-lived Redis view context records and navigate to `/app?view=history&context={token}` or `/app?view=profile&context={token}`. Settings can navigate directly to `/app?view=settings`.

### Non-Goals

- Auto-ban thresholds.
- Automatic side-effect undo after reversal.
- Public user self-check.
- Bulk ledger export.
- External services or databases.
- AI moderation or automatic detection.
- Full daily digest automation.
- Automatic severe-violation detection.
- Automatic retry worker for failed side effects.
- Public correction comments on reversal.
- Rollback UI for settings changes.
- Bulk background active-total recalculation.
- React or another frontend framework.
- Client-initiated enforcement API outside Devvit menu/form submission.

## Enforcement Workflow

### Enforcement Form

Each enforcement action opens a form with:

- Required rule dropdown.
- Optional moderator note.
- Optional public comment override.
- Confirmation text showing the point value.
- Server-generated `formNonce`.

The rule dropdown shows enabled rules only, sorted by configured order. Sub-rules are supported through clear labels, for example `Rule 1 - Harassment` and `Rule 1.1 - Personal attacks`.

A blank public override uses the selected rule public template, then the global default public template. A submitted override is validated with the same public-template placeholder allowlist as configured public templates. It must reject private placeholders such as `{pointsAdded}` and `{activeTotal}`. The ledger stores whether an override was used.

When opening an enforcement form, generate a `formNonce` server-side and include it as a hidden field if supported. If Devvit forms cannot truly hide it, include a disabled or read-only field with an internal-looking label. Submitted nonces are validated against Redis records and client-side changes are ignored.

At form and menu time, snapshot target author identity from the target object into the form nonce or view context. On submit, re-fetch the target for current state checks, but use the original author snapshot if current author data disappeared and the snapshot is still valid.

### Actions

| Action | Enum | Default points | Targets | Side effects |
| --- | --- | ---: | --- | --- |
| Warn | `warn` | 1 | Posts and comments | Public explanation comment, ledger entry, native mod note if enabled, private user notice if enabled |
| Warn and remove | `warn_remove` | 3 | Posts and comments | Public explanation comment, remove target, ledger entry, native mod note if enabled, private user notice if enabled |
| Warn and mark NSFW | `warn_nsfw` | 1 | Posts only | Mark post NSFW, public explanation comment, ledger entry, native mod note if enabled, private user notice if enabled |

Moderator-facing action labels are:

- `Warn`
- `Warn and remove`
- `Warn and mark NSFW`

### Preconditions

All enforcement preconditions are checked before ledger creation. If a precondition fails, the app shows a clear moderator-facing failure message and creates no ledger entry.

- Enforcement requires an identifiable author.
- Use `authorId` as primary identity when Devvit provides it.
- If `authorId` is missing but `authorName` is present and not `[deleted]`, use a normalized username fallback.
- Do not perform extra Reddit API lookups to recover deleted, suspended, or missing authors in MVP.
- Block if both usable `authorId` and usable `authorName` are unavailable.
- No enforcement action can apply to locked content.
- For comments, check both comment locked state and parent post locked state when possible.
- `Warn` can apply to already removed or already NSFW content if the author is identifiable and the target is not locked.
- `Warn and remove` cannot apply to already removed content.
- `Warn and mark NSFW` cannot apply to already NSFW posts.
- `Warn and mark NSFW` cannot apply to comments.
- If the target changes to a blocked state between form open and submit, block before ledger creation.
- If the submit-time target fetch fails entirely, block before ledger creation.
- Do not special-case moderator authors or approved submitters in MVP.

### Side Effects And Partial Failure

The ledger is written before Reddit side effects run. Create the entry with `status = pending`, then update side-effect statuses as each step succeeds, fails, or is skipped.

If all required side effects succeed, the moderator toast says the strike was recorded and includes the new active total. If the ledger write succeeds but one or more side effects fail, the toast says the strike was recorded but identifies failed side effects such as public comment, user notice, or mod note. History and profile show compact side-effect status per entry.

Entries with a successful ledger write count toward active totals unless reversed, even if one or more side effects failed. Moderators can reverse partial entries the same way as fully successful entries. The MVP does not include an automatic retry worker.

Public comments must not expose point totals or strike totals. Private user notices and native mod notes may include point totals and active totals.

## Ledger And Scoring

### Entry Model

Create one ledger entry per submitted enforcement action. The ledger stores original issued points; active points are calculated from original points, `createdAtMs`, current decay settings, and reversal state.

Required fields:

- `schemaVersion`: `1`
- `entryId`
- `userId` when available
- `username`
- `userKey`
- `targetId`
- `targetKind`
- `targetPermalink`
- `action`
- `ruleId`
- `ruleLabel`
- `publicCommentOverrideUsed`
- `originalPoints`
- `moderatorUsername`
- `createdAtMs`
- `status`: `pending`, `succeeded`, `partial`, `failed`, or `reversed`
- `idempotencyKey`
- `idempotencyInputs`
- `formNonce`
- `sideEffects`

Recommended MVP fields:

- `subredditName`
- `publicCommentId`
- `publicCorrectionCommentId`
- `modNoteId`
- `userNoticeId`
- `moderatorNote`
- `targetState`
- `userState`
- `reversedAtMs`
- `reversedBy`
- `reversalReason`
- `reversalNote`
- `migratedFromUsername`

Repository read functions reject unknown future `schemaVersion` values with a clear error. MVP writes only schema version `1`.

Store timestamps as epoch milliseconds in fields ending with `Ms`, for example `createdAtMs` and `reversedAtMs`. Display dates in the moderator's/client locale in the web UI.

### Side-Effect Statuses

`sideEffects` tracks these fields where relevant:

- `publicComment`: `pending`, `skipped`, `succeeded`, or `failed`
- `remove`: `pending`, `skipped`, `succeeded`, or `failed`
- `markNsfw`: `pending`, `skipped`, `succeeded`, or `failed`
- `modNote`: `pending`, `skipped`, `succeeded`, or `failed`
- `userNotice`: `pending`, `skipped`, `succeeded`, or `failed`
- `reversalModNote`: `pending`, `skipped`, `succeeded`, or `failed`
- `reversalUserNotice`: `pending`, `skipped`, `succeeded`, or `failed`

Final entry status is:

- `succeeded` when the ledger entry and all required side effects succeed.
- `partial` when the ledger entry succeeds but one or more side effects fail.
- `failed` when the ledger entry cannot be safely completed.
- `reversed` when a moderator reverses the active strike.

### Identity Keys And Migration

Primary `userKey` is `id:{userId}` when `userId` is available. If `userId` is unavailable, use username fallback key `name:{normalizedUsername}`.

Normalize fallback usernames to lowercase and remove a leading `u/`. On any later action or profile lookup where both username and `userId` are available, merge `name:{normalizedUsername}` ledger entries into `id:{userId}`, preserve original entry fields, set `migratedFromUsername`, and delete or tombstone the fallback key. History and profile reads check both keys before migration has happened.

### Points And Decay

- Points are non-negative integers only.
- Active points are integers.
- `0` point actions are allowed.
- Zero-point actions still create a ledger entry, public comment, private notice, and mod note if enabled.
- User active total is the sum of each non-reversed entry's active points.
- Decay uses integer math: `decayAmount * floor(ageMs / decayIntervalMs)`.
- Per-entry active points are clamped to `0`.
- Default decay subtracts `1` active point every `30` days.
- Decay amount and interval are configurable.
- Decay setting changes apply retroactively when totals are recalculated.
- Recalculate totals from non-reversed ledger entries whenever enforcement, reversal, history, or profile needs them.
- Store active total as a rebuildable cache and overwrite it after recalculation.

Default step decay examples:

| Original points | Age | Active points |
| ---: | ---: | ---: |
| 1 | 0-29 days | 1 |
| 1 | 30+ days | 0 |
| 3 | 0-29 days | 3 |
| 3 | 30-59 days | 2 |
| 3 | 60-89 days | 1 |
| 3 | 90+ days | 0 |

### Idempotency And Duplicates

- Use `crypto.randomUUID()` for `entryId`.
- Use a deterministic idempotency key hash from `targetId`, `action`, `ruleId`, `moderatorUsername`, and a form nonce or submitted timestamp bucket.
- Store raw idempotency inputs in the ledger entry for debugging.
- Allow multiple strikes on the same target only when rule or action differs.
- If the same moderator submits the same target, action, and rule again within 10 minutes, treat it as the same idempotent submission and return the existing entry.
- If another moderator submits the same target, action, and rule while an active or partial non-reversed entry already exists, block and show the existing entry regardless of age.
- There is no duplicate override in MVP.
- Allow the same target, action, and rule after reversal because the previous strike no longer contributes.

Form nonce handling:

- Store form nonces at `form_nonce:{nonce}`.
- Expire form nonces after 30 minutes.
- A submitted expired nonce blocks enforcement before ledger creation with a "form expired, reopen the action" message.
- Successful submission marks the nonce consumed.
- Reusing a consumed nonce returns the existing idempotent result if present.

### Reversal

Moderators can reverse an active ledger entry from the history view. Reversal always reverses the ledger contribution for the entry and does not attempt to undo Reddit side effects.

The reversal confirmation UI includes:

- Required reversal reason.
- Optional internal moderator note.
- Checkbox to add a native Reddit mod note, default on when mod notes are enabled.

Expected result:

- Set `reversedAtMs`.
- Set `reversedBy`.
- Set `reversalReason`.
- Store optional `reversalNote`.
- Recalculate the user's active total from non-reversed entries.
- Add a native Reddit mod note if enabled.
- Send a private reversal notice with the updated active total if user notices are enabled.
- Show a confirmation toast to the moderator.

MVP reversal does not approve removed content, unmark NSFW content, delete warning comments, or add public correction comments. Original side-effect statuses remain visible, and reversal side effects are tracked separately. If the private reversal notice fails, the reversal still succeeds and records `sideEffects.reversalUserNotice = failed`.

Version 2 should allow an optional public correction comment during reversal. This option should default off, use a configurable correction template, and store `publicCorrectionCommentId` when a correction is posted.

## UI And API

### Frontend And Routes

Use a small Vite client app for the in-app web UI, backed by Hono JSON endpoints. The client uses plain TypeScript and lightweight DOM rendering; do not add React or another frontend framework for MVP.

Proposed routes:

- `/app` serves the web UI.
- `/api/history` reads paginated ledger history.
- `/api/profile` reads the selected user's moderation profile.
- `/api/settings` reads and writes runtime configuration.
- `/api/reverse` reverses a ledger entry.
- `/api/recalculate-user-total` recalculates a selected user's cached active total.

Every `/api/*` route re-checks Devvit context and moderator permissions server-side. The server must not trust target IDs, user IDs, or subreddit identity passed from the client without checking current subreddit context. Enforcement still runs through Devvit menu and form handlers, not arbitrary client POSTs, in MVP.

### View Context Tokens

History and profile APIs resolve view context tokens server-side from Redis records at `view_context:{token}`. A context record contains:

- `targetId`
- `targetKind`
- `subredditName`
- Selected author identity if available

Tokens expire after 15 minutes, can be reused until expiry, and are read-only. They do not authorize mutations. Raw target or user IDs in query params are ignored unless backed by a valid context token.

### History View

History is moderator-only and shows:

- Current active total.
- Recent ledger entries.
- Date.
- Rule.
- Action.
- Original points.
- Active points after decay.
- Status: `Active` or `Reversed`.
- Target link.
- Moderator username.
- Side-effect status summary.
- Reverse action for active entries.

History shows the latest `25` entries by default and supports load-more pagination from the Redis sorted-set index.

### Profile View

The profile is moderator-only and shows:

- Current active strike total.
- Original lifetime points.
- Decayed points.
- Reversed entries.
- Recent rule violations.
- Recent removals by rule.

Profile summaries calculate totals from all ledger entries for the user. Visible recent violations and removals show the latest `25` entries by default, with pagination where useful. If a user has a large ledger, totals may be calculated from entry IDs in batches.

Post-rate counts and severe violation summaries can be added when those accepted extensions are implemented.

## Configuration And Settings

### Source Of Truth

Runtime configuration uses Redis as the source of truth. Bundled defaults and Devvit install or subreddit settings bootstrap Redis on install or first run, and act as fallback if Redis config is missing. After bootstrap, MVP configuration is edited through the in-app settings UI.

Config contains a numeric `schemaVersion` and `revision`. The default `schemaVersion` is `1`, and the starting `revision` is `1`. The settings UI sends the revision it loaded. Save fails with a conflict if the current Redis revision differs, and the moderator must reload and reapply changes. Each successful save increments revision by `1`.

### Settings UI

The settings UI supports editing:

- Rules and sub-rules.
- Default point values.
- Strike decay amount and interval.
- Public comment template.
- Private user notice template.
- Native mod notes on/off.
- Reversal native mod notes on/off.
- Native mod note templates.
- User notices on/off.
- App comment distinguish/sticky/lock options.
- Recalculate user totals for a selected username or profile.
- Export current config as JSON.
- Import config JSON.

Settings reads require moderator access. Settings writes, config import, and user-total recalculation require `all`.

The settings page includes a manual repair action to recalculate cached active totals for a selected username or profile. It rebuilds from that user's ledger and overwrites the active-total cache. Bulk background recalculation is not in MVP.

### Required Settings

- Config schema version, default `1`.
- Config revision, starting at `1`.
- Rule list.
- Warn point value, default `1`.
- Warn and remove point value, default `3`.
- Warn and mark NSFW point value, default `1`.
- Strike decay amount, default `1`.
- Strike decay interval, default `30` days.
- Default public comment template.
- Default private user notice template.
- Default zero-point private user notice template.
- Default native mod note template.
- Default zero-point native mod note template.
- Whether private user notices are enabled, default on.

Recommended side-effect settings:

- Distinguish app comments as mod, default on.
- Sticky app comments, configurable per action globally, default off.
- Lock app explanation comments, default on.
- Add native mod notes, default on.
- Add native mod notes for reversals, default on when mod notes are enabled.
- Native mod notes should be unlabeled where Devvit allows it; if a label is required by the API, use only the neutral `NOTE` or equivalent label.

### Rule Schema

Rules are edited as structured rows, not raw JSON. Rule rows support add, edit, disable, and reorder.

```ts
{
  id: string;
  label: string;
  parentId?: string;
  publicTemplate?: string;
  internalNoteTemplate?: string;
  pointOverrides?: {
    warn?: number;
    warn_remove?: number;
    warn_nsfw?: number;
  };
  enabled: boolean;
}
```

Rule IDs cannot be changed after creation. Labels and templates may change. Each ledger entry stores the `ruleLabel` used at enforcement time so history remains readable after rule labels change.

Default first-install rule set:

- Bootstrap with one enabled generic rule: `rule-general` / `Community rule violation`.
- Include the default public and private templates.
- Settings UI makes the first-run task obvious by showing the editable rule table immediately.
- Enforcement is allowed with the generic rule, so the app is usable before moderators finish customization.

### Validation

- Rule IDs: lowercase letters, numbers, and hyphens only.
- Labels: required, max 120 characters.
- Templates: required global public and private templates; optional rule templates; max 2000 characters.
- Point values: integers from 0 to 100.
- Decay amount: integer from 0 to 100.
- Decay interval: integer from 1 to 3650 days.
- At least one enabled rule is required.
- Public templates and public comment overrides reject private-only placeholders such as `{pointsAdded}` and `{activeTotal}`.
- Imported config JSON must validate fully, use a supported `schemaVersion`, follow the same revision conflict behavior as manual edits, and preserve audit history.

### Settings Audit

Every settings save writes an audit record to Redis at `settings_audit:{timestamp}:{moderatorUsername}`. The audit record includes moderator username, timestamp, changed top-level fields, and before/after config hashes.

Hashes are SHA-256 of canonical JSON, where canonical JSON means object keys sorted recursively. Snapshot records store full canonical before/after JSON only for the latest 20 saves. No rollback UI is required in MVP.

### Public Comment Template

Public comments must not expose point totals or strike totals.

Allowed public placeholders:

- `{ruleLabel}`
- `{action}`
- `{targetPermalink}`

Default text:

```text
Moderator notice: this content violates {ruleLabel}. This action has been recorded in your subreddit warning history.
```

### Private User Notice Template

Private notices are sent when user notices are enabled. They include the points added and current active total so the user understands their standing without exposing it publicly.

Allowed private notice placeholders:

- `{subredditName}`
- `{ruleLabel}`
- `{action}`
- `{pointsAdded}`
- `{activeTotal}`
- `{targetPermalink}`

Default text:

```text
Your content in r/{subredditName} violated {ruleLabel}. This action added {pointsAdded} warning point(s). Your current active warning total is {activeTotal}. Please review the community rules before participating again.
```

For `0` point entries, use a separate configurable zero-point private notice template.

Default zero-point text:

```text
Your content in r/{subredditName} violated {ruleLabel}. This action was recorded as a warning without adding warning points. Your current active warning total is {activeTotal}. Please review the community rules before participating again.
```

Private notices should be sent as hidden-identity modmail conversations where Devvit supports it. Store the modmail conversation ID when available. If sending fails, enforcement or reversal still succeeds when the ledger write succeeds, and the relevant side-effect status records the failure.

### Native Mod Note Template

When native Reddit mod notes are enabled, the MVP adds neutral notes without warning, spam, ban, or other action labels that could trigger unwanted or unexpected Reddit-wide behavior. Use unlabeled notes where Devvit allows it. If a label is required by the API, use only the neutral `NOTE` or equivalent label.

Allowed native mod note placeholders:

- `{subredditName}`
- `{ruleLabel}`
- `{action}`
- `{pointsAdded}`
- `{activeTotal}`
- `{targetPermalink}`

Default text:

```text
StrikeLedger: {action} for {ruleLabel}. Points: {pointsAdded}. Active total: {activeTotal}. Target: {targetPermalink}
```

For `0` point entries, use a separate configurable zero-point native mod note template.

Default zero-point text:

```text
StrikeLedger: {action} for {ruleLabel}. No points added. Active total: {activeTotal}. Target: {targetPermalink}
```

## Storage

Use Devvit Redis for:

- Runtime configuration.
- Full ledger entries by ID.
- Ledger indexes by user and target.
- User active-total cache.
- Settings audit records.
- Form nonces.
- View context tokens.
- User post-rate counters in accepted extension phase.
- Daily digest snapshots in accepted extension phase.

Suggested key layout:

```text
config
ledger_entry:{entryId}
user:{userKey}:active_total
user:{userKey}:ledger
target:{targetId}:entries
user:{userKey}:post_rate
digest:{yyyy-mm-dd}
settings_audit:{timestamp}:{moderatorUsername}
form_nonce:{nonce}
view_context:{token}
```

`ledger_entry:{entryId}` stores the full JSON ledger entry. `user:{userKey}:ledger` is a sorted set where the score is `createdAtMs` and the member is `entryId`. `target:{targetId}:entries` is a sorted set for target lookups. `config` stores runtime configuration JSON. `user:{userKey}:active_total` is a rebuildable cache.

Native Reddit mod notes are a secondary moderation trail, not the source of truth, because the app needs structured data for history, reversal, scoring, and settings audit.

## Permissions

All actions are enforced server-side even though menu items are moderator-only.

- Enforcement actions require `posts` or `all`, including `Warn`.
- History and profile require moderator access with any permission.
- Settings reads require moderator access with any permission.
- Settings writes, config import, and user-total recalculation require `all`.
- Reversal requires `posts` or `all`, regardless of whether native mod notes are enabled.

If permissions are insufficient, the app shows a moderator-facing failure message and creates no ledger entry.

## Accepted Extensions

These features are accepted for the product but do not block the first core implementation unless explicitly promoted into MVP later.

### Moderator Daily Review Digest

Generate a daily moderator summary with:

- New strikes issued.
- Reversals.
- Removed posts and comments.
- NSFW markings.
- Severe violation actions.
- Users near configured thresholds.
- Users over the post-rate limit.
- Recent high-risk repeat offenders.

### Severe Violation Fast Ban Flow

Add a high-severity moderator action for violations that should bypass ordinary warning flow.

Expected behavior:

- Remove the post or comment.
- Add a severe violation ledger entry.
- Add a native Reddit mod note.
- Optionally ban the user.
- Default ban type when enabled: temporary `30` days.
- Ban duration is configurable per severe rule.
- Permanent ban is available as an explicit option.
- Optionally lock the content.
- Show the action in user history and daily digest.

### NSFW Review Helper

Extend `Warn and mark NSFW` with configured NSFW reasons.

Suggested reasons:

- Suggestive pose.
- Underwear or lingerie.
- Too much skin.
- Borderline adult content.
- Incorrectly unmarked NSFW.

### Post Rate Ledger

Track user post frequency in rolling windows.

Default behavior:

- Feature has an on/off switch and is disabled by default.
- Configurable post limit per rolling 24 hours.
- Default limit when enabled: `3` posts per rolling `24` hours.
- Track post count per user.
- Show post counts in user moderation profile.
- Show over-limit users in the daily digest.

Possible moderator actions:

- Warn for post-rate violation.
- Remove latest over-limit post.
- Remove all over-limit posts.
- Add configured strike points.

## Implementation Plan

1. Domain types and config defaults/validation.
2. Template rendering and placeholder validation.
3. Redis repository layer with fake test adapter.
4. Active-total decay/recalculation.
5. Menu/forms for enforcement preconditions and idempotent ledger creation.
6. Reddit side effects with per-side-effect status updates.
7. Web UI/API for history/profile/reversal.
8. Settings UI/API with audit records.
9. Manual recalc tool.
10. Devvit config update and playtest checklist.

## Test Scope

- Unit tests for decay math, template rendering, placeholder validation, config validation, identity keying/migration, duplicate handling, and idempotency logic.
- Repository tests with a fake Redis adapter for ledger writes, reversal, active-total recalculation, and settings audit.
- Route tests for API authorization failures and happy-path history/profile/settings reads.
- Manual Devvit playtest checklist for actual Reddit side effects.

Use `vitest` for unit, repository, and route tests.

## Acceptance Criteria

- A moderator can warn a post author for a selected rule from `StrikeLedger: Warn`.
- A moderator can warn a comment author for a selected rule from `StrikeLedger: Warn`.
- A moderator can warn and remove a post from `StrikeLedger: Warn and remove`.
- A moderator can warn and remove a comment from `StrikeLedger: Warn and remove`.
- A moderator can warn and mark a post NSFW from `StrikeLedger: Warn and mark NSFW`.
- Each action creates exactly one ledger entry.
- Each action stores the original point value in the ledger.
- Enforcement actions are idempotent on retry.
- Duplicate same-target/same-action/same-rule submissions are blocked or deduplicated.
- Partial side-effect failures remain visible in the ledger.
- The user's active total reflects configured step decay.
- Reversed entries do not contribute to the user's active total.
- A moderator can reverse an active strike with a required reason.
- A reversed strike remains visible in history.
- Each action attempts to leave a public explanation comment.
- Public explanation comments never include point totals or strike totals.
- Each action attempts to send a private user notice with point and active-total details when enabled.
- Locked content blocks enforcement before ledger creation.
- Already removed content blocks `Warn and remove` before ledger creation.
- Already NSFW posts block `Warn and mark NSFW` before ledger creation.
- Moderators can view recent strike history for the selected author.
- Moderators can view the selected author's moderation profile.
- Moderators can edit MVP settings in the in-app settings UI.
- Settings saves write audit records.
- Moderators can recalculate cached active totals for a selected user.
- No non-moderator can use enforcement, history, profile, reversal, or settings actions.

## Open Product Decisions

Remaining implementation decisions should be resolved before core implementation starts.
