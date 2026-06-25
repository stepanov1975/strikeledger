# Knowledge Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal StrikeLedger knowledge graph that helps agents route themselves to the right workflows, modules, source files, tests, and `MVP.md` sections before editing code.

**Architecture:** Keep curated intent in `docs/knowledge-graph/**/*.md` and `docs/knowledge-graph/annotations.json`. Keep structural source relationships in script-owned `docs/knowledge-graph/generated/graph.json`, generated from TypeScript AST imports/exports and annotation metadata.

**Tech Stack:** Node.js ESM scripts, TypeScript compiler API, Node built-in test runner, npm scripts, markdown docs.

---

## File Structure

- Create `scripts/generate-knowledge-graph.test.mjs`: Node tests for the graph builder and timestamp-normalized stale checks.
- Create `scripts/generate-knowledge-graph.mjs`: CLI and exported graph builder.
- Modify `package.json`: add `generate-knowledge-graph`, `check-knowledge-graph`, and `test:knowledge-graph`.
- Create `docs/knowledge-graph/README.md`: retrieval entrypoint.
- Create `docs/knowledge-graph/annotations.json`: curated document-to-source mapping.
- Create `docs/knowledge-graph/workflows/*.md`: workflow-level routing docs.
- Create `docs/knowledge-graph/modules/*.md`: module group routing docs.
- Create `docs/knowledge-graph/hotspots/*.md`: symbol-level hotspot notes for risky files.
- Generate `docs/knowledge-graph/generated/graph.json`: script-owned structural graph.

## Task 1: Generator Tests

**Files:**
- Create: `scripts/generate-knowledge-graph.test.mjs`

- [ ] **Step 1: Write the failing test**

Create a Node test file that imports the not-yet-created script API:

```js
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKnowledgeGraph,
  normalizeForComparison,
} from './generate-knowledge-graph.mjs';
```

The first test should build a temp fixture with `src/core/foo.ts`, `src/core/foo.test.ts`, `src/routes/bar.ts`, and `docs/knowledge-graph/annotations.json`, then assert:

- `src/core/foo.ts` exports `Foo` and `buildFoo`;
- `src/routes/bar.ts` imports `src/core/foo.ts`;
- `src/core/foo.ts` is paired with `src/core/foo.test.ts`;
- annotation documents produce document nodes and `documents` / `workflowTouches` edges;
- source nodes list their `curatedDocs`.

The second test should assert that `normalizeForComparison` ignores `generatedAt` differences but preserves structural differences.

- [ ] **Step 2: Run the test to verify RED**

Run:

```sh
node --test scripts/generate-knowledge-graph.test.mjs
```

Expected: FAIL because `scripts/generate-knowledge-graph.mjs` does not exist.

## Task 2: Generator Implementation

**Files:**
- Create: `scripts/generate-knowledge-graph.mjs`
- Test: `scripts/generate-knowledge-graph.test.mjs`

- [ ] **Step 1: Implement the minimal script API**

Use the TypeScript compiler API to parse files. Export:

```js
export async function buildKnowledgeGraph(rootDir, options = {}) {}
export function normalizeForComparison(graph) {}
export async function main(argv = process.argv.slice(2), rootDir = process.cwd()) {}
```

The generated graph shape is:

```js
{
  version: 1,
  generatedAt: new Date().toISOString(),
  nodes: [],
  edges: [],
}
```

Each module node should include `id`, `kind`, `layer`, `exports`, `imports`, `tests`, and `curatedDocs`.

- [ ] **Step 2: Run the test to verify GREEN**

Run:

