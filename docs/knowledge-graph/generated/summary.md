# Knowledge Graph Summary

Generated from source analysis and docs/knowledge-graph/annotations.json.

## Counts

- document: 13
- file: 4
- invariant: 6
- module: 56
- platformFact: 4
- reviewPack: 2
- route: 38

## Review Packs

### Dashboard Launch Review Pack

- Node: `review-pack:dashboard-launch`
- Summary: Read this pack before changes to inline launchers, expanded bootstrap, pending dashboard context, or limited dashboard access. Review duplicate mode callbacks, stale async renders, inline overflow, authorization, and Devvit entrypoint compatibility.
- Documents: `docs/knowledge-graph/hotspots/api-routes.md`, `docs/knowledge-graph/modules/client-dashboard.md`, `docs/knowledge-graph/modules/routes.md`, `docs/knowledge-graph/workflows/dashboard.md`
- Sources: `MVP.md`, `devvit.json`, `src/client/dashboard.ts`, `src/client/dashboardLaunch.ts`, `src/core/dashboard.ts`, `src/routes/api.ts`, `src/routes/menu.ts`, `src/routes/permissions.ts`
- Tests: `src/client/dashboard.test.ts`, `src/client/dashboardLaunch.test.ts`, `src/core/dashboard.test.ts`, `src/routes/api.test.ts`, `src/routes/menu.test.ts`
- Invariants: `invariant:dashboard-expanded-bootstrap-once`, `invariant:dashboard-inline-does-not-consume-bootstrap`, `invariant:dashboard-render-current-mode-only`, `invariant:inline-profile-preview-bounded`, `invariant:limited-dashboard-self-only`
- Platform facts: `platform-fact:devvit-custom-post-entrypoints`, `platform-fact:devvit-menu-client-effects`, `platform-fact:devvit-view-modes`

### Manifest Route Drift Review Pack

- Node: `review-pack:manifest-route-drift`
- Summary: Read this pack before changing devvit.json, generated settings, Devvit route mounts, or manifest endpoint validation.
- Documents: `docs/knowledge-graph/modules/routes.md`, `docs/knowledge-graph/workflows/cleanup-and-retention.md`, `docs/knowledge-graph/workflows/settings.md`
- Sources: `devvit.json`, `scripts/generate-knowledge-graph.mjs`, `src/index.ts`, `src/routes/forms.ts`, `src/routes/menu.ts`, `src/routes/scheduler.ts`, `src/routes/settingsValidators.ts`, `src/routes/triggers.ts`
- Tests: `scripts/generate-knowledge-graph.test.mjs`, `src/routes/forms.test.ts`, `src/routes/menu.test.ts`, `src/routes/scheduler.test.ts`, `src/routes/settingsValidators.test.ts`, `src/routes/triggers.test.ts`
- Invariants: `invariant:devvit-manifest-routes-match-generated-routes`
- Platform facts: `platform-fact:devvit-endpoint-configuration`, `platform-fact:devvit-menu-client-effects`

## Invariants

### Dashboard Expanded Bootstrap Once

- Node: `invariant:dashboard-expanded-bootstrap-once`
- Description: Expanded-mode bootstrap consumes pending menu launch state once per client session; duplicate expanded callbacks must reuse an in-flight or resolved bootstrap load instead of issuing a second consuming request.
- Sources: `src/client/dashboard.ts`, `src/client/dashboardLaunch.ts`, `src/core/dashboard.ts`, `src/routes/api.ts`
- Tests: `src/client/dashboard.test.ts`, `src/client/dashboardLaunch.test.ts`, `src/core/dashboard.test.ts`, `src/routes/api.test.ts`
- Docs: `docs/knowledge-graph/hotspots/api-routes.md`, `docs/knowledge-graph/modules/client-dashboard.md`, `docs/knowledge-graph/workflows/dashboard.md`
- Routes: `route:GET /api/bootstrap`
- Platform facts: `platform-fact:devvit-view-modes`

### Dashboard Inline Does Not Consume Bootstrap

- Node: `invariant:dashboard-inline-does-not-consume-bootstrap`
- Description: Inline dashboard rendering may show a compact launcher or bounded preview, but it must not call or consume /api/bootstrap before expanded mode opens.
- Sources: `src/client/dashboard.ts`, `src/client/dashboardLaunch.ts`, `src/core/dashboard.ts`, `src/routes/api.ts`
- Tests: `src/client/dashboard.test.ts`, `src/client/dashboardLaunch.test.ts`, `src/core/dashboard.test.ts`, `src/routes/api.test.ts`
- Docs: `docs/knowledge-graph/hotspots/api-routes.md`, `docs/knowledge-graph/modules/client-dashboard.md`, `docs/knowledge-graph/workflows/dashboard.md`
- Routes: `route:GET /api/bootstrap`, `route:GET /api/inline-profile-preview`
- Platform facts: `platform-fact:devvit-view-modes`

