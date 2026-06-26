# Settings Workflow

## Purpose

Settings combine TypeScript defaults, native Devvit settings, Redis-owned config, JSON import/export, validation, and generated `devvit.json` defaults.

## Read First

- [MVP.md](../../../MVP.md): `Configuration And Settings`, `Source Of Truth`, `Native Settings And Admin UI`, `Required Settings`, `Rule Schema`, `Validation`, `Settings Audit`, template sections.
- [../modules/core-config.md](../modules/core-config.md)
- [../modules/routes.md](../modules/routes.md)

## Primary Files

- `src/core/config.ts`: defaults and config validation.
- `src/core/configRepository.ts`: Redis-owned config and settings audit records.
- `src/core/nativeSettings.ts`: native setting parsing and conversion.
- `src/core/templates.ts`: template placeholders and rendering.
- `src/routes/settingsValidators.ts`: Devvit native setting validators.
- `src/routes/api.ts`: Admin settings endpoints.
- `scripts/sync-devvit-settings.mjs`: generated `devvit.json` sync and check.

## Key Invariants

- TypeScript defaults and placeholder lists are the source of truth for generated native setting defaults.
- Public comments must not expose private point or active-total placeholders.
- Settings saves must validate before persistence and record audit context.
- `README.md` is public moderator-manual content; internal rationale belongs in `PROJECT_README.md` or internal docs.

## Stale Wording Checks

Before finishing settings or template changes, grep docs and generated config for old source-of-truth wording: manual `devvit.json` edits, public/private placeholder mixups, `README.md` developer-only rationale, and version text that does not match `package.json`.

## Targeted Checks

```sh
npm test -- src/core/config.test.ts src/core/configRepository.test.ts src/core/templates.test.ts src/routes/settingsValidators.test.ts src/routes/api.test.ts
npm run check-devvit-settings
```