```sh
node --test scripts/generate-knowledge-graph.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Add CLI check behavior**

`node scripts/generate-knowledge-graph.mjs` writes `docs/knowledge-graph/generated/graph.json`.

`node scripts/generate-knowledge-graph.mjs --check` reads the existing generated file, normalizes `generatedAt` on both sides, exits `0` if current, and exits `1` with a clear message if stale.

- [ ] **Step 4: Re-run the script tests**

Run:

```sh
node --test scripts/generate-knowledge-graph.test.mjs
```

Expected: PASS.

## Task 3: Curated Knowledge Graph Docs

**Files:**
- Create: `docs/knowledge-graph/README.md`
- Create: `docs/knowledge-graph/annotations.json`
- Create: `docs/knowledge-graph/workflows/enforcement.md`
- Create: `docs/knowledge-graph/workflows/dashboard.md`
- Create: `docs/knowledge-graph/workflows/settings.md`
- Create: `docs/knowledge-graph/workflows/cleanup-and-retention.md`
- Create: `docs/knowledge-graph/modules/routes.md`
- Create: `docs/knowledge-graph/modules/core-ledger.md`
- Create: `docs/knowledge-graph/modules/core-config.md`
- Create: `docs/knowledge-graph/modules/core-side-effects.md`
- Create: `docs/knowledge-graph/modules/client-dashboard.md`
- Create: `docs/knowledge-graph/hotspots/ledgerRepository.md`
- Create: `docs/knowledge-graph/hotspots/api-routes.md`
- Create: `docs/knowledge-graph/hotspots/enforcementSubmit.md`
- Create: `docs/knowledge-graph/hotspots/sideEffects.md`

- [ ] **Step 1: Add the retrieval entrypoint**

`docs/knowledge-graph/README.md` should say the graph is internal-only, points to `MVP.md` as the contract, and routes common edits to workflow/module/hotspot docs.

- [ ] **Step 2: Add concise curated docs**

Each workflow doc should include: purpose, read first, primary files, key invariants, and local checks.

Each module doc should include: owns, does not own, dependencies, tests, and edit guidance.

Each hotspot doc should include: why risky, symbols to understand, invariants, and tests.

- [ ] **Step 3: Add annotations**

`annotations.json` should map every curated doc to source files, test files, and `MVP.md` sections using this shape:

```json
{
  "version": 1,
  "documents": [
    {
      "path": "docs/knowledge-graph/workflows/enforcement.md",
      "kind": "workflow",
      "title": "Enforcement",
      "mvpSections": ["Enforcement Workflow", "Ledger And Scoring"],
      "sourceFiles": ["src/routes/menu.ts", "src/routes/enforcementSubmit.ts"],
      "testFiles": ["src/routes/menu.test.ts", "src/routes/enforcementSubmit.test.ts"]
    }
  ]
}
```

## Task 4: Package Scripts And Generated Graph

**Files:**
- Modify: `package.json`
- Create: `docs/knowledge-graph/generated/graph.json`

- [ ] **Step 1: Add npm scripts**

Add:

```json
"generate-knowledge-graph": "node scripts/generate-knowledge-graph.mjs",
"check-knowledge-graph": "node scripts/generate-knowledge-graph.mjs --check",
"test:knowledge-graph": "node --test scripts/generate-knowledge-graph.test.mjs"
```

- [ ] **Step 2: Generate the graph**

Run:

```sh
npm run generate-knowledge-graph
```

Expected: `docs/knowledge-graph/generated/graph.json` exists and contains source, test, document, import, test, and document edges.

- [ ] **Step 3: Check the graph**

Run:

```sh
npm run check-knowledge-graph
```

Expected: PASS with a current graph message.

## Task 5: Verification And Commit

**Files:**
- Review all files changed in this plan.

- [ ] **Step 1: Run targeted verification**

Run:

```sh
npm run test:knowledge-graph
npm run check-knowledge-graph
```

Expected: PASS.

- [ ] **Step 2: Run standard repo verification**

Run:

```sh
npm run type-check
npm test
npm run lint
npm run build
```

Expected: PASS. Known Devvit/Vite warnings are acceptable only if the command exits `0`.

- [ ] **Step 3: Check whitespace and diff**

Run:

```sh
git diff --check
git diff --stat
```

Expected: no whitespace errors; diff limited to plan, script, package scripts, generated graph, and internal docs.

- [ ] **Step 4: Commit**

Run:

```sh
git add package.json scripts/generate-knowledge-graph.mjs scripts/generate-knowledge-graph.test.mjs docs/knowledge-graph docs/superpowers/plans/2026-06-25-knowledge-graph.md
git commit -m "feat: add knowledge graph"
```

Expected: one implementation commit.
