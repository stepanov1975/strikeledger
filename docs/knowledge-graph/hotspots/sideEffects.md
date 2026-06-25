# Hotspot: Side Effects

## Why Risky

`src/core/sideEffects.ts` is where durable ledger state meets irreversible or externally visible Reddit API actions.

## Symbols To Understand

- `executeSideEffects`
- `executeReversalSideEffects`
- `SideEffectRedditClient`
- `ExecuteSideEffectsInput`
- `ExecuteReversalSideEffectsInput`

## Invariants

- Ledger writes happen before these side effects run.
- Side-effect status must identify required, configured, skipped, succeeded, and failed outcomes.
- Public comment option failures are tracked without deleting a successful public comment ID.
- Reversal records reversal-side-effect status but does not automatically undo the public comment, removal, NSFW state, mod note, or private message.

## Targeted Checks

```sh
npm test -- src/core/sideEffects.test.ts src/core/templates.test.ts src/routes/enforcementSubmit.test.ts
```
