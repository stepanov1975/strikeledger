# MVP Specification

This file defines the first buildable version of Reddit Strike System. It is intentionally limited to the smallest useful moderation workflow.

## MVP Goal

Moderators can apply a rule-specific warning action to a post or comment, and the app records a durable ledger entry that updates the user's active strike score with configurable step decay.

## In Scope

### 1. Menu Actions

Add moderator-only Devvit menu actions:

- `Warn`
- `Warn and remove`
- `Warn and mark NSFW` on posts only
- `Show strike history`
- `Reverse strike` from an individual history entry
- `Show user moderation profile`

### 2. Rule Selection Form

Each enforcement action opens a form with:

- Required rule dropdown
- Optional moderator note
- Optional public comment override
- Confirmation text showing the point value

The rule dropdown should support sub-rules by using clear labels, for example:

- `Rule 1 - Harassment`
- `Rule 1.1 - Personal attacks`
- `Rule 1.2 - Hate speech`

### 3. Enforcement Actions

#### Warn

Expected result:

- Reply to the post or comment with the configured explanation.
- Add the configured points to the user's ledger.
- Add a native mod note if enabled.
- Show a confirmation toast to the moderator.

Default points: `1`

#### Warn and remove

Expected result:

- Reply to the post or comment with the configured explanation.
- Remove the post or comment.
- Add the configured points to the user's ledger.
- Add a native mod note if enabled.
- Show a confirmation toast to the moderator.

Default points: `3`

#### Warn and mark NSFW

Expected result:

- Mark the post as NSFW.
- Reply to the post with the configured explanation.
- Add the configured points to the user's ledger.
- Add a native mod note if enabled.
- Show a confirmation toast to the moderator.

Default points: `1`

This action does not apply to comments.

### 4. Ledger Entries

Create one ledger entry per submitted enforcement action.

Required fields:

- `entryId`
- `userId` when available
- `username`
- `targetId`
- `targetKind`
- `targetPermalink`
- `action`
- `ruleId`
- `ruleLabel`
- `originalPoints`
- `moderatorUsername`
- `createdAt`

Recommended MVP fields:

- `publicCommentId`
- `modNoteId`
- `moderatorNote`
- `reversedAt`
- `reversedBy`
- `reversalReason`
- `reversalNote`

The ledger should store the original issued points. Decayed active points should be calculated from the original points, `createdAt`, and current decay settings.

### 5. User Strike Total

The app should show and store the user's current active total.

MVP behavior:

- Add original points after each action.
- Apply step decay when calculating active totals.
- Default decay: subtract `1` active point every `30` days.
- Make decay amount and decay interval configurable.
- Do not let active points go below `0`.
- Exclude reversed entries from active totals.
- Show total in the moderator success toast.
- Optionally include total in public comment templates.

Default step decay examples:

| Original points | Age | Active points |
| ---: | ---: | ---: |
| 1 | 0-29 days | 1 |
| 1 | 30+ days | 0 |
| 3 | 0-29 days | 3 |
| 3 | 30-59 days | 2 |
| 3 | 60-89 days | 1 |
| 3 | 90+ days | 0 |

### 6. Show Strike History

The history view should be moderator-only and show:

- Current total
- Recent ledger entries
- Date
- Rule
- Action
- Original points
- Active points after decay
- Status: `Active` or `Reversed`
- Target link
- Moderator username
- Reverse action for active entries

For MVP, showing the most recent 10 to 25 entries is enough.

### 7. Reverse Strike

Moderators should be able to reverse an active ledger entry from the strike history view.

The reversal confirmation form should include:

- Required reversal reason
- Optional internal moderator note
- Checkbox to add a native Reddit mod note, default on when mod notes are enabled

Expected result:

- Set `reversedAt`.
- Set `reversedBy`.
- Set `reversalReason`.
- Store optional `reversalNote`.
- Recalculate the user's active total from non-reversed entries.
- Add a native Reddit mod note if enabled.
- Show a confirmation toast to the moderator.

MVP reversal only affects the strike ledger. It should not automatically approve removed content, unmark NSFW content, delete the warning comment, or add a public correction comment.

### 8. User Moderation Profile

The MVP should include a lightweight moderator-only profile for the selected author.

The profile should show:

