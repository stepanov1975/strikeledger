# Stage 2 Implementation Plan: Score-Based Upload Limits

## Scope

Stage 2 adds automatic post upload limit enforcement based on the author's ranked average post score for the subreddit.

The app cannot prevent a Reddit post from being submitted, so enforcement happens after `onPostSubmit` fires. The app continues collecting eligible post submission and score statistics even when enforcement is disabled.

This is an alpha implementation. Do not add backward compatibility, stored-config migration, or reset/clear tooling for Stage 2 data.

Default ranked regions:

| Ranked region | Default limit |
| --- | --- |
| Top 10% | Unlimited |
| 70-90% | 4 posts / 24h |
| 50-70% | 3 posts / 24h |
| 30-50% | 2 posts / 24h |
| 10-30% | 1 post / 24h |
| Bottom 10% | 1 post / 48h |

The region split is fixed. Only the allowed post count and rolling time window are configurable for each limited region.

## Current Foundation

- `onPostSubmit` is already registered in `devvit.json`.
- `src/routes/triggers.ts` already records submitted post IDs in `user:{userKey}:post_rate`.
- `src/routes/triggers.ts` already refreshes `user:{userKey}:post_score_summary` after a post submit when a username is available.
- `src/core/postScore.ts` already has helpers for average post score summaries and post-rate sorted set keys.
- `ConfigRepository` already supports Redis-owned config, native settings overlays, validation, revisions, and settings audit snapshots.
- Existing warning side effects demonstrate modmail, public comments, and post removal patterns. Stage 2 must keep rate-limit enforcement separate from StrikeLedger warning ledger entries.

## Accepted Product Decisions

### 1. Eligible authors

Only posts with a usable username are eligible for Stage 2 tracking and enforcement.

If the submitted post has no usable username, the trigger logs and exits before creating a processed-post record, post-rate entry, observed-user entry, score summary, rank entry, or side effect. Unknown or username-less authors are not tracked in dry mode either.

When both username and user ID are available, use the existing `getUserKey()` identity behavior: `id:{userId}` is primary, with normalized username available for display and modmail. When only a usable username is available, use the normalized username fallback key.

### 2. Ranked population

The ranked population is all observed eligible submitters in the same subreddit. A user becomes observed when the app handles an eligible post submission for that subreddit.

Users with no score history remain in the population and are ranked with score `0`. Score history means the cached average post score returned by the existing score-summary workflow. A `null` average maps to rank score `0`.

### 3. Percentile calculation and ties

Use ranked-bin percentile math, not score-ratio math.

Sort observed users by rank score ascending. Users with equal rank score must receive the same percentile and the same region.

For a user:

```text
percentile = (number of observed users with a strictly lower rank score / total observed users) * 100
```

Region mapping:

| Percentile | Region |
| --- | --- |
| `>= 90` | Top 10% |
| `>= 70` and `< 90` | 70-90% |
| `>= 50` and `< 70` | 50-70% |
| `>= 30` and `< 50` | 30-50% |
| `>= 10` and `< 30` | 10-30% |
| `< 10` | Bottom 10% |

This intentionally preserves ties even when tied groups make region sizes uneven.

### 4. Bootstrap behavior

Enforcement skips when either condition is true:

- observed eligible submitters for the subreddit are fewer than `minimumTrackedUsers`
- no observed eligible submitter has a positive rank score

The default `minimumTrackedUsers` is `20`.

During bootstrap, the app still claims eligible posts, records post-rate statistics, refreshes score summaries, and updates the rank index.

### 5. Configuration ownership

Stage 2 configuration has split ownership:

- Native Devvit install settings own only `postRateEnforcement.enabled` and `postRateEnforcement.dryMode`.
- Redis-owned Admin dashboard settings own the ranked-region limits, rolling windows, `minimumTrackedUsers`, and templates.

`StrikeLedgerConfig` should expose an effective `postRateEnforcement` object after applying native settings. Admin JSON import/export and settings audit snapshots must include only the Redis-owned Stage 2 fields. Admin save/import must not persist or override `enabled` or `dryMode`; native settings are the only source of truth for those two toggles.

Default state:

- `postRateEnforcement.enabled = false`
- `postRateEnforcement.dryMode = true`

When `enabled = false`, the app records eligible stats and makes no rate-limit side effects. When `enabled = true` and `dryMode = true`, dry mode wins and no destructive side effects run.

