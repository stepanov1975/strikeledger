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

History and profile menu handlers create short-lived Redis view context records and open the configured StrikeLedger web UI with the requested view and context token. The MVP must not assume that a bare relative URL such as `/app?view=history&context={token}` is directly navigable from a Reddit menu response.

The MVP UI launch path is a StrikeLedger dashboard custom post/webview entrypoint that renders the plain TypeScript client and reads the selected view/context from the URL or an app-provided bootstrap endpoint. Settings open the same web UI without a target context token. The app must provide a clear first-run way for moderators with `all` permission to create or locate the dashboard surface.

Implementation decision:

- `devvit.json` must define a `post.dir` and a `dashboard` entrypoint.
- The subreddit-level `StrikeLedger: Settings` menu handler checks for a stored dashboard post ID. If one exists and is readable, it navigates to that post. If none exists, a moderator with `all` permission can create it with `reddit.submitCustomPost({ subredditName, title, entry: 'dashboard' })`; the returned post ID is stored in Redis.
- History and profile menu handlers store a pending view request in Redis keyed by subreddit and moderator username, then navigate to the dashboard post. The dashboard client calls `/api/bootstrap` to resolve the current moderator's pending view request. Query parameters are optional hints only.
- The dashboard post is a launch surface, not an authorization boundary. Do not store ledger data, user identities, or target context in custom-post `postData`. Non-moderators who open the dashboard see no moderation data because every API route re-checks access server-side.

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
- Form-only history, profile, reversal, or settings workflows as the primary MVP UI.
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

When opening an enforcement form, generate a `formNonce` server-side and store all trusted submit context in Redis at `form_nonce:{nonce}`. The nonce record contains `nonce`, `targetId`, `targetKind`, `subredditName`, author identity snapshot, action, moderator username, `createdAtMs`, `expiresAtMs`, `consumedAtMs`, and `entryId` once a submission succeeds.

Devvit Web forms do not provide a true hidden/read-only field in the installed MVP target version. The form may include the nonce as a normal string field with an internal label, or pass it as initial form data, but submitted target IDs, author IDs, usernames, action names, point values, and subreddit identity are never trusted. On submit, the server uses the Redis nonce record as the source of truth and ignores client-side changes to those values. If the submitted nonce is missing, expired, unknown, for another moderator, or for another subreddit, block before ledger creation.

Devvit moderator menu forms must be completed within the platform's 10 minute moderator action window. `expiresAtMs` therefore must be no later than `createdAtMs + 10 minutes`; do not let a Redis nonce remain server-valid beyond the platform form window.

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

Run side effects in this order:

1. Recalculate the active total including the new entry and update the rebuildable cache.
2. Submit the public explanation comment.
3. Apply configured public-comment options: distinguish as mod, sticky, and lock.
4. Run action-specific moderation: remove for `warn_remove`, mark NSFW for `warn_nsfw`.
5. Add the native Reddit mod note if enabled.
6. Send the private user notice if enabled.

Required side effects are the public explanation comment and the action-specific moderation effect for `warn_remove` or `warn_nsfw`. Configured side effects are attempted when enabled. Failure of any required or configured side effect leaves the ledger valid and sets final status to `partial`. Public-comment option failures are tracked in side-effect details without deleting `publicCommentId`; a failed configured option still makes the entry `partial`.

If all required and enabled configured side effects succeed, the moderator toast says the strike was recorded and includes the new active total. If the ledger write succeeds but one or more side effects fail, the toast says the strike was recorded but identifies failed side effects such as public comment, user notice, or mod note. History and profile show compact side-effect status per entry.

Entries with a successful ledger write count toward active totals unless reversed, even if one or more side effects failed. Moderators can reverse partial entries the same way as fully successful entries. The MVP does not include an automatic retry worker.

If the runtime exits after durable ledger creation but before final status is written, a `pending` entry may remain. History and profile show stale pending entries explicitly, and reversal is still allowed. MVP does not auto-retry stale pending side effects.

Public comments must not expose point totals or strike totals. Private user notices and native mod notes may include point totals and active totals.

## Ledger And Scoring

### Entry Model

