# MVP Specification

This file is the authoritative MVP specification for StrikeLedger, a Devvit moderation app for recording subreddit rule violations in a reversible, decaying ledger.

## Goal

Moderators can apply a rule-specific warning action to a post or comment. The app records a durable ledger entry, updates the user's active warning total with configurable step decay, performs configured Reddit side effects, and exposes History, inline Profile preview, reversal, and Admin workflows in an in-app web UI. Logged-in non-moderators who open the dashboard post and launch expanded mode can see only their own active total and compact warning history.

## Scope

### Menu Actions

Add moderator-only Devvit menu actions:

- `StrikeLedger: Warn`
- `StrikeLedger: Warn and remove`
- `StrikeLedger: Warn and mark NSFW` on posts only
- `StrikeLedger: History`
- `StrikeLedger: Profile`
- `StrikeLedger: Admin` at subreddit level

The product name shown to moderators is `StrikeLedger`. The internal package and app name may remain `strikeledger`.

### Web UI Surfaces

The MVP includes these in-app web UI views:

- History for the selected author or target.
- Compact inline Profile preview for the selected author.
- Reversal launched from an individual history entry.
- Admin tools for rules, Reddit rule import, rules JSON import/export, and manual user-total recalculation.
- Limited user view for logged-in non-moderators, showing only the viewer's own active total and compact warning history.

History and profile menu handlers create short-lived Redis view context records and navigate to the dashboard post. History launches use a compact inline `Open History` launcher before the expanded dashboard loads the requested history. Profile launches use a compact non-scrolling inline preview for the selected author, and the expanded action opens History for that same context. The MVP must not assume that a bare relative URL such as `/app?view=history&context={token}` is directly navigable from a Reddit menu response.

The MVP UI launch path is a StrikeLedger dashboard custom post/webview entrypoint. In inline mode, the custom post must render only compact, non-scrolling content: either a Profile preview for a pending Profile launch or a button-driven launcher. That user action opens the same `dashboard` entrypoint in expanded mode, where the plain TypeScript client loads History or Admin from the app-provided bootstrap endpoint. Admin opens the same expanded web UI without a target context token. The app must provide a clear first-run way for moderators with `all` permission to create or locate the dashboard surface.

Implementation decision:

- `devvit.json` must define a `post.dir` and a `dashboard` entrypoint.
- The subreddit-level `StrikeLedger: Admin` menu handler checks for a stored dashboard post ID. If one exists and is readable, it navigates to that post. If none exists, a moderator with `all` permission can create it with `reddit.submitCustomPost({ subredditName, title, entry: 'dashboard' })`; the returned post ID is stored in Redis.
- History and profile menu handlers store a pending view request in Redis keyed by subreddit and moderator username, then navigate to the dashboard post. Inline mode must not call `/api/bootstrap`, because doing so would consume the pending menu launch before the moderator opens the expanded dashboard. Inline Profile preview uses a non-consuming, bounded preview route. The expanded dashboard client calls `/api/bootstrap` when entering expanded mode to resolve the current moderator's pending view request, and duplicate expanded-mode callbacks in the same client session must not consume bootstrap state a second time. Query parameters are optional hints only.
- The dashboard post is a launch surface, not an authorization boundary. Do not store ledger data, user identities, or target context in custom-post `postData`. Logged-in non-moderators who open the dashboard post and launch expanded mode get a limited view. Moderator-only data remains hidden because protected API routes re-check access server-side.

### Non-Goals

- Auto-ban thresholds.
- Automatic side-effect undo after reversal.
- Public lookup of arbitrary users.
- Bulk ledger export.
- External services or databases.
- AI moderation or automatic detection.
- Full daily digest automation.
- Automatic severe-violation detection.
- Automatic retry worker for failed side effects.
- Public correction comments on reversal.
- Form-only history, Profile preview, reversal, or Admin workflows as the primary MVP UI.
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

The rule dropdown shows enabled rules only, sorted by configured order.