### Dashboard Render Current Mode Only

- Node: `invariant:dashboard-render-current-mode-only`
- Description: Async inline preview and expanded bootstrap responses must confirm the initiating webview mode is still current before writing DOM.
- Sources: `src/client/dashboard.ts`, `src/client/dashboardLaunch.ts`, `src/routes/api.ts`
- Tests: `src/client/dashboard.test.ts`, `src/client/dashboardLaunch.test.ts`
- Docs: `docs/knowledge-graph/modules/client-dashboard.md`, `docs/knowledge-graph/workflows/dashboard.md`
- Routes: `route:GET /api/bootstrap`, `route:GET /api/inline-profile-preview`
- Platform facts: `platform-fact:devvit-view-modes`

### Devvit Manifest Routes Match Generated Routes

- Node: `invariant:devvit-manifest-routes-match-generated-routes`
- Description: Every endpoint path declared in devvit.json for Devvit-backed surfaces must have a generated local POST route node, so manifest drift is caught before publish/playtest.
- Sources: `devvit.json`, `scripts/generate-knowledge-graph.mjs`, `src/index.ts`, `src/routes/forms.ts`, `src/routes/menu.ts`, `src/routes/scheduler.ts`, `src/routes/settingsValidators.ts`, `src/routes/triggers.ts`
- Tests: `scripts/generate-knowledge-graph.test.mjs`, `src/routes/forms.test.ts`, `src/routes/menu.test.ts`, `src/routes/scheduler.test.ts`, `src/routes/settingsValidators.test.ts`, `src/routes/triggers.test.ts`
- Docs: `docs/knowledge-graph/modules/routes.md`, `docs/knowledge-graph/workflows/cleanup-and-retention.md`, `docs/knowledge-graph/workflows/settings.md`
- Routes: `route:POST /internal/form/enforcement-submit`, `route:POST /internal/menu/history`, `route:POST /internal/menu/profile`, `route:POST /internal/menu/settings`, `route:POST /internal/menu/warn-comment`, `route:POST /internal/menu/warn-nsfw-post`, `route:POST /internal/menu/warn-post`, `route:POST /internal/menu/warn-remove-comment`, `route:POST /internal/menu/warn-remove-post`, `route:POST /internal/scheduler/account-deletion-check`, `route:POST /internal/scheduler/ledger-cleanup`, `route:POST /internal/settings/validate-days`, `route:POST /internal/settings/validate-decay-amount`, `route:POST /internal/settings/validate-points`, `route:POST /internal/settings/validate-private-template`, `route:POST /internal/settings/validate-public-template`, `route:POST /internal/triggers/on-app-install`, `route:POST /internal/triggers/on-comment-delete`, `route:POST /internal/triggers/on-mod-action`, `route:POST /internal/triggers/on-post-create`, `route:POST /internal/triggers/on-post-delete`, `route:POST /internal/triggers/on-post-flair-update`, `route:POST /internal/triggers/on-post-nsfw-update`, `route:POST /internal/triggers/on-post-spoiler-update`, `route:POST /internal/triggers/on-post-submit`, `route:POST /internal/triggers/on-post-update`
- Platform facts: `platform-fact:devvit-endpoint-configuration`, `platform-fact:devvit-menu-client-effects`

### Inline Profile Preview Bounded

- Node: `invariant:inline-profile-preview-bounded`
- Description: Inline Profile preview must use the non-consuming preview route and bounded cached data instead of full active-total recalculation or full history loading.
- Sources: `src/client/dashboard.ts`, `src/core/ledgerRepository.ts`, `src/core/scoring.ts`, `src/routes/api.ts`
- Tests: `src/client/dashboard.test.ts`, `src/client/dashboardLaunch.test.ts`, `src/core/dashboard.test.ts`, `src/routes/api.test.ts`
- Docs: `docs/knowledge-graph/hotspots/api-routes.md`, `docs/knowledge-graph/workflows/dashboard.md`
- Routes: `route:GET /api/inline-profile-preview`
- Platform facts: `platform-fact:devvit-view-modes`

### Limited Dashboard Self Only

- Node: `invariant:limited-dashboard-self-only`
- Description: Logged-in non-moderators can only receive their own current-subreddit limited summary, with no selected-user context token or arbitrary target lookup.
- Sources: `src/client/dashboard.ts`, `src/core/dashboard.ts`, `src/routes/api.ts`, `src/routes/permissions.ts`
- Tests: `src/core/dashboard.test.ts`, `src/routes/api.test.ts`
- Docs: `docs/knowledge-graph/hotspots/api-routes.md`, `docs/knowledge-graph/workflows/dashboard.md`
- Routes: `route:GET /api/bootstrap`, `route:GET /api/self-summary`
- Platform facts: `platform-fact:devvit-view-modes`

