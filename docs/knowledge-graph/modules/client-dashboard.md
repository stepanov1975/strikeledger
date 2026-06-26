# Client Dashboard Module Group

## Owns

Plain TypeScript dashboard rendering for inline launchers/Profile preview, expanded moderator History/Admin, and limited user self view.

## Does Not Own

- Authorization. Server API routes own protected data checks.
- Durable view context storage. Use `src/core/dashboard.ts`.
- Ledger mutations. Use API routes and core repositories.

## Primary Files

- `src/client/dashboard.ts`
- `src/client/dashboardLaunch.ts`
- `src/client/compactEntryRows.ts`
- `src/client/dashboard.html`
- `src/client/dashboard.css`

## Edit Guidance

- Treat all API responses as boundary data.
- Keep inline Profile preview bounded and non-scrolling; do not render History lists, tables, or forms inline.
- Keep limited user view compact and free of moderator-only fields.
- Treat webview mode as asynchronous state. Guard delayed preview/bootstrap responses before mutating DOM.
- Keep `/api/bootstrap` expanded-only and single-flight so duplicate expanded callbacks cannot consume pending launch state twice.
- Prefer simple DOM and plain TypeScript over adding a framework.
- Do not make client state an authorization source.

## Tests

```sh
npm test -- src/client/dashboard.test.ts src/client/dashboardLaunch.test.ts src/client/compactEntryRows.test.ts src/routes/api.test.ts
```