Create one ledger entry per submitted enforcement action. The ledger stores original issued points; active points are calculated from original points, `createdAtMs`, current decay settings, and reversal state.

Required fields:

- `schemaVersion`: `1`
- `entryId`
- `subredditName`
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
- `status`: `pending`, `succeeded`, `partial`, or `reversed`
- `idempotencyKey`
- `duplicateKey`
- `moderatorRetryKey`
- `idempotencyInputs`
- `formNonce`
- `sideEffects`

Recommended MVP fields:

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
- `publicCommentOptions`: structured details for distinguish, sticky, and lock attempts when configured
- `remove`: `pending`, `skipped`, `succeeded`, or `failed`
- `markNsfw`: `pending`, `skipped`, `succeeded`, or `failed`
- `modNote`: `pending`, `skipped`, `succeeded`, or `failed`
- `userNotice`: `pending`, `skipped`, `succeeded`, or `failed`
- `reversalModNote`: `pending`, `skipped`, `succeeded`, or `failed`
- `reversalUserNotice`: `pending`, `skipped`, `succeeded`, or `failed`

Final entry status is:

- `succeeded` when the ledger entry, all required side effects, and all enabled configured side effects succeed. Disabled configured side effects are `skipped`.
- `partial` when the ledger entry succeeds but one or more attempted side effects fail.
- `reversed` when a moderator reverses the active strike.

Precondition failures and failed ledger writes create no ledger entry. If the app cannot safely create the ledger entry and indexes atomically, it returns a moderator-facing failure message and performs no Reddit side effects. Do not persist a `failed` ledger status in MVP; failures before durable ledger creation should be observable through logs, not through user history.

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
- Use a deterministic duplicate key hash from `targetId`, `action`, and `ruleId`.
- Use a deterministic moderator retry key hash from `targetId`, `action`, `ruleId`, `moderatorUsername`, and `floor(submittedAtMs / 10 minutes)`.
- Do not include `formNonce` in the duplicate key or moderator retry key; nonce replay is handled separately.
- Store raw duplicate/retry inputs in the ledger entry for debugging.
- For backward-readable ledger shape, `idempotencyKey` is the same value as `moderatorRetryKey` in MVP.
- Allow multiple strikes on the same target only when rule or action differs.
- If the same moderator submits the same target, action, and rule again within 10 minutes, treat it as the same idempotent submission and return the existing entry.
- If another moderator submits the same target, action, and rule while an active or partial non-reversed entry already exists, block and show the existing entry regardless of age.
- There is no duplicate override in MVP.
- Allow the same target, action, and rule after reversal because the previous strike no longer contributes.

Form nonce handling:

- Store form nonces at `form_nonce:{nonce}`.
- Expire form nonces after 10 minutes.
- A submitted expired nonce blocks enforcement before ledger creation with a "form expired, reopen the action" message.
- Successful submission sets `consumedAtMs` and `entryId` on the nonce record.
- Reusing a consumed nonce returns the existing entry result only when `entryId` is present and the nonce still belongs to the same moderator and subreddit. Otherwise, block before ledger creation.

Duplicate handling:

- Store active duplicate claims at `duplicate:{targetId}:{action}:{ruleId}` with the current non-reversed entry ID.
- Store moderator retry claims at `retry:{targetId}:{action}:{ruleId}:{moderatorUsername}:{bucket}` with the entry ID and an expiration of at least 10 minutes.
- If the same moderator retries the same target, action, and rule within 10 minutes, return the existing entry from the retry key.
- If any moderator submits the same target, action, and rule while the duplicate key points to an active or partial non-reversed entry, block and show the existing entry.
- On reversal, delete the duplicate key only if it still points to the reversed entry.

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

- Web UI entrypoint: use the Devvit Web custom post/webview entrypoint configured in `devvit.json`. The client may render a route-like `/app` view internally, but menu handlers must navigate through a supported Devvit target rather than assuming a relative server route is user-openable.
- `/api/bootstrap` resolves the dashboard view for the current moderator, using pending view request records or explicit settings mode.
- `/api/history` reads paginated ledger history.
- `/api/profile` reads the selected user's moderation profile.
- `/api/settings` reads and writes runtime configuration.
- `/api/reverse` reverses a ledger entry.
- `/api/recalculate-user-total` recalculates a selected user's cached active total.