A blank public override uses the selected rule public template, then the global default public template. A submitted override is validated with the same public-template placeholder allowlist as configured public templates. It must reject private placeholders such as `{pointsAdded}` and `{activeTotal}`. The ledger stores whether an override was used.

When opening an enforcement form, generate a `formNonce` server-side and store all trusted submit context in Redis at `form_nonce:{nonce}`. The nonce record contains `nonce`, `targetId`, `targetKind`, `subredditName`, author identity snapshot, action, moderator username, `createdAtMs`, `expiresAtMs`, `consumedAtMs`, and `entryId` once a submission succeeds.

Devvit Web forms do not provide a true hidden/read-only field in the installed MVP target version. The form may include the nonce as a normal string field with an internal label, or pass it as initial form data, but submitted target IDs, author IDs, usernames, action names, point values, and subreddit identity are never trusted. On submit, the server uses the Redis nonce record as the source of truth and ignores client-side changes to those values. If the submitted nonce is missing, expired, unknown, for another moderator, or for another subreddit, block before ledger creation.

Devvit moderator menu forms must be completed within the platform's 10 minute moderator action window. `expiresAtMs` therefore must be no later than `createdAtMs + 10 minutes`; do not let a Redis nonce remain server-valid beyond the platform form window.

At form and menu time, snapshot the target author's Reddit user ID from the target object into the form nonce or view context. On submit, re-fetch the target for current state checks and require the refetched target to still expose the same author ID before ledger creation.

### Actions

| Action             | Enum          | Default points | Targets            | Side effects                                                                                                         |
| ------------------ | ------------- | -------------: | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Warn               | `warn`        |              1 | Posts and comments | Public explanation comment, ledger entry, native mod note if enabled, private user notice if enabled                 |
| Warn and remove    | `warn_remove` |              3 | Posts and comments | Public explanation comment, remove target, ledger entry, native mod note if enabled, private user notice if enabled  |
| Warn and mark NSFW | `warn_nsfw`   |              1 | Posts only         | Mark post NSFW, public explanation comment, ledger entry, native mod note if enabled, private user notice if enabled |

Moderator-facing action labels are:

- `Warn`
- `Warn and remove`
- `Warn and mark NSFW`

### Preconditions

All enforcement preconditions are checked before ledger creation. If a precondition fails, the app shows a clear moderator-facing failure message and creates no ledger entry.

- Enforcement requires an identifiable Reddit author ID.
- Use `authorId` as the durable ledger identity.
- Do not create username-derived durable user keys.
- Do not perform extra Reddit API lookups to recover deleted, suspended, or missing authors in MVP.
- Block if a usable `authorId` is unavailable at form open or no longer matches at submit time.
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

If all required and enabled configured side effects succeed, the moderator toast says the strike was recorded and includes the new active total. If the ledger write succeeds but one or more side effects fail, the toast says the strike was recorded but identifies failed side effects such as public comment, user notice, or mod note. History shows compact side-effect status per entry; inline Profile preview remains summary-only.

Entries with a successful ledger write count toward active totals unless reversed, even if one or more side effects failed. Moderators can reverse partial entries the same way as fully successful entries. The MVP does not include an automatic retry worker.

If the runtime exits after durable ledger creation but before final status is written, a `pending` entry may remain. History shows stale pending entries explicitly, and reversal is still allowed from expanded History. MVP does not auto-retry stale pending side effects.

Public comments must not expose point totals or strike totals. Private user notices and native mod notes may include point totals and active totals.

## Ledger And Scoring

### Entry Model

Create one ledger entry per submitted enforcement action. The ledger stores original issued points; active points are calculated from original points, `createdAtMs`, current decay settings, and reversal state.

Required fields:

- `schemaVersion`: `1`
- `entryId`
- `subredditName`
- `userId`
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

### Identity Keys

`userKey` is always `id:{userId}`. The app must not create `name:*` user ledger keys or store username-derived keys as durable identity.

