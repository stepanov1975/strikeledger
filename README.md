# Reddit Strike System

A Devvit-based moderation app for tracking subreddit rule violations with a weighted, rule-specific ledger.

## Goal

Give moderators a consistent workflow for handling rule violations from a post or comment menu action:

1. Select the moderation action.
2. Select the broken rule or sub-rule.
3. Apply the configured consequence.
4. Leave a public explanation comment.
5. Record a ledger entry for the user.
6. Update the user's warning or strike score.
7. Add a native mod note for moderator visibility.

The app should feel similar in spirit to SubGuard, but use a richer ledger model instead of only a flat warning counter.

## Core Concept

The system stores every violation as an immutable-ish ledger entry. User totals are calculated from those entries, which makes the system easier to audit, reverse, decay, and explain.

Example actions:

| Action | Default points | Applies to | Result |
| --- | ---: | --- | --- |
| Warn | 1 | Posts and comments | Adds an explanation comment and records a violation |
| Warn and remove | 3 | Posts and comments | Adds an explanation comment, removes the content, and records a violation |
| Warn and mark NSFW | 1 | Posts only | Marks the post NSFW, adds an explanation comment, and records a violation |

All point values should be configurable per subreddit installation.

## Strike Decay

Strike decay should use a step model by default:

- Active points decrease by `1` point every `30` days.
- The decay amount and decay interval are configurable.
- Active points never go below `0`.
- Ledger entries are not deleted or rewritten when they decay.

Example with the default decay:

| Original points | Age | Active points |
| ---: | ---: | ---: |
| 1 | 0-29 days | 1 |
| 1 | 30+ days | 0 |
| 3 | 0-29 days | 3 |
| 3 | 30-59 days | 2 |
| 3 | 60-89 days | 1 |
| 3 | 90+ days | 0 |

The app should keep both concepts clear:

- `originalPoints`: the number of points issued at enforcement time.
- `activePoints`: the number of points that still count after decay.

## Reversals

Moderators should be able to reverse a strike from the user's strike history. Reversal should affect the app ledger and active total, but should not automatically undo Reddit moderation side effects in the first version.

MVP reversal behavior:

- Mark the ledger entry as reversed.
- Require a reversal reason.
- Record the reversing moderator and timestamp.
- Recalculate the user's active total from all non-reversed entries.
- Add a native Reddit mod note if enabled.
- Keep the original ledger entry visible in history with a `Reversed` status.

Reversal should not delete the original entry. The app should preserve the audit trail and clearly show both the original enforcement action and the reversal.

## Moderator Workflow

From a post or comment menu, a moderator should be able to choose:

- `Warn`
- `Warn and remove`
- `Warn and mark NSFW` for posts only
- `Show strike history`
- `Show user moderation profile`

After choosing an enforcement action, the app should show a confirmation form with:

- Rule or sub-rule dropdown
- Optional moderator note
- Optional public comment override
- Preview of points that will be added

Submitting the form should apply the action and show a success or failure toast.

## Accepted Feature Modules

These modules are accepted for the product direction. They may be implemented after the core warning and ledger workflow is stable.

### User Moderation Profile

Show a moderator-only profile for a selected user from post, comment, or history context.

The profile should include:

- Current active strike total
- Original lifetime points
- Decayed points
- Reversed entries
- Recent rule violations
- Post count in the last 24 hours and 7 days
- Prior removals by rule
- Prior severe violations

The profile should help moderators decide whether to warn, remove, escalate, or ban.

### Moderator Daily Review Digest

Provide a daily moderator summary, either scheduled or generated on demand.

The digest should include:

- New strikes issued
- Reversals
- Removed posts and comments
- NSFW markings
- Severe violation actions
- Users near configured thresholds
- Users over the post-rate limit
- Recent high-risk repeat offenders

### Severe Violation Fast Ban Flow

Provide a separate high-severity action for violations that should bypass the normal warning path.

Example use cases:

- Explicit sexual content where prohibited
- Sexualized minors
- Non-consensual intimate imagery
- Deepfakes of real people
- Celebrity or real-person impersonation where prohibited
- Severe spam or malicious behavior

Expected behavior:

- Remove the post or comment.
- Add a severe violation ledger entry.
- Add a native Reddit mod note.
- Optionally ban the user with a configured duration or permanent ban.
- Optionally lock the content.
- Show the action in user history and daily digest.

### NSFW Review Helper

Extend the `Warn and mark NSFW` workflow with specific NSFW review reasons.

Suggested reasons:

- Suggestive pose
- Underwear or lingerie
- Too much skin
- Borderline adult content
- Incorrectly unmarked NSFW

The selected NSFW reason should be saved in the ledger and included in moderator-facing history.

### Post Rate Ledger

Track user posting frequency in rolling windows.

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

## Rule Configuration

Rules should be configurable without code changes. Each rule should support:

- Stable rule ID
- Public label
- Optional parent rule
- Public explanation template
- Optional internal moderator note template
- Optional action-specific point override

Example rule model:

```json
{
  "id": "r1-personal-attacks",
  "label": "Rule 1: Personal attacks",
  "parentId": "r1",
  "publicTemplate": "Your content was flagged for personal attacks. Please review Rule 1 before participating again.",
  "internalNote": "Personal attack warning issued."
}
```

## Ledger Model

Each violation entry should capture enough context to answer: who was warned, why, by whom, where, and what happened.

Suggested fields:

- `entryId`
- `userId`
- `username`
- `subredditName`
- `targetId`
- `targetKind`: `post` or `comment`
- `targetPermalink`
- `action`: `warn`, `warn_remove`, or `warn_nsfw`
- `ruleId`
- `ruleLabel`
- `originalPoints`
- `activePoints` when displaying or caching calculated totals
- `moderatorUsername`
- `publicCommentId`
- `modNoteId`
- `createdAt`
- `reversedAt`
- `reversedBy`
- `reversalReason`
- `reversalNote`

User active totals can be derived from non-reversed entries after applying the configured step decay. A cached aggregate can also be stored for faster reads, but the ledger should remain the source of truth.

## Configuration

Initial settings should include:

- Points for each action
- Strike decay amount, default `1`
- Strike decay interval, default `30` days
- Rule and sub-rule definitions
- Public comment templates
- Whether app comments are distinguished as mod
- Whether app comments are stickied when possible
- Whether to include current strike total in public comments
- Whether to add native Reddit mod notes
- Whether reversal creates a native Reddit mod note
- Post-rate limit per rolling 24 hours
- Whether severe violation flow can ban users
- Default severe violation ban duration
- Optional thresholds for future notifications or bans

## Suggested Data Storage

Use Devvit Redis for subreddit-scoped app data:

- Ledger entries by user
- Cached user active totals
- User post-rate counters
- Daily digest snapshots
- Rule configuration
- Optional audit logs

Native Reddit mod notes should be treated as a secondary moderation trail, not the source of truth, because the app needs structured data for history, reversal, and scoring.

## Non-Goals For The First Version

- Automatic banning
- Automatic detection of violations
- Automatic undo of removed content, NSFW tags, or warning comments after reversal
- Cross-subreddit tracking
- External database integration
- Public user dashboard
- Advanced analytics beyond daily moderator digest

## Future Ideas

- Threshold actions, such as modmail notification or temporary ban recommendation
- Manual recalculation or cleanup jobs for cached decayed totals
- Manual adjustment tools
- Exportable moderation history
- Rule-level statistics
- Appeal workflow
- Moderator activity report beyond the daily review digest