Every `/api/*` route re-checks Devvit context and moderator permissions server-side. The server must not trust target IDs, user IDs, or subreddit identity passed from the client without checking current subreddit context. Enforcement still runs through Devvit menu and form handlers, not arbitrary client POSTs, in MVP.

Devvit select fields return arrays in form submissions. All form handlers normalize select values with `Array.isArray(value) ? value[0] : value` before validation.

### View Context Tokens

History and profile APIs resolve view context tokens server-side from Redis records at `view_context:{token}`. A context record contains:

- `targetId`
- `targetKind`
- `subredditName`
- Selected author identity if available

Tokens expire after 15 minutes, can be reused until expiry, and are read-only. They do not authorize mutations. Raw target or user IDs in query params are ignored unless backed by a valid context token.

Dashboard bootstrap records are stored separately from context tokens, keyed by subreddit and moderator username. They contain the selected `view`, optional `contextToken`, and `createdAtMs`; they expire after 15 minutes and are consumed or overwritten by the next menu launch for that moderator.

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
- Native mod notes should be unlabeled. Devvit's `addModNote` user-note labels are warning/action labels such as spam, abuse, ban, and contributor labels; the `NOTE` value is a mod-note type/filter, not a user-note label. If an unlabeled native mod note fails because a label is required, record `sideEffects.modNote = failed`, surface the failure compactly, and leave the ledger valid. Do not substitute a warning, spam, or ban label in MVP.

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

Private notices should be sent with `reddit.modMail.createConversation({ isAuthorHidden: true, subredditName, to: username, subject, body })`. Store the modmail conversation ID when available. Do not use deprecated subreddit private-message APIs. If sending fails, enforcement or reversal still succeeds when the ledger write succeeds, and the relevant side-effect status records the failure.

Private notice subjects must be validated to 100 characters or fewer before calling Modmail. If the target user is a moderator or the app account and Reddit routes the conversation to Mod Discussions, record the returned conversation ID and show the notice side effect as succeeded because the platform accepted it. Do not add moderator/app-account special cases in MVP.

### Native Mod Note Template

