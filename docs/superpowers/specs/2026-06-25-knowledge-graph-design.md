# StrikeLedger Knowledge Graph Design

## Context

StrikeLedger has grown into several interacting areas: Devvit routes, Redis-backed core repositories, dashboard client code, generated Devvit settings, scheduled cleanup, and Reddit side effects. The graph should help Codex and other agents retrieve the right local context before editing code.

This is an internal developer artifact. It does not replace `MVP.md`, which remains the behavioral contract. It does not belong in `README.md`, which is public app-page and moderator-manual content.

## Goals

- Give agents a compact routing map for "I am touching X; what should I read first?"
- Link workflows to source files, tests, and relevant product-contract sections.
- Keep structural relationships fresh with a generated graph file.
- Keep intent, invariants, and risky edit notes in curated markdown.
- Add symbol-level notes only for large or high-risk hotspots.

## Non-Goals

- No graph database.
- No external hosted viewer.
- No full symbol graph for every function and type.
- No runtime tracing.
- No replacement for the standard verification commands or `PLAYTEST.md`.

## Proposed Files

```text
docs/knowledge-graph/
  README.md
  annotations.json
  workflows/
    enforcement.md
    dashboard.md
    settings.md
    cleanup-and-retention.md
  modules/
    routes.md
    core-ledger.md
    core-config.md
    core-side-effects.md
    client-dashboard.md
  hotspots/
    ledgerRepository.md
    api-routes.md
    enforcementSubmit.md
    sideEffects.md
  generated/
    graph.json
```

`README.md` is the retrieval entrypoint. It should explain which workflow, module, and hotspot notes to read for common edit paths.

`annotations.json` is the small curated input that maps markdown documents to source files, tests, and `MVP.md` sections. Keeping this structured avoids ad hoc markdown parsing.

`generated/graph.json` is script-owned. Humans should not edit it directly.

## Generated Graph

Add `scripts/generate-knowledge-graph.mjs`.

The script scans `src/**/*.ts` and extracts:

- module nodes for source and test files;
- static import edges between local modules;
- exported names from direct exported declarations;
- test pairing by `*.test.ts` naming convention;
- document relationships from `docs/knowledge-graph/annotations.json`.

The first generated schema should stay small:

```json
{
  "version": 1,
  "generatedAt": "2026-06-25T00:00:00.000Z",
  "nodes": [
    {
      "id": "src/core/ledgerRepository.ts",
      "kind": "module",
      "layer": "core",
      "exports": ["LedgerRepository"],
      "imports": ["src/core/domain.ts", "src/core/redisStore.ts"],
      "tests": ["src/core/ledgerRepository.test.ts"],
      "curatedDocs": ["docs/knowledge-graph/hotspots/ledgerRepository.md"]
    }
  ],
  "edges": [
    {
      "from": "src/core/ledgerRepository.ts",
      "to": "src/core/domain.ts",
      "kind": "imports"
    }
  ]
}
```

`generatedAt` is allowed to change on generation. Check mode should compare generated output after normalizing that timestamp so freshness checks do not fail only because time passed.

## Curated Docs

Workflow docs should answer:

- what user or platform workflow this covers;
- which `MVP.md` sections govern it;
- which source files and tests are primary;
- what authorization, idempotency, Redis, and Reddit side-effect invariants apply;
- what local checks are most relevant after edits.

Module docs should answer:

- what the module group owns;
- what it must not own;
- important dependencies;
- nearby tests;
- safe edit guidance.

Hotspot docs should answer:

- why the file is risky or large;
- the main exported symbols that matter;
- invariants that are easy to break;
- tests that should be run for targeted changes.

## Initial Coverage

Start with these workflow docs:

- `enforcement.md`: menu actions, form nonce, submit handling, ledger creation, side effects.
- `dashboard.md`: dashboard post bootstrap, view contexts, protected API routes, limited user view.
- `settings.md`: TypeScript defaults, native settings, generated `devvit.json`, settings validation.
- `cleanup-and-retention.md`: account deletion cleanup, deleted target scrubbing, ledger cleanup, scheduler.

Start with these hotspot docs:

- `ledgerRepository.md`
- `api-routes.md`
- `enforcementSubmit.md`
- `sideEffects.md`

This keeps v1 focused on areas where wrong context is most expensive.

## Package Scripts

Add:

```json
{
  "generate-knowledge-graph": "node scripts/generate-knowledge-graph.mjs",
  "check-knowledge-graph": "node scripts/generate-knowledge-graph.mjs --check"
}
```

`check-knowledge-graph` should fail when `generated/graph.json` is stale or malformed.

Do not add the check to `npm run build` in v1. Keep it available as an explicit local verification command until the graph proves stable and useful.

## Verification

For graph-only changes:

```sh
npm run check-knowledge-graph
```

For source changes that alter dependencies or file ownership, run:

```sh
npm run check-knowledge-graph
npm run type-check
npm test
npm run lint
npm run build
```

Live Reddit and Devvit behavior still requires `PLAYTEST.md`; the knowledge graph only represents local repository structure and curated local intent.

## Acceptance Criteria

- Agents can start from `docs/knowledge-graph/README.md` and find the right workflow, module, and hotspot docs for common edits.
- `generated/graph.json` can be regenerated deterministically apart from normalized timestamp metadata.
- `check-knowledge-graph` detects stale generated output.
- Curated docs link back to `MVP.md`, relevant source files, and relevant tests.
- The graph remains internal-only and does not change public `README.md` content.
