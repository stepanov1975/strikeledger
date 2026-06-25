# Enforcement Workflow

## Purpose

Moderator menu actions create trusted form context, validate the submit-time Reddit target, write a ledger entry, and then run configured Reddit side effects.

## Read First

- [MVP.md](../../../MVP.md): `Menu Actions`, `Enforcement Form`, `Actions`, `Preconditions`, `Side Effects And Partial Failure`, `Entry Model`, `Idempotency And Duplicates`, `Permissions`.
- [../modules/routes.md](../modules/routes.md)
- [../modules/core-ledger.md](../modules/core-ledger.md)
- [../modules/core-side-effects.md](../modules/core-side-effects.md)

## Primary Files

- `src/routes/menu.ts`: menu handlers, form creation, dashboard launch routing.
- `src/routes/forms.ts`: form submit route registration.
- `src/routes/enforcementSubmit.ts`: trusted submit workflow and final toast.
- `src/routes/permissions.ts`: moderator permission checks.
- `src/core/enforcement.ts`: ledger-entry construction and form nonce helpers.
- `src/core/ledgerRepository.ts`: nonce, duplicate, entry, index, and active-total writes.
- `src/core/sideEffects.ts`: Reddit public comment, removal, NSFW, mod note, and private message effects.
- `src/core/identity.ts`: durable user-key construction.
- `src/core/idempotency.ts`: duplicate and retry claim keys.

## Key Invariants

- Never trust client-submitted target IDs, usernames, action names, point values, or subreddit identity.
- Re-check moderator access on menu and submit paths.
- Re-fetch the Reddit target before ledger creation and block stale or blocked targets before writing.
- Write the ledger before side effects; record partial side-effect failure instead of hiding it.
- Durable ledger identity must use Reddit user IDs, not username-derived keys.

## Targeted Checks

```sh
npm test -- src/routes/menu.test.ts src/routes/forms.test.ts src/routes/enforcementSubmit.test.ts src/core/enforcement.test.ts src/core/idempotency.test.ts src/core/ledgerRepository.test.ts src/core/sideEffects.test.ts
```