When native Reddit mod notes are enabled, the MVP adds neutral unlabeled notes without warning, spam, ban, or other action labels that could trigger unwanted or unexpected Reddit-wide behavior. If the platform rejects an unlabeled note, record the native mod note side effect as failed and continue because Redis is the source of truth.

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
- Active duplicate and moderator retry claims.
- User post-rate counters in accepted extension phase.
- Daily digest snapshots in accepted extension phase.
- Dashboard post ID and per-moderator pending dashboard bootstrap records.

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
dashboard_post_id
dashboard_bootstrap:{subredditName}:{moderatorUsername}
duplicate:{targetId}:{action}:{ruleId}
retry:{targetId}:{action}:{ruleId}:{moderatorUsername}:{bucket}
```

`ledger_entry:{entryId}` stores the full JSON ledger entry. `user:{userKey}:ledger` is a sorted set where the score is `createdAtMs` and the member is `entryId`. `target:{targetId}:entries` is a sorted set for target lookups. `config` stores runtime configuration JSON. `user:{userKey}:active_total` is a rebuildable cache.

Ledger creation must be atomic across the durable entry, nonce, duplicate claim, retry claim, and indexes. Use Redis `watch`/transaction semantics around:

- `form_nonce:{nonce}`
- `duplicate:{targetId}:{action}:{ruleId}`
- `retry:{targetId}:{action}:{ruleId}:{moderatorUsername}:{bucket}`
- `ledger_entry:{entryId}`
- `user:{userKey}:ledger`
- `target:{targetId}:entries`

The transaction validates the nonce, duplicate key, and retry key, then writes the pending ledger entry, indexes, consumed nonce, duplicate claim, and retry claim together. Reddit side effects run only after this transaction succeeds.

The active-total cache is rebuildable and must not be the reason durable ledger creation fails after the entry and indexes are otherwise safe. Recalculate and overwrite `user:{userKey}:active_total` immediately after the ledger transaction succeeds and before private notices or mod notes are rendered. If cache update fails after the total was calculated, record the error in logs and continue with side effects using the calculated total.

Native Reddit mod notes are a secondary moderation trail, not the source of truth, because the app needs structured data for history, reversal, scoring, and settings audit.

Redis data is app-installation scoped. Because bulk ledger export is not in MVP, launch documentation must warn moderators that uninstalling or reinstalling the app may remove or orphan ledger history unless Reddit provides a documented retention path.

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

## Reviewed References

### Reddit Documentation

Reviewed during this MVP pass:

- [Devvit menu actions](https://developers.reddit.com/docs/capabilities/client/menu-actions): menu items support `post`, `comment`, and `subreddit` locations, `forUserType: moderator`, UI responses such as `showForm` and `navigateTo`, and a 10 minute moderator form completion window.
- [Creating a custom post](https://developers.reddit.com/docs/capabilities/creating_custom_post): custom post webviews require `post.dir` and named entrypoints in `devvit.json`, then `reddit.submitCustomPost` creates a post for an entrypoint.
- [Devvit Redis](https://developers.reddit.com/docs/capabilities/server/redis): Redis supports strings, hashes, sorted sets, expirations, and `watch`/transaction semantics, but not key listing, Lua scripts, or pipelining. This supports the explicit key layout and sorted-set indexes.
- [Reddit API overview](https://developers.reddit.com/docs/capabilities/server/reddit-api): Devvit handles Reddit API authentication when `reddit` permission is enabled, and Reddit Thing IDs use `t1_`, `t2_`, `t3_`, and `t5_` prefixes.
- [RedditAPIClient addModNote](https://developers.reddit.com/docs/api/redditapi/RedditAPIClient/classes/RedditAPIClient#addmodnote): native mod-note labels are optional typed user-note labels, not a free-form neutral `NOTE` label.
- [ModMailService createConversation](https://developers.reddit.com/docs/api/redditapi/models/classes/ModMailService#createconversation): Modmail notices support `isAuthorHidden`, `subredditName`, `subject`, `body`, and `to`; subject length is capped at 100 characters.

### GitHub Reference Projects

Use these as reference, not as authority:

- [manavrenjith/redlex-mod](https://github.com/manavrenjith/redlex-mod): closest product reference. It implements a Devvit strike ledger with post/comment menu launch, Hono routes, Redis storage, and select-value normalization. Reuse the native menu/form ergonomics and select normalization pattern. Do not reuse its trusted username form field, single JSON-array ledger storage, or deprecated private-message pattern.
- [shiruken/user-scorer](https://github.com/shiruken/user-scorer): useful moderation scoring reference. It documents setup limits, delayed processing, settings, modmail reports, and the limitation that historical data only starts after install. Reuse the explicit limitation wording style and clear settings constraints.
- [fsvreddit/bot-bouncer](https://github.com/fsvreddit/bot-bouncer): useful policy/workflow reference. It documents staged enforcement modes, exemptions, false-positive appeals, and visible limitations. Reuse the pattern of explaining safety defaults and appeal/reversal expectations; keep exemptions out of MVP because `Do not special-case moderator authors or approved submitters` is already an explicit MVP decision.

### Review Findings Incorporated

- Align form nonce expiry with Devvit's 10 minute moderator form window.
- Make the dashboard custom post mechanics explicit and add `/api/bootstrap`.
- Treat the public dashboard post as untrusted/public and keep all authorization server-side.
- Make `subredditName` required on ledger entries.
- Define side-effect order, required/configured side effects, public-comment option tracking, and stale `pending` behavior.
- Keep atomic Redis writes focused on durable ledger data and indexes; rebuild active-total cache immediately after the transaction.
- Add Modmail subject validation and document moderator/app-account notice routing behavior.
- Add installation-scoped Redis data-loss warning because bulk ledger export is outside MVP.

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

## Product Decisions

The MVP UI launch path is the StrikeLedger dashboard custom post/webview entrypoint. Form-only history, profile, reversal, and settings workflows are not part of the primary MVP UI.

The reviewed references and incorporated findings above are part of the MVP contract for implementation.