### 6. Templates and placeholders

Use separate templates for:

- modmail subject
- modmail body
- public comment

Validate all templates regardless of `enabled` or `dryMode`, so a config can be switched to real mode without another save.

Public comment placeholders are limited to public-safe rate-limit details:

- `{subredditName}`
- `{postLimit}`
- `{windowHours}`
- `{targetPermalink}`
- `{currentPostCount}`

Modmail subject/body placeholders may also include private diagnostic context:

- `{percentileRegion}`
- `{percentile}`
- `{averagePostScore}`
- `{trackedUserCount}`

Template limits:

- modmail subject template is required and must be 100 characters or fewer before rendering
- rendered modmail subject must be checked before sending; if it exceeds 100 characters, record modmail failure and stop before public comment or removal
- modmail body is required and must be 2000 characters or fewer before rendering
- public comment template is required and must be 2000 characters or fewer before rendering

Default modmail subject:

```text
Post rate limit notice for r/{subredditName}
```

Default modmail body:

```text
Your recent post in r/{subredditName} exceeded this community's upload limit of {postLimit} post(s) per {windowHours} hour(s). Current count: {currentPostCount}. Target: {targetPermalink}
```

Default public comment:

```text
Moderator notice: this post exceeded the community upload limit of {postLimit} post(s) per {windowHours} hour(s).
```

### 7. Audit model

Over-limit posts appear only in separate post-rate statistics and audit views. They do not create StrikeLedger warning ledger entries, zero-point entries, active totals, reversal rows, or warning-history records.

Store a versioned violation audit record at `post_rate_violation:{postId}` with:

- schema version
- post ID and permalink
- subreddit name
- user key and username
- submitted timestamp
- config revision
- decision inputs: rank score, percentile, region, tracked-user count, current post count, limit, and window
- dry-mode flag
- side-effect statuses and stop reason
- modmail conversation ID when available
- public comment ID when available
- removal status

Maintain a subreddit-level recent-violations sorted-set index, for example `subreddit:{subredditName}:post_rate_violations`, scored by decision time and containing post IDs.

### 8. Processed-post idempotency

Create a lightweight processed-post record for every eligible handled post, not only violations. Use a key such as `post_rate_processed:{postId}`.

The processed-post record must be claimed before stats and ranking updates. Use a Redis watched transaction or equivalent guard so concurrent duplicate triggers cannot both count the same post.

If a duplicate trigger finds an existing processed-post record for the same post ID, it exits immediately. It must not refresh score summaries, update rank data, update post-rate counts, send notices, comment, remove, or retry failed side effects.

This applies to every processed status, including disabled, bootstrap, under-limit, unlimited, dry-run, removed, stopped after modmail failure, stopped after public-comment failure, refetch failure, and partial failure.

### 9. Side-effect order and stop rules

For a real over-limit post, execute in this order:

1. claim the processed-post record
2. record post-rate stats and update observed-user/rank data
3. evaluate the current decision
4. refetch the submitted post server-side and validate subreddit and author when the API exposes enough data
5. create the violation audit record
6. send configured modmail to the author
7. add the configured public comment
8. remove only the submitted post with `isSpam = false`
9. update side-effect statuses after each attempted operation

If modmail fails, stop immediately. Do not public-comment or remove the post.

If public comment fails after modmail succeeds, stop before removal.

If removal fails after modmail and public comment succeed, record removal failure. Do not retry on duplicate trigger delivery.

In dry mode, create the processed-post record, record stats/ranking, create the violation audit record, send modmail, and stop with public comment and removal marked skipped because of dry mode. If dry-mode modmail fails, record the failure and stop.

### 10. Removal behavior

Remove only the submitted post that triggered the violation, using `isSpam = false`. Do not remove older posts in the same rolling window.

### 11. Dashboard visibility

Stage 2 dashboard scope is:

- Admin settings editor for the rate-limit config
- profile display of the selected user's observed post count, average score, percentile, region, and current rolling-window count
- recent rate-limit violations list in Admin

No daily digest changes are included in Stage 2.

## Proposed Data Model

Add Redis keys:

```text
post_rate_processed:{postId}
post_rate_violation:{postId}
subreddit:{subredditName}:observed_submitters
subreddit:{subredditName}:post_score_rank
subreddit:{subredditName}:post_rate_violations
```