Moderator-entered usernames in Admin lookup are convenience inputs only. The server resolves them with Reddit at request time and reads or recalculates the resolved `id:{userId}` ledger key. If Reddit cannot resolve the username to a user ID, the lookup fails without creating or reading a username-derived key.

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
- Recalculate totals from non-reversed ledger entries whenever enforcement, reversal, History, or exact expanded workflows need them. Inline Profile preview may read the rebuildable active-total cache and fall back to the generic launcher when that cached value is unavailable.
- Store active total as a rebuildable cache and overwrite it after recalculation.

Default step decay examples:

| Original points |        Age | Active points |
| --------------: | ---------: | ------------: |
|               1 |  0-29 days |             1 |
|               1 |   30+ days |             0 |
|               3 |  0-29 days |             3 |
|               3 | 30-59 days |             2 |
|               3 | 60-89 days |             1 |
|               3 |   90+ days |             0 |

### Idempotency And Duplicates

- Use `crypto.randomUUID()` for `entryId`.
- Use a deterministic duplicate key hash from `targetId`, `action`, and `ruleId`.
- Use a deterministic moderator retry key hash from `targetId`, `action`, `ruleId`, `moderatorUsername`, and `floor(submittedAtMs / 10 minutes)`.
- Do not include `formNonce` in the duplicate key or moderator retry key; nonce replay is handled separately.
- Store raw duplicate/retry inputs in the ledger entry for debugging.
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

Proposed routes and launch behavior:

- Web UI entrypoint: use the Devvit Web custom post/webview entrypoint configured in `devvit.json`. The client may render a route-like `/app` view internally, but menu handlers must navigate through a supported Devvit target rather than assuming a relative server route is user-openable.
- Inline launch screen: render only compact, bounded content. Profile launches may render a non-scrolling summary preview with no recent-entry list, tables, long forms, or reversal controls. The preview must use cached active total data plus a small bounded ledger sample, and must fall back to the generic launcher when that cheap preview data is unavailable. History, Admin, limited history, tables, long forms, and scrollable regions must not render inline. Inline mode must not call `/api/bootstrap`.
- Expanded dashboard: after the user clicks `Open StrikeLedger` or `Open History`, request expanded mode for the `dashboard` entrypoint and load History or Admin there. Expanded mode has History and Admin tabs only; pending Profile launches resolve to History for the same target context.
- `/api/bootstrap` resolves the expanded dashboard view for the current user. Moderators get pending view request records or explicit settings mode. Logged-in non-moderators get `view = limited`.
- `/api/inline-profile-preview` reads pending Profile and History launch state without consuming it. It returns compact cached/bounded Profile summary data only for moderator Profile launches, and does not recalculate active totals or scan the full profile window inline.
- `/api/self-summary` reads the logged-in viewer's own active total and compact warning history for the current subreddit.
- `/api/history` reads paginated ledger history.
- `/api/settings` reads effective runtime configuration and writes audited admin rule configuration.
- `/api/reverse` reverses a ledger entry.
- `/api/recalculate-user-total` recalculates a selected user's cached active total.

Every protected moderation `/api/*` route re-checks Devvit context and moderator permissions server-side. `/api/self-summary` is the only non-moderator dashboard data route; it derives the user from `reddit.getCurrentUser()` and never accepts a client-submitted username, user key, target ID, or subreddit identity. Enforcement still runs through Devvit menu and form handlers, not arbitrary client POSTs, in MVP.

Devvit select fields return arrays in form submissions. All form handlers normalize select values with `Array.isArray(value) ? value[0] : value` before validation.

### View Context Tokens

History and inline Profile preview APIs resolve view context tokens server-side from Redis records at `view_context:{token}`. A context record contains:

- `targetId`
- `targetKind`
- `subredditName`
- Selected author identity if available

Tokens expire after 15 minutes, can be reused until expiry, and are read-only. They do not authorize mutations. Raw target or user IDs in query params are ignored unless backed by a valid context token, except for explicit Admin/direct lookup routes that re-check `all` permission server-side before resolving a username or `id:t2_*` user key.

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

