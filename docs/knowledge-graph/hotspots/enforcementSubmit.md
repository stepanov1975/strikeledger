# Hotspot: Enforcement Submit

## Why Risky

`src/routes/enforcementSubmit.ts` bridges untrusted form input, trusted Redis nonce context, submit-time Reddit target validation, ledger creation, side effects, and moderator-facing result messages.

## Symbols To Understand

- `handleEnforcementSubmit`
- `EnforcementSubmitDependencies`
- `EnforcementFormValues`
- `formatCreatedToast`
- `failedSideEffectLabels`

## Invariants

- The nonce record is the source of truth for target, action, moderator, subreddit, and author snapshot.
- Missing, expired, consumed, cross-moderator, or cross-subreddit nonces must block before ledger creation.
- Submit-time target fetch and author ID match are required before ledger creation.
- Side-effect failure should produce a partial result, not erase the ledger write.

## Targeted Checks

```sh
npm test -- src/routes/enforcementSubmit.test.ts src/core/enforcement.test.ts src/core/ledgerRepository.test.ts src/core/sideEffects.test.ts
```