Continue using:

```text
user:{userKey}:post_rate
user:{userKey}:post_score_summary
settings_audit:{timestamp}:{moderatorUsername}
settings_audit_snapshot:{timestamp}:{moderatorUsername}
```

`subreddit:{subredditName}:observed_submitters` is a sorted set of eligible user keys scored by latest observed submit time.

`subreddit:{subredditName}:post_score_rank` is a sorted set of eligible user keys scored by rank score, where `null` average post score is stored as `0`.

`user:{userKey}:post_rate` remains a sorted set of submitted post IDs scored by submitted timestamp.

Extend the local `RedisStore` abstraction as needed for this feature. At minimum, implementation needs a way to:

- read sorted-set members with scores
- get sorted-set cardinality
- prune old sorted-set entries by score, or fetch and remove old members deterministically

Prefer small explicit methods over leaking the full Devvit Redis client into domain code.

## Implementation Stages

### Stage 2.1: Contract and configuration

Update the product contract before feature code.

Implementation targets:

- Promote the accepted Post Rate Ledger extension into a Stage 2 section in `MVP.md`.
- Extend `StrikeLedgerConfig` with effective `postRateEnforcement` settings.
- Add native Devvit install settings for `postRateEnforcement.enabled` and `postRateEnforcement.dryMode`, defaulting to disabled and dry mode on.
- Add Redis-owned defaults matching the ranked-region table, minimum tracked-user count, and templates.
- Add validation for limited-region post counts, rolling window hours, minimum tracked-user count, and all templates.
- Add Admin settings UI controls and JSON import/export support for Redis-owned Stage 2 fields only.
- Show the current effective enabled/dry-mode state in Admin as read-only context or omit it from Admin editing; do not make these toggles editable outside native install settings.
- Ensure settings saves still use revision conflict checks and audit snapshots.

Suggested validation constraints:

- native `enabled` and `dryMode`: booleans read from Devvit install settings, falling back to defaults if absent or malformed
- `minimumTrackedUsers`: integer from 1 to 100000
- limited-region `postLimit`: integer from 1 to 100
- limited-region `windowHours`: integer from 1 to 8760
- modmail subject template: required, max 100 characters before rendering, accepted placeholders only
- modmail body and public comment templates: required, max 2000 characters, accepted placeholders only

Verify:

- A fresh config loads Stage 2 defaults.
- Native install settings are the only way to change `enabled` and `dryMode`.
- Admin save/import cannot change `enabled` or `dryMode`.
- Invalid limits, windows, minimum population, and templates are rejected.
- Admin JSON import/export includes Redis-owned Stage 2 config and excludes native-only `enabled`/`dryMode`.
- Settings saves still conflict on stale revision and write audit snapshots.

### Stage 2.2: Redis support and processed-post guard

Make post-submit handling idempotent before adding enforcement behavior.

Implementation targets:

- Extend `RedisStore`, `DevvitRedisStore`, and `FakeRedisStore` with the sorted-set operations Stage 2 needs.
- Add processed-post record parsing/serialization with schema-version validation.
- Add a watched transaction that claims `post_rate_processed:{postId}` before any stats update.
- Make duplicate triggers exit immediately when the processed-post record already exists.
- Update `src/routes/triggers.ts` to require subreddit name, post ID, and usable username before claiming or tracking.

Verify:

- Duplicate trigger delivery for the same eligible post records stats only once.
- Duplicate trigger delivery exits before score refresh and side effects.
- Username-less/unknown authors do not create processed, stats, rank, or violation records.
- A processed record is written for disabled, bootstrap, under-limit, unlimited, dry-run, and real enforcement decisions.

### Stage 2.3: Observed-user and rank index

Maintain the subreddit-level observed population and rank index.

Implementation targets:

- Add helpers for observed submitter and post-score rank keys.
- Add each eligible submitter to `subreddit:{subredditName}:observed_submitters` after the processed-post claim succeeds.
- Refresh the user's post score summary when possible.
- Update `subreddit:{subredditName}:post_score_rank` whenever a user's score summary is refreshed or initialized.
- Store rank score `0` when the cached summary has `averagePostScore = null`.
- Add helpers that compute tracked-user count, positive-score presence, tie-preserving percentile, and region.

Verify:

