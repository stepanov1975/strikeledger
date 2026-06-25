# Core Ledger Module Group

## Owns

Ledger records, Redis storage abstractions, durable identity keys, scoring, idempotency keys, active-total cache rebuilds, cleanup, and account-deletion removal.

## Does Not Own

- Devvit route authorization. Use `src/routes/permissions.ts` and route handlers.
- Reddit side effects. Use `src/core/sideEffects.ts`.
- Dashboard DOM rendering. Use `src/client/dashboard.ts`.

## Primary Files

- `src/core/domain.ts`
- `src/core/ledgerRepository.ts`
- `src/core/redisStore.ts`
- `src/core/devvitRedisStore.ts`
- `src/core/scoring.ts`
- `src/core/identity.ts`
- `src/core/idempotency.ts`
- `src/core/accountDeletion.ts`
- `src/core/ledgerCleanup.ts`
- `src/core/userIdentityIndexes.ts`

## Edit Guidance

- Keep Redis keys namespaced and stable.
- Preserve audit entries unless the workflow is explicit account-deletion cleanup.
- Keep writes idempotent where retries are possible.
- Use watched transactions for critical multi-key updates.

## Tests

```sh
npm test -- src/core/ledgerRepository.test.ts src/core/devvitRedisStore.test.ts src/core/scoring.test.ts src/core/identity.test.ts src/core/idempotency.test.ts src/core/accountDeletion.test.ts src/core/ledgerCleanup.test.ts
```
