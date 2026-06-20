# Privacy Policy

Effective date: June 20, 2026

StrikeLedger is a free and open source Reddit Devvit moderation app. This policy explains what the app stores and how that data is used.

## Summary

StrikeLedger does not operate a separate hosted service, sell data, run advertising, process payments, or use external analytics. The app runs on Reddit's Developer Platform and stores moderation data in Devvit-provided app storage for the subreddit installation.

## Data The App Stores

StrikeLedger stores moderation ledger data needed to show warning history, active warning totals, audit trails, settings, and maintenance state. This can include:

- Subreddit identifiers.
- Reddit user identifiers for warned users and moderators.
- Target post or comment identifiers.
- Target permalinks where available.
- Rule labels, action type, point values, status, timestamps, moderator notes, side-effect results, and reversal details.
- App configuration, dashboard records, audit records, caches, and short-lived form or view tokens.

StrikeLedger does not intentionally store the body text of posts or comments. Target permalinks can contain Reddit post title slugs, so the app treats them as content-derived data.

## How Data Is Used

Stored data is used only to provide the app's moderation functionality:

- Recording warning actions.
- Calculating active warning totals.
- Showing moderator history and profile views.
- Showing a limited self-view to logged-in non-moderators.
- Supporting reversals, audit trails, settings, cleanup, and repair tools.
- Performing configured Reddit side effects such as public comments, private notices, removals, NSFW marking, locking, distinguishing, stickying, and native mod notes.

## Data Sharing

The app does not sell or share stored data with third-party services. Data remains within Reddit and Devvit systems except for information Reddit itself displays or sends as part of configured moderation actions.

Subreddit moderators decide how to configure and use the app in their community. Public comments, private messages, and native mod notes created by the app are Reddit content or Reddit moderation records and are governed by Reddit's own platform rules and policies.

## Data Retention And Deletion

StrikeLedger stores ledger history, active-total caches, settings, dashboard records, and short-lived tokens in Devvit app storage. The app includes cleanup tools for old reversed entries and old entries with no active points. Entries that still contribute active points may be retained for moderation audit context.

When Reddit deletion events are available, StrikeLedger is designed to scrub content-derived target permalinks for deleted posts or comments while preserving moderation audit metadata such as IDs, timestamps, rule/action information, moderator information, and point values.

Uninstalling or reinstalling the app may remove or orphan stored app data, depending on Reddit and Devvit platform behavior.

## Security

StrikeLedger relies on Reddit and Devvit platform controls for authentication, authorization, hosting, and storage. The app re-checks moderator permissions server-side before showing or changing protected moderation data.

No system can guarantee perfect security. Do not use StrikeLedger to store secrets, passwords, private keys, or sensitive personal information in moderator notes or configuration fields.

## Open Source And Support

The source code is available on GitHub:

https://github.com/stepanov1975/strikeledger

Support and issue reports can be opened through GitHub Issues:

https://github.com/stepanov1975/strikeledger/issues

## Changes

This policy may be updated as the app changes. Updates will be published in this repository.