History shows the latest `25` entries by default and supports load-more pagination from the Redis sorted-set index. On narrow/mobile layouts, History renders the same moderator entry data as compact cards with date, rule, action/status, points, target link, moderator, side-effect summary, and available reverse action.

### Inline Profile Preview

The Profile menu action is moderator-only and opens a compact inline preview for the selected author. It shows:

- Current active strike total.
- Original points in the summary window.
- Decayed points.
- Reversed entries.
- Recent removals by rule.

Profile preview active total is read from the rebuildable active-total cache to keep inline loading fast. Historical preview metrics such as original points, decayed points, reversed entries, and removals by rule are bounded to the latest `25` ledger entries; the UI labels those metrics as latest-entry metrics when more entries exist. If cached preview data is unavailable, inline mode shows the generic launcher instead of doing full recalculation. The inline preview must not show recent violations, tables, reversal controls, or any internally scrollable region. Its `Open StrikeLedger` action opens expanded History for the same target context, where active total is recalculated from the active ledger window.

Post-rate counts and severe violation summaries can be added when those accepted extensions are implemented.

### Limited User View

The limited user view is for logged-in non-moderators who open the dashboard post and launch the expanded dashboard. It shows:

- The viewer's Reddit username.
- Current active warning total for the current subreddit.
- Up to the latest `25` compact warning history rows.
- Each compact row contains date, rule label, and active points only.

The limited view is read-only and mobile-oriented. It does not show target links, moderator usernames, side-effect statuses, reversal controls, Profile metrics, Admin tools, or any other user's ledger data.

`/api/self-summary` derives identity from `reddit.getCurrentUser()`, reads only the viewer's `id:{userId}` ledger key, filters results to the current subreddit, recalculates active total from the ledger, and returns only `subredditName`, `username`, `activeTotal`, and compact history rows.

## Configuration And Settings

### Source Of Truth

Runtime configuration is split by ownership. Native Devvit subreddit install settings are the source of truth for stable scalar settings: action point defaults, decay, default templates, and side-effect toggles. Redis remains the source of truth for admin-owned rule configuration, the numeric config `revision`, and settings audit records. Runtime reads combine Redis rule configuration with native Devvit settings.

The TypeScript defaults and placeholder lists are the source for the generated `devvit.json` native settings block. Edit `src/core/config.ts` or `src/core/templates.ts`, then run `npm run sync-devvit-settings`; `npm run build` and deploy checks must fail if `devvit.json` drifts from those TypeScript sources.

Config contains a numeric `schemaVersion` and Redis-owned `revision`. The default `schemaVersion` is `1`, and the starting `revision` is `1`. The Admin UI sends the revision it loaded. Save fails with a conflict if the current Redis revision differs, and the moderator must reload and reapply changes. Each successful Admin save increments revision by `1`.

### Native Settings And Admin UI

The standard Devvit subreddit app settings page supports editing:

- Default point values.
- Strike decay amount and interval.
- Public comment template.
- Private user notice template.
- Native mod notes on/off.
- Reversal native mod notes on/off.
- Native mod note templates.
- User notices on/off.
- App comment distinguish/sticky/lock options.

Boolean native settings must include moderator-facing labels and help text so first-time installers can understand each side-effect toggle from Reddit's app settings page.

The in-app Admin UI supports editing:

- Rules.
- Recalculate user totals for a selected username or `id:t2_*` user key.
- Export current rules as JSON.
- Import rules JSON.

Settings reads require moderator access. Admin rule writes, rule import, rules JSON import, and user-total recalculation require `all`. Native-owned fields must not be editable in the Admin UI.

The Admin page includes a manual repair action to recalculate cached active totals for a selected username or `id:t2_*` user key. It rebuilds from that user's ledger and overwrites the active-total cache. Bulk background recalculation is not in MVP.

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
- Admin UI makes the first-run rule task obvious by showing the editable rule table immediately.
- Enforcement is allowed with the generic rule, so the app is usable before moderators finish customization.

### Validation

