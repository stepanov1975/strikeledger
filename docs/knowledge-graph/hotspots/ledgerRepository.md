# Hotspot: LedgerRepository

## Why Risky

`src/core/ledgerRepository.ts` owns the Redis-backed ledger write model, idempotency claims, active-total cache, indexes, reversal, cleanup, and target deletion scrubbing. Small changes can affect enforcement, dashboard reads, retention, and account-deletion compliance.

## Symbols To Understand

- `LedgerRepository`
- `CreateLedgerEntryRequest`
- `ReverseLedgerEntryRequest`
- `CleanupLedgerRequest`
- `MarkTargetDeletedRequest`
- `DeleteUserLedgerResult`

## Invariants

- Ledger entries are audit records; normal reversal does not delete them.
- Duplicate and retry claims must prevent repeated submissions from creating repeated entries or side effects.
- Active totals are rebuildable from ledger entries.
- Cleanup and deletion paths must update related indexes consistently.

## Targeted Checks

```sh
npm test -- src/core/ledgerRepository.test.ts src/core/accountDeletion.test.ts src/core/ledgerCleanup.test.ts src/routes/api.test.ts src/routes/enforcementSubmit.test.ts
```
