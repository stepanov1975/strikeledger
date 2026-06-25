# Cleanup And Retention Workflow

## Purpose

Scheduled cleanup and delete triggers keep stored moderation data bounded and scrub user or target identifiers when Reddit state requires it.

## Read First

- [MVP.md](../../../MVP.md): `Identity Keys`, `Entry Model`, `Storage`, `Permissions`, `Acceptance Criteria`.
- [PROJECT_README.md](../../../PROJECT_README.md): `Devvit Triggers`, `Data Retention Warning`.
- [../modules/core-ledger.md](../modules/core-ledger.md)
- [../hotspots/ledgerRepository.md](../hotspots/ledgerRepository.md)

## Primary Files

- `src/routes/scheduler.ts`: scheduled task route handling.
- `src/routes/triggers.ts`: post/comment delete trigger handling and placeholder triggers.
- `src/core/accountDeletion.ts`: tracked-user deletion checks.
- `src/core/ledgerCleanup.ts`: bounded ledger retention cleanup.
- `src/core/ledgerRepository.ts`: delete, scrub, cleanup, and index operations.
- `src/core/userIdentityIndexes.ts`: identity-related Redis key builders.

## Key Invariants

- Cleanup must be bounded by count and runtime limits.
- Account deletion cleanup removes ledger, active-total, and identifying index data for the tracked user ID.
- Post/comment delete triggers scrub stored target permalinks and mark target deletion without deleting audit entries.
- Placeholder triggers are intentionally registered no-ops unless the platform contract changes.

## Targeted Checks

```sh
npm test -- src/routes/scheduler.test.ts src/routes/triggers.test.ts src/core/accountDeletion.test.ts src/core/ledgerCleanup.test.ts src/core/ledgerRepository.test.ts
```