- Rule IDs: lowercase letters, numbers, and hyphens only.
- Labels: required, max 120 characters.
- Templates: required global public and private templates; optional rule templates; max 2000 characters.
- Point values: integers from 0 to 100.
- Decay amount: integer from 1 to 100.
- Native Devvit decay interval: integer from 1 to 36 days.
- The combined decay settings must let a 100-point entry fully decay within 3650 days.
- At least one enabled rule is required.
- Public templates and public comment overrides reject private-only placeholders such as `{pointsAdded}` and `{activeTotal}`.
- Imported rules JSON must validate fully, use a supported `schemaVersion`, follow the same revision conflict behavior as manual rule edits, and preserve audit history.

### Settings Audit

Every Admin save writes an audit record to Redis at `settings_audit:{timestamp}:{moderatorUsername}`. The audit record includes moderator username, timestamp, changed top-level fields, and before/after admin config hashes.

Hashes are SHA-256 of canonical JSON, where canonical JSON means object keys sorted recursively. Snapshot records store full canonical before/after JSON only for the latest 20 saves. No rollback UI is required in MVP.

### Public Comment Template

Public comments must not expose point totals or strike totals.

Allowed public placeholders:

- `{ruleLabel}`
- `{action}`
- `{actionEffect}`
- `{targetPermalink}`

`{actionEffect}` is derived server-side from the trusted action and is outcome-neutral for public comments. It must not claim that removal, NSFW marking, or another Reddit side effect succeeded because the public comment is posted before later Reddit side effects may be attempted.

Default text:

```text
Moderator notice: this content violates {ruleLabel}. {actionEffect} Target: {targetPermalink}
```

### Private User Notice Template

Private notices are sent when user notices are enabled. They include the action outcome, points added, and current active total so the user understands what happened and their standing without exposing it publicly.

Allowed private notice placeholders:

- `{subredditName}`
- `{ruleLabel}`
- `{action}`
- `{actionOutcome}`
- `{pointsAdded}`
- `{activeTotal}`
- `{targetPermalink}`

`{actionOutcome}` is derived server-side after action-specific side effects are attempted. For `warn_remove` and `warn_nsfw`, it says whether the app confirmed the removal or NSFW marking. If the Reddit side effect failed, it says the warning was recorded but the app could not confirm that side effect.

Default text:

```text
Your content in r/{subredditName} violated {ruleLabel}. {actionOutcome} This action added {pointsAdded} warning point(s). Your current active warning total is {activeTotal}. Target: {targetPermalink}. Please review the community rules before participating again.
```

For `0` point entries, use a separate configurable zero-point private notice template.

Default zero-point text:

```text
Your content in r/{subredditName} violated {ruleLabel}. {actionOutcome} This action was recorded without adding warning points. Your current active warning total is {activeTotal}. Target: {targetPermalink}. Please review the community rules before participating again.
```

Private notices should be sent with `reddit.modMail.createConversation({ isAuthorHidden: true, subredditName, to: username, subject, body })`. Store the modmail conversation ID when available. Do not use deprecated subreddit private-message APIs. If sending fails, enforcement or reversal still succeeds when the ledger write succeeds, and the relevant side-effect status records the failure.

Private notice subjects must be validated to 100 characters or fewer before calling Modmail. If the target user is a moderator or the app account and Reddit routes the conversation to Mod Discussions, record the returned conversation ID and show the notice side effect as succeeded because the platform accepted it. Do not add moderator/app-account special cases in MVP.

### Native Mod Note Template

When native Reddit mod notes are enabled, the MVP adds neutral unlabeled notes without warning, spam, ban, or other action labels that could trigger unwanted or unexpected Reddit-wide behavior. If the platform rejects an unlabeled note, record the native mod note side effect as failed and continue because Redis is the source of truth.

Allowed native mod note placeholders:

- `{subredditName}`
- `{ruleLabel}`
- `{action}`
- `{actionOutcome}`
- `{pointsAdded}`
- `{activeTotal}`
- `{targetPermalink}`