- All eligible submitters enter the observed population.
- Users with no score history are ranked with score `0`.
- Equal scores receive the same percentile and region.
- Higher scores map to stronger regions.
- Boundary values map to the accepted region table.
- Bootstrap skips when tracked population is too small or all rank scores are `0`.

### Stage 2.4: Rolling post-count evaluator

Evaluate the submitted post against the configured region limit.

Implementation targets:

- Record the submitted post in `user:{userKey}:post_rate` after the processed-post claim succeeds.
- Prune old post-rate entries where possible.
- Count submitted posts in the current user's applicable rolling window.
- Include the newly submitted post in the count.
- Return a structured decision: skipped disabled, skipped bootstrap, unlimited, under limit, over limit dry-run, or over limit real.

Verify:

- Enforcement off still records eligible statistics but returns no side effects.
- Dry mode wins when `enabled = true` and `dryMode = true`.
- Top 10% users are unlimited.
- Each limited region enforces its own post count and window.
- The bottom 10% default uses 1 post per 48 hours.
- Rolling counts do not double-count duplicate trigger delivery.

### Stage 2.5: Violation side effects and audit records

Execute side effects for over-limit submissions and record stop reasons.

Implementation targets:

- Refetch the post server-side by ID before side effects.
- Validate the refetched post still belongs to the expected subreddit and author when the API exposes enough data.
- Create the versioned violation audit record before side effects.
- Send configured modmail to the author.
- In dry mode, stop after modmail and mark public comment/removal skipped.
- In real mode, add the configured public comment after successful modmail.
- In real mode, remove only the submitted post after successful public comment.
- Update violation and processed-post records with final decision status and side-effect details.
- Add structured logs for each decision and side-effect outcome.

Verify:

- Dry mode sends modmail, skips public comment/removal, and records the dry-mode skip reason.
- Real mode removes over-limit posts only after modmail and public comment succeed.
- Modmail failure stops before public comment and removal.
- Public-comment failure stops before removal.
- Removal failure is recorded without retrying on duplicate trigger delivery.
- Refetch or target-validation failure is recorded and causes no side effects.
- Trigger retries do not duplicate notices, comments, removal, score refresh, or post-rate counts.

### Stage 2.6: Dashboard visibility

Expose enough information for moderators to tune and audit the feature.

Implementation targets:

- Show post-rate enforcement settings in Admin.
- Show current user post-rate context in profile:
  - observed post count
  - average post score
  - percentile
  - region
  - current rolling-window count for the applicable region
- Add a recent rate-limit violations list in Admin.
- Keep all API authorization server-side and moderator-only.

Verify:

- Moderator-only API routes still re-check permissions.
- Profile renders with and without rate-limit data.
- Disabled enforcement still shows collected eligible statistics.
- Admin recent violations render dry-run, stopped, removed, and failed states.
- No non-moderator can read rate-limit settings, profile context, or violation audit records.

### Stage 2.7: Playtest and operations

Document live validation steps.

Implementation targets:

- Update `PLAYTEST.md` with disabled, bootstrap, dry-mode, over-limit, under-limit, unlimited, duplicate-trigger, modmail-failure, public-comment-failure, and removal-failure scenarios.
- Note that ranking starts from app-observed eligible submitters only.
- Note that username-less/unknown authors are ignored for Stage 2.

Verify:

- `npm run type-check`
- `npm test`
- `npm run lint`
- `npm run build`
- Live Devvit playtest for actual trigger behavior, modmail delivery, public comment creation, post removal, and duplicate trigger behavior.

## Success Criteria

- Eligible statistics are collected regardless of enforcement enabled state.
- Unknown or username-less authors are not tracked or enforced.
- With enforcement disabled, no rate-limit side effects run.
- With bootstrap conditions unmet, no rate-limit side effects run.
- With dry mode enabled, over-limit users receive the configured modmail explanation and the post is not commented on or removed.
- With enforcement enabled and dry mode disabled, over-limit submitted posts are removed only after modmail and public comment succeed.
- Top 10% users are not limited.
- Each limited ranked region uses its configured post count and rolling window.
- Equal rank scores receive the same percentile and region.
- Trigger retries do not duplicate stats, score refresh, modmail, comments, removals, or retries.
- Moderators can configure the feature without editing code.
- Moderators can see profile post-rate context and recent violation audit records.
- Local verification passes, with live Reddit/Devvit behavior called out separately.
