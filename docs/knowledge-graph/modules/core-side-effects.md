# Core Side Effects Module Group

## Owns

Execution and reversal marking for Reddit-facing side effects after durable ledger writes.

## Does Not Own

- Ledger entry creation and idempotency claims.
- Moderator permission checks.
- UI rendering of side-effect status.

## Primary Files

- `src/core/sideEffects.ts`
- `src/core/templates.ts`
- `src/core/logging.ts`
- `src/core/domain.ts`

## Edit Guidance

- Do not undo Reddit side effects during reversal unless the product contract changes.
- Preserve the status distinction between `pending`, `skipped`, `succeeded`, and `failed`.
- Public comments stay outcome-neutral and must not expose private point totals.
- Private user notices and native mod notes may use private placeholders.

## Tests

```sh
npm test -- src/core/sideEffects.test.ts src/core/templates.test.ts
```