`{actionOutcome}` uses the same server-derived outcome text as private user notices.

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

- Redis-owned rule configuration.
- Full ledger entries by ID.
- Ledger indexes by user and target.
- User active-total cache.
- Settings audit records.
- Form nonces.
- View context tokens.
- Active duplicate and moderator retry claims.
- Tracked user IDs for scheduled account deletion checks.
- User post-rate counters in accepted extension phase.
- Daily digest snapshots in accepted extension phase.
- Dashboard post ID and per-moderator pending dashboard bootstrap records.

Suggested key layout:

```text
config
ledger_entry:{entryId}
user:{userKey}:active_total
user:{userKey}:ledger
users:tracked
target:{targetId}:entries
post:{postId}:entries
user:{userKey}:form_nonces
user:{userKey}:view_contexts
user:{userKey}:post_score_summary
user:{userKey}:post_rate
digest:{yyyy-mm-dd}
settings_audit:{timestamp}:{moderatorUsername}
form_nonce:{nonce}
view_context:{token}
dashboard_post_id
dashboard_bootstrap:{subredditName}:{moderatorUsername}
duplicate:{targetId}:{action}:{ruleId}
retry:{targetId}:{action}:{ruleId}:{moderatorUsername}:{bucket}
target_delete_scrub:{targetKind}:{targetId}
target_delete_scrub:pending
```

`ledger_entry:{entryId}` stores the full JSON ledger entry. `user:{userKey}:ledger` is a sorted set where the score is `createdAtMs` and the member is `entryId`. `users:tracked` is a sorted set of `t2_*` user IDs where the score is the last account-deletion check time or first ledger creation time. `target:{targetId}:entries` is a sorted set for target lookups. `post:{postId}:entries` lets post deletion scrub the post entry and indexed comment entries without scanning all ledger entries. `target_delete_scrub:{targetKind}:{targetId}` and `target_delete_scrub:pending` store bounded delete-scrub continuation state. `user:{userKey}:form_nonces` and `user:{userKey}:view_contexts` let account deletion cleanup remove short-lived author snapshots without scanning Redis. `config` stores Redis-owned rule configuration JSON. `user:{userKey}:active_total` and `user:{userKey}:post_score_summary` are rebuildable caches.

Ledger creation must write the durable entry, consumed nonce, duplicate claim, retry claim, and indexes in one Redis transaction. Use Redis `watch` semantics around the keys that decide whether creation can proceed:

- `form_nonce:{nonce}`
- `duplicate:{targetId}:{action}:{ruleId}`
- `retry:{targetId}:{action}:{ruleId}:{moderatorUsername}:{bucket}` for the current and previous retry buckets
- `ledger_entry:{entryId}`

The transaction validates the nonce, duplicate key, and retry key, then writes the pending ledger entry, user/target/post/subreddit indexes, `users:tracked`, consumed nonce, duplicate claim, and retry claim together. Reddit side effects run only after this transaction succeeds.

The active-total cache is rebuildable and must not be the reason durable ledger creation fails after the entry and indexes are otherwise safe. Recalculate and overwrite `user:{userKey}:active_total` immediately after the ledger transaction succeeds and before private notices or mod notes are rendered. If cache update fails after the total was calculated, record the error in logs and continue with side effects using the calculated total.

Native Reddit mod notes are a secondary moderation trail, not the source of truth, because the app needs structured data for history, reversal, scoring, and settings audit.

The app runs a scheduled account deletion check over `users:tracked`. For each due `t2_*` user ID, it calls Reddit by ID. If Reddit no longer resolves the user, the app deletes that user's ledger entries and related Redis indexes, including author-identifying fields such as user ID, username, profile/avatar/flair-like references if any are later added, active-total cache, consumed form nonces, and duplicate claims tied to those entries. Existing users have expired transient form/view context snapshots removed, then are marked checked by updating their `users:tracked` score if any tracked state remains.