- Current active strike total
- Original lifetime points
- Decayed points
- Reversed entries
- Recent rule violations
- Recent removals by rule

Post-rate counts and severe violation summaries can be added when those accepted extensions are implemented.

## Accepted Extensions

These features are accepted for the product but do not need to block the first core implementation unless explicitly promoted into MVP later.

### Moderator Daily Review Digest

Generate a daily moderator summary with:

- New strikes issued
- Reversals
- Removed posts and comments
- NSFW markings
- Severe violation actions
- Users near configured thresholds
- Users over the post-rate limit
- Recent high-risk repeat offenders

### Severe Violation Fast Ban Flow

Add a high-severity moderator action for violations that should bypass ordinary warning flow.

Expected behavior:

- Remove the post or comment.
- Add a severe violation ledger entry.
- Add a native Reddit mod note.
- Optionally ban the user with a configured duration or permanent ban.
- Optionally lock the content.
- Show the action in user history and daily digest.

### NSFW Review Helper

Extend `Warn and mark NSFW` with configured NSFW reasons.

Suggested reasons:

- Suggestive pose
- Underwear or lingerie
- Too much skin
- Borderline adult content
- Incorrectly unmarked NSFW

### Post Rate Ledger

Track user post frequency in rolling windows.

Default behavior:

- Configurable post limit per rolling 24 hours.
- Track post count per user.
- Show post counts in user moderation profile.
- Show over-limit users in the daily digest.

Possible moderator actions:

- Warn for post-rate violation.
- Remove latest over-limit post.
- Remove all over-limit posts.
- Add configured strike points.

## Configuration Required For MVP

Required settings:

- Rule list
- Warn point value, default `1`
- Warn and remove point value, default `3`
- Warn and mark NSFW point value, default `1`
- Strike decay amount, default `1`
- Strike decay interval, default `30` days
- Default public comment template

Recommended settings:

- Distinguish app comments as mod
- Include current total in public comment
- Add native mod notes
- Add native mod notes for reversals

## Public Comment Template

The MVP should support a simple template with placeholders.

Suggested placeholders:

- `{ruleLabel}`
- `{pointsAdded}`
- `{currentTotal}`
- `{activePointsAdded}`
- `{action}`
- `{targetPermalink}`

Default text:

```text
Moderator notice: this content violates {ruleLabel}. This action added {pointsAdded} point(s) to your subreddit warning record. Your current total is {currentTotal}.
```

## Data Storage

Use Devvit Redis for:

- Rule configuration
- User active totals
- User ledger entries
- User post-rate counters in accepted extension phase
- Daily digest snapshots in accepted extension phase

Suggested key layout:

```text
rules
user:{userId}:active_total
user:{userId}:ledger
target:{targetId}:entries
user:{userId}:post_rate
digest:{yyyy-mm-dd}
```

If `userId` is not available, use a username-based fallback key:

```text
user_name:{username}:active_total
user_name:{username}:ledger
```

## MVP Non-Goals

- Auto-ban thresholds
- Automatic side-effect undo after reversal
- Public user self-check
- Bulk export
- External services
- AI moderation
- Automatic detection
- Full daily digest automation
- Automatic severe-violation detection

## Acceptance Criteria

- A moderator can warn a post author for a selected rule.
- A moderator can warn a comment author for a selected rule.
- A moderator can warn and remove a post.
- A moderator can warn and remove a comment.
- A moderator can warn and mark a post NSFW.
- Each action creates exactly one ledger entry.
- Each action stores the original point value in the ledger.
- The user's active total reflects configured step decay.
- Reversed entries do not contribute to the user's active total.
- A moderator can reverse an active strike with a required reason.
- A reversed strike remains visible in history.
- Each action leaves a public explanation comment.
- Moderators can view recent strike history for the selected author.
- Moderators can view the selected author's moderation profile.
- No non-moderator can use enforcement or history actions.

## Open Product Decisions

- Should public comments include strike totals by default?
- Should comments be stickied when possible?
- Should the app lock its own explanation comments?
- Should warnings apply to deleted or suspended users?
- Should rule configuration be stored in Devvit install settings, Redis, or both?
- Should reversal allow an optional public correction comment in version 2?
- What should the default post-rate limit be for this subreddit?
- Should severe violation bans default to permanent or temporary?
