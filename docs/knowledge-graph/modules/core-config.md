# Core Config Module Group

## Owns

Default config, rule validation, template validation/rendering, native setting conversion, Redis-owned config, and settings audit records.

## Does Not Own

- Public app-page/manual wording in `README.md`.
- Devvit manifest generation details outside `scripts/sync-devvit-settings.mjs`.
- Enforcement target validation.

## Primary Files

- `src/core/config.ts`
- `src/core/configRepository.ts`
- `src/core/nativeSettings.ts`
- `src/core/templates.ts`
- `src/core/canonicalJson.ts`
- `src/routes/settingsValidators.ts`
- `scripts/sync-devvit-settings.mjs`

## Edit Guidance

- Validate imports at boundaries and keep internal config strongly shaped.
- Do not allow private placeholders in public-comment templates.
- After default or placeholder changes, run `npm run sync-devvit-settings` or `npm run check-devvit-settings`.
- Keep app version files aligned only when the app version intentionally changes.

## Tests

```sh
npm test -- src/core/config.test.ts src/core/configRepository.test.ts src/core/templates.test.ts src/routes/settingsValidators.test.ts
npm run check-devvit-settings
```
