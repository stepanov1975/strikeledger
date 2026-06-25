# Routes Module Group

## Owns

Devvit-facing Hono route surfaces for menu actions, forms, settings validators, scheduler tasks, triggers, and dashboard API endpoints.

## Does Not Own

- Durable Redis data model details. Use `src/core/ledgerRepository.ts` and related core modules.
- Reddit side-effect sequencing. Use `src/core/sideEffects.ts`.
- Config schema semantics. Use `src/core/config.ts` and `src/core/nativeSettings.ts`.

## Primary Files

- `src/index.ts`
- `src/routes/api.ts`
- `src/routes/menu.ts`
- `src/routes/forms.ts`
- `src/routes/enforcementSubmit.ts`
- `src/routes/permissions.ts`
- `src/routes/scheduler.ts`
- `src/routes/settingsValidators.ts`
- `src/routes/triggers.ts`

## Edit Guidance

- Route handlers are boundaries. Parse external input here and pass trusted shapes to core modules.
- Re-check moderator permissions on every protected read or mutation path.
- Keep moderator-facing messages clear and short.
- Do not add client-trusted authorization checks.

## Tests

```sh
npm test -- src/routes/api.test.ts src/routes/menu.test.ts src/routes/forms.test.ts src/routes/enforcementSubmit.test.ts src/routes/scheduler.test.ts src/routes/settingsValidators.test.ts src/routes/triggers.test.ts
```