## Platform Facts

### Devvit Custom Post Entrypoints

- Node: `platform-fact:devvit-custom-post-entrypoints`
- Source: https://developers.reddit.com/docs/capabilities/creating_custom_post.md
- Reviewed: 2026-06-26
- Summary: Custom post launch behavior depends on configured entrypoints and matching submitCustomPost entry names. StrikeLedger keeps the dashboard entrypoint aligned between devvit.json and menu launch code.
- Applies to: `devvit.json`, `src/routes/menu.ts`

### Devvit Endpoint Configuration

- Node: `platform-fact:devvit-endpoint-configuration`
- Source: https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration.md
- Reviewed: 2026-06-26
- Summary: devvit.json declares endpoint-backed surfaces such as menu items, forms, settings validation, scheduler actions, and triggers. The generated graph checks those configured paths against local POST route nodes.
- Applies to: `devvit.json`, `scripts/generate-knowledge-graph.mjs`, `scripts/generate-knowledge-graph.test.mjs`

### Devvit Menu Client Effects

- Node: `platform-fact:devvit-menu-client-effects`
- Source: https://developers.reddit.com/docs/capabilities/client/menu-actions.md
- Reviewed: 2026-06-26
- Summary: Menu actions can run server processing and return client effects such as navigation or forms. StrikeLedger still treats server-side permission checks and Redis context as the trusted boundary.
- Applies to: `src/routes/forms.ts`, `src/routes/menu.ts`, `src/routes/permissions.ts`

### Devvit View Modes

- Node: `platform-fact:devvit-view-modes`
- Source: https://developers.reddit.com/docs/capabilities/server/launch_screen_and_entry_points/view_modes_entry_points.md
- Reviewed: 2026-06-26
- Summary: Devvit Web launch surfaces can enter inline and expanded view modes. StrikeLedger treats view mode as launch state, so inline rendering must not consume expanded-only bootstrap data.
- Applies to: `MVP.md`, `route:GET /api/bootstrap`, `route:GET /api/inline-profile-preview`, `src/client/dashboard.ts`, `src/client/dashboardLaunch.ts`, `src/routes/api.ts`

## Routes

- `route:GET /api/bootstrap` (`src/routes/api.ts`)
- `route:GET /api/history` (`src/routes/api.ts`)
- `route:GET /api/inline-profile-preview` (`src/routes/api.ts`)
- `route:GET /api/profile` (`src/routes/api.ts`)
- `route:GET /api/self-summary` (`src/routes/api.ts`)
- `route:GET /api/settings` (`src/routes/api.ts`)
- `route:GET /api/settings/audit` (`src/routes/api.ts`)
- `route:GET /api/settings/reddit-rules` (`src/routes/api.ts`)
- `route:POST /api/cleanup-ledger` (`src/routes/api.ts`)
- `route:POST /api/recalculate-user-total` (`src/routes/api.ts`)
- `route:POST /api/reverse` (`src/routes/api.ts`)
- `route:POST /api/settings` (`src/routes/api.ts`)
- `route:POST /internal/form/enforcement-submit` (`src/routes/forms.ts`)
- `route:POST /internal/menu/history` (`src/routes/menu.ts`)
- `route:POST /internal/menu/profile` (`src/routes/menu.ts`)
- `route:POST /internal/menu/settings` (`src/routes/menu.ts`)
- `route:POST /internal/menu/warn-comment` (`src/routes/menu.ts`)
- `route:POST /internal/menu/warn-nsfw-post` (`src/routes/menu.ts`)
- `route:POST /internal/menu/warn-post` (`src/routes/menu.ts`)
- `route:POST /internal/menu/warn-remove-comment` (`src/routes/menu.ts`)
- `route:POST /internal/menu/warn-remove-post` (`src/routes/menu.ts`)
- `route:POST /internal/scheduler/account-deletion-check` (`src/routes/scheduler.ts`)
- `route:POST /internal/scheduler/ledger-cleanup` (`src/routes/scheduler.ts`)
- `route:POST /internal/settings/validate-days` (`src/routes/settingsValidators.ts`)
- `route:POST /internal/settings/validate-decay-amount` (`src/routes/settingsValidators.ts`)
- `route:POST /internal/settings/validate-points` (`src/routes/settingsValidators.ts`)
- `route:POST /internal/settings/validate-private-template` (`src/routes/settingsValidators.ts`)
- `route:POST /internal/settings/validate-public-template` (`src/routes/settingsValidators.ts`)
- `route:POST /internal/triggers/on-app-install` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-comment-delete` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-mod-action` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-post-create` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-post-delete` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-post-flair-update` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-post-nsfw-update` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-post-spoiler-update` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-post-submit` (`src/routes/triggers.ts`)
- `route:POST /internal/triggers/on-post-update` (`src/routes/triggers.ts`)