The `onPostDelete` and `onCommentDelete` triggers are required Reddit compliance scrub paths. They must clear stored `targetPermalink` values and set `targetDeletedAtMs` for deleted target content while keeping the moderation audit entry. Post deletion must scrub both the post target and comment targets indexed under that post. Delete-trigger work must be bounded; if a deleted target has more indexed entries than the trigger page can scrub, the scheduled `targetDeleteScrub` task continues from saved cursor state. Do not remove these trigger registrations unless an equivalent compliance scrub path replaces them.

Redis data is app-installation scoped. Cleanup deletes old reversed entries and old entries with no active points after the configured retention window; entries that still contribute active points are retained unless the account deletion check determines that the author account was deleted. Because bulk ledger export is not in MVP, launch documentation must warn moderators that uninstalling or reinstalling the app may remove or orphan ledger history unless Reddit provides a documented retention path.

## Permissions

All actions are enforced server-side even though menu items are moderator-only.

- Enforcement actions require `posts` or `all`, including `Warn`.
- History and profile require moderator access with any permission.
- Admin reads require moderator access with any permission.
- Admin rule writes, rules JSON import, and user-total recalculation require `all`.
- Reversal requires `posts` or `all`, regardless of whether native mod notes are enabled.
- Logged-in non-moderators may launch the expanded dashboard limited view and call `/api/self-summary` for their own current-subreddit active total and compact history only.

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
- Show post counts in the bounded Profile preview or History/Admin user lookup.
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
- [View Modes & Entry Points](https://developers.reddit.com/docs/capabilities/server/launch_screen_and_entry_points/view_modes_entry_points): inline webviews must not trap scrolling or interfere with Reddit-native gestures; full dashboard workflows belong in expanded mode after user action.
- [Devvit Redis](https://developers.reddit.com/docs/capabilities/server/redis): Redis supports strings, hashes, sorted sets, expirations, and `watch`/transaction semantics, but not key listing, Lua scripts, or pipelining. This supports the explicit key layout and sorted-set indexes.
- [Reddit API overview](https://developers.reddit.com/docs/capabilities/server/reddit-api): Devvit handles Reddit API authentication when `reddit` permission is enabled, and Reddit Thing IDs use `t1_`, `t2_`, `t3_`, and `t5_` prefixes.
- [RedditAPIClient addModNote](https://developers.reddit.com/docs/api/redditapi/RedditAPIClient/classes/RedditAPIClient#addmodnote): native mod-note labels are optional typed user-note labels, not a free-form neutral `NOTE` label.
- [ModMailService createConversation](https://developers.reddit.com/docs/api/redditapi/models/classes/ModMailService#createconversation): Modmail notices support `isAuthorHidden`, `subredditName`, `subject`, `body`, and `to`; subject length is capped at 100 characters.

### GitHub Reference Projects

Use these as reference, not as authority:

- [Beach-Brews/devvit-community-survey](https://github.com/Beach-Brews/devvit-community-survey): account deletion compliance reference. It tracks user IDs in Redis and uses a scheduled task to call Reddit by user ID, deleting stored user data when the account no longer resolves.
- [manavrenjith/redlex-mod](https://github.com/manavrenjith/redlex-mod): closest product reference. It implements a Devvit strike ledger with post/comment menu launch, Hono routes, Redis storage, and select-value normalization. Reuse the native menu/form ergonomics and select normalization pattern. Do not reuse its trusted username form field, single JSON-array ledger storage, or deprecated private-message pattern.
- [shiruken/user-scorer](https://github.com/shiruken/user-scorer): useful moderation scoring reference. It documents setup limits, delayed processing, settings, modmail reports, and the limitation that historical data only starts after install. Reuse the explicit limitation wording style and clear settings constraints.
- [fsvreddit/bot-bouncer](https://github.com/fsvreddit/bot-bouncer): useful policy/workflow reference. It documents staged enforcement modes, exemptions, false-positive appeals, and visible limitations. Reuse the pattern of explaining safety defaults and appeal/reversal expectations; keep exemptions out of MVP because `Do not special-case moderator authors or approved submitters` is already an explicit MVP decision.
- [FoxxMD/context-mod](https://github.com/FoxxMD/context-mod): useful user-history moderation reference. It checks author activity over timeframes, supports caching to control Reddit API usage, and can perform moderator actions such as remove, report, comment, and lock. Reuse the explicit caching and API-cost discipline for post-rate scoring extensions.

### Post-Rate And Throttling References

Use these as product references for the accepted Post Rate Ledger extension:

- [ratelimit-bot](https://developers.reddit.com/apps/ratelimit-bot): published Devvit app that limits how often users can post or comment in a subreddit within a configured timeframe. Reuse the plain moderator-facing framing for limit, window, and reply-message variables.
- [Flair Rate Limit Tool](https://developers.reddit.com/apps/flair-frequency): published Devvit app that enforces per-user, per-flair post limits and automatically removes posts that exceed rolling-window limits. Reuse the trigger-driven remove-after-submit model and explicit rolling-window wording.
- [MQCC / queuezero](https://developers.reddit.com/apps/queuezero): published Devvit moderation dashboard that uses triggers for post/comment tracking, Redis-backed rate limiting, and cached user context enrichment. Reuse the trigger-based tracking pattern and the note that adding new triggers may require reinstalling the app for the platform to register them.

### Review Findings Incorporated

- Align form nonce expiry with Devvit's 10 minute moderator form window.
- Make the dashboard custom post mechanics explicit and add `/api/bootstrap`.
- Keep the inline dashboard post as a non-scrolling launcher and load full dashboard workflows only in expanded mode.
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
7. Web UI/API for History, inline Profile preview, and reversal.
8. Native settings integration plus Admin UI/API with audit records.
9. Manual recalc tool.
10. Devvit config update and playtest checklist.

## Test Scope

- Unit tests for decay math, template rendering, placeholder validation, config validation, identity keying, account deletion checks, duplicate handling, and idempotency logic.
- Repository tests with a fake Redis adapter for ledger writes, account deletion cleanup, reversal, active-total recalculation, and settings audit.
- Route tests for API authorization failures and happy-path History, inline Profile preview, and Admin reads.
- Manual Devvit playtest checklist for actual Reddit side effects.

Use `vitest` for unit, repository, and route tests.

## Acceptance Criteria

- A moderator can warn a post author for a selected rule from `StrikeLedger: Warn`.
- A moderator can warn a comment author for a selected rule from `StrikeLedger: Warn`.
- A moderator can warn and remove a post from `StrikeLedger: Warn and remove`.
- A moderator can warn and remove a comment from `StrikeLedger: Warn and remove`.
- A moderator can warn and mark a post NSFW from `StrikeLedger: Warn and mark NSFW`.
- Each action creates exactly one ledger entry.
- Each action requires and stores the affected author's `t2_*` user ID.
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
- Moderators can view a compact non-scrolling inline Profile preview for the selected author.
- The inline dashboard post has no internal scrolling; History launches show an `Open History` launcher, Profile launches show a compact preview, and full workflows load only in expanded mode.
- Moderators can edit stable MVP settings in native Devvit app settings.
- Moderators can edit rules in the in-app Admin UI.
- Admin saves write audit records.
- Moderators can recalculate cached active totals for a selected user.
- Logged-in non-moderators can launch the expanded dashboard and view only their own limited dashboard with active total and compact history.
- The scheduled account deletion check removes ledger records and author-identifying Redis indexes for deleted Reddit user IDs.
- No non-moderator can use enforcement, moderator History, Profile, reversal, Admin, rule import, cleanup, or manual recalculation actions.

## Product Decisions

The MVP UI launch path is the StrikeLedger dashboard custom post/webview entrypoint. Inline mode is only a non-scrolling launcher or compact Profile preview; History, reversal, Admin, and limited self-view workflows load in expanded mode. Expanded mode has History and Admin tabs only. Form-only history, Profile preview, reversal, and Admin workflows are not part of the primary MVP UI.

The reviewed references and incorporated findings above are part of the MVP contract for implementation.
