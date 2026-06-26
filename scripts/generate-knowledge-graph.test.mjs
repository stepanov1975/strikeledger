import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildKnowledgeGraph,
  buildKnowledgeGraphSummary,
  main,
  normalizeForComparison,
} from './generate-knowledge-graph.mjs';

const writeFixtureFile = async (rootDir, relativePath, contents) => {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
};

test('builds module, test, import, and curated document relationships', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(
    rootDir,
    'MVP.md',
    ['# MVP', '', '## Enforcement Workflow', ''].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'src/core/foo.ts',
    [
      "import type { RedisStore } from './redisStore';",
      '',
      'export interface Foo {',
      '  id: string;',
      '}',
      '',
      'const helper = 1;',
      '',
      'export const buildFoo = (id: string): Foo => ({ id });',
      'export { helper as exportedHelper };',
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'src/core/redisStore.ts',
    'export interface RedisStore { get(key: string): Promise<string | null>; }\n',
  );
  await writeFixtureFile(
    rootDir,
    'src/core/foo.test.ts',
    "import { buildFoo } from './foo';\n",
  );
  await writeFixtureFile(
    rootDir,
    'src/routes/bar.ts',
    [
      "import { buildFoo } from '../core/foo';",
      '',
      "export const useBar = () => buildFoo('bar');",
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/workflows/enforcement.md',
    '# Enforcement\n',
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [
          {
            path: 'docs/knowledge-graph/workflows/enforcement.md',
            kind: 'workflow',
            title: 'Enforcement',
            mvpSections: ['Enforcement Workflow'],
            sourceFiles: ['src/core/foo.ts', 'src/routes/bar.ts'],
            testFiles: ['src/core/foo.test.ts'],
          },
        ],
      },
      null,
      2,
    ),
  );

  const graph = await buildKnowledgeGraph(rootDir, {
    generatedAt: '2026-06-25T00:00:00.000Z',
  });

  const foo = graph.nodes.find((node) => node.id === 'src/core/foo.ts');
  const bar = graph.nodes.find((node) => node.id === 'src/routes/bar.ts');
  const doc = graph.nodes.find(
    (node) => node.id === 'docs/knowledge-graph/workflows/enforcement.md',
  );

  assert.ok(foo);
  assert.equal(foo.kind, 'module');
  assert.equal(foo.layer, 'core');
  assert.deepEqual(foo.exports, ['Foo', 'buildFoo', 'exportedHelper']);
  assert.deepEqual(foo.imports, ['src/core/redisStore.ts']);
  assert.deepEqual(foo.tests, ['src/core/foo.test.ts']);
  assert.deepEqual(foo.curatedDocs, [
    'docs/knowledge-graph/workflows/enforcement.md',
  ]);

  assert.ok(bar);
  assert.deepEqual(bar.imports, ['src/core/foo.ts']);

  assert.ok(doc);
  assert.equal(doc.kind, 'document');
  assert.equal(doc.documentKind, 'workflow');
  assert.deepEqual(doc.mvpSections, ['Enforcement Workflow']);

  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'imports' &&
        edge.from === 'src/routes/bar.ts' &&
        edge.to === 'src/core/foo.ts',
    ),
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'tests' &&
        edge.from === 'src/core/foo.ts' &&
        edge.to === 'src/core/foo.test.ts',
    ),
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'documents' &&
        edge.from === 'docs/knowledge-graph/workflows/enforcement.md' &&
        edge.to === 'src/core/foo.ts',
    ),
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'workflowTouches' &&
        edge.from === 'docs/knowledge-graph/workflows/enforcement.md' &&
        edge.to === 'src/routes/bar.ts',
    ),
  );
});

test('extracts mounted Hono routes as first-class route nodes', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## UI And API\n');
  await writeFixtureFile(
    rootDir,
    'src/index.ts',
    [
      "import { Hono } from 'hono';",
      "import { api } from './routes/api';",
      '',
      'const app = new Hono();',
      "app.route('/api', api);",
      '',
      'export default app;',
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'src/routes/api.ts',
    [
      "import { Hono } from 'hono';",
      '',
      'export const api = new Hono();',
      '',
      'const marker = Date.now();',
      "api.get('/bootstrap', async (c) => c.json({ ok: true }));",
      "api.post('/reverse', async (c) => c.json({ ok: true }));",
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [
          {
            path: 'docs/knowledge-graph/hotspots/api-routes.md',
            kind: 'hotspot',
            title: 'API Routes',
            mvpSections: ['UI And API'],
            sourceFiles: ['src/routes/api.ts'],
            testFiles: [],
          },
        ],
      },
      null,
      2,
    ),
  );

  const graph = await buildKnowledgeGraph(rootDir, {
    generatedAt: '2026-06-25T00:00:00.000Z',
  });

  const bootstrapRoute = graph.nodes.find(
    (node) => node.id === 'route:GET /api/bootstrap',
  );
  const reverseRoute = graph.nodes.find(
    (node) => node.id === 'route:POST /api/reverse',
  );

  assert.ok(bootstrapRoute);
  assert.equal(bootstrapRoute.kind, 'route');
  assert.equal(bootstrapRoute.method, 'GET');
  assert.equal(bootstrapRoute.path, '/api/bootstrap');
  assert.equal(bootstrapRoute.sourceFile, 'src/routes/api.ts');
  assert.deepEqual(bootstrapRoute.curatedDocs, [
    'docs/knowledge-graph/hotspots/api-routes.md',
  ]);

  assert.ok(reverseRoute);
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'definesRoute' &&
        edge.from === 'src/routes/api.ts' &&
        edge.to === 'route:POST /api/reverse',
    ),
  );
});

test('extracts mounted Hono routes declared through static tuple iteration', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## UI And API\n');
  await writeFixtureFile(
    rootDir,
    'src/index.ts',
    [
      "import { Hono } from 'hono';",
      "import { triggers } from './routes/triggers';",
      '',
      'const app = new Hono();',
      "app.route('/internal/triggers', triggers);",
      '',
      'export default app;',
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'src/routes/triggers.ts',
    [
      "import { Hono } from 'hono';",
      '',
      'export const triggers = new Hono();',
      '',
      'const placeholderTriggerRoutes = [',
      "  ['onPostSubmit', '/on-post-submit'],",
      "  ['onPostUpdate', '/on-post-update'],",
      '] as const;',
      '',
      'for (const [, route] of placeholderTriggerRoutes) {',
      '  triggers.post(route, (c) => c.json({ status: "success" }));',
      '}',
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [
          {
            path: 'docs/knowledge-graph/hotspots/api-routes.md',
            kind: 'hotspot',
            title: 'API Routes',
            mvpSections: ['UI And API'],
            sourceFiles: ['src/routes/triggers.ts'],
            testFiles: [],
          },
        ],
      },
      null,
      2,
    ),
  );

  const graph = await buildKnowledgeGraph(rootDir, {
    generatedAt: '2026-06-25T00:00:00.000Z',
  });

  assert.ok(
    graph.nodes.some(
      (node) => node.id === 'route:POST /internal/triggers/on-post-submit',
    ),
  );
  assert.ok(
    graph.nodes.some(
      (node) => node.id === 'route:POST /internal/triggers/on-post-update',
    ),
  );
});

test('builds invariants, platform facts, review packs, and summary text', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## Web UI Surfaces\n');
  await writeFixtureFile(rootDir, 'devvit.json', '{}\n');
  await writeFixtureFile(
    rootDir,
    'src/index.ts',
    [
      "import { Hono } from 'hono';",
      "import { api } from './routes/api';",
      '',
      'const app = new Hono();',
      "app.route('/api', api);",
      '',
      'export default app;',
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'src/routes/api.ts',
    [
      "import { Hono } from 'hono';",
      '',
      'export const api = new Hono();',
      "api.get('/bootstrap', async (c) => c.json({ ok: true }));",
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'src/routes/api.test.ts',
    "import { api } from './api';\n",
  );
  await writeFixtureFile(
    rootDir,
    'src/client/dashboard.ts',
    'export const openDashboard = () => undefined;\n',
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/workflows/dashboard.md',
    '# Dashboard\n',
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [
          {
            path: 'docs/knowledge-graph/workflows/dashboard.md',
            kind: 'workflow',
            title: 'Dashboard Workflow',
            mvpSections: ['Web UI Surfaces'],
            sourceFiles: ['src/routes/api.ts', 'src/client/dashboard.ts'],
            testFiles: ['src/routes/api.test.ts'],
          },
        ],
        platformFacts: [
          {
            id: 'devvit-view-modes',
            title: 'Devvit View Modes',
            source:
              'https://developers.reddit.com/docs/capabilities/server/launch_screen_and_entry_points/view_modes_entry_points',
            reviewedAt: '2026-06-26',
            summary:
              'Inline mode and expanded mode are separate launch states for the same entrypoint.',
            appliesTo: [
              'devvit.json',
              'src/client/dashboard.ts',
              'route:GET /api/bootstrap',
            ],
          },
        ],
        invariants: [
          {
            id: 'inline-bootstrap-boundary',
            title: 'Inline Bootstrap Boundary',
            description: 'Inline mode must not consume the expanded bootstrap.',
            sourceFiles: ['src/client/dashboard.ts', 'src/routes/api.ts'],
            testFiles: ['src/routes/api.test.ts'],
            documentPaths: ['docs/knowledge-graph/workflows/dashboard.md'],
            routeIds: ['route:GET /api/bootstrap'],
            platformFactIds: ['devvit-view-modes'],
          },
        ],
        reviewPacks: [
          {
            id: 'dashboard-launch',
            title: 'Dashboard Launch Review Pack',
            summary: 'Files and invariants for launch-surface reviews.',
            documents: ['docs/knowledge-graph/workflows/dashboard.md'],
            sourceFiles: [
              'devvit.json',
              'src/client/dashboard.ts',
              'src/routes/api.ts',
            ],
            testFiles: ['src/routes/api.test.ts'],
            invariantIds: ['inline-bootstrap-boundary'],
            platformFactIds: ['devvit-view-modes'],
          },
        ],
      },
      null,
      2,
    ),
  );

  const graph = await buildKnowledgeGraph(rootDir, {
    generatedAt: '2026-06-25T00:00:00.000Z',
  });

  assert.ok(
    graph.nodes.some((node) => node.id === 'invariant:inline-bootstrap-boundary'),
  );
  assert.ok(
    graph.nodes.some((node) => node.id === 'platform-fact:devvit-view-modes'),
  );
  assert.ok(
    graph.nodes.some((node) => node.id === 'review-pack:dashboard-launch'),
  );
  const devvitFile = graph.nodes.find((node) => node.id === 'devvit.json');
  assert.ok(devvitFile);
  assert.equal(devvitFile.kind, 'file');
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'coveredBy' &&
        edge.from === 'invariant:inline-bootstrap-boundary' &&
        edge.to === 'src/routes/api.test.ts',
    ),
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'guardsRoute' &&
        edge.from === 'invariant:inline-bootstrap-boundary' &&
        edge.to === 'route:GET /api/bootstrap',
    ),
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'includesInvariant' &&
        edge.from === 'review-pack:dashboard-launch' &&
        edge.to === 'invariant:inline-bootstrap-boundary',
    ),
  );

  const summary = buildKnowledgeGraphSummary(graph);
  assert.match(summary, /## Review Packs/);
  assert.match(summary, /review-pack:dashboard-launch/);
  assert.match(summary, /invariant:inline-bootstrap-boundary/);
  assert.match(summary, /platform-fact:devvit-view-modes/);
});

test('rejects annotations that reference missing graph nodes', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## Web UI Surfaces\n');
  await writeFixtureFile(rootDir, 'src/core/foo.ts', 'export const foo = 1;\n');
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [],
        invariants: [
          {
            id: 'missing-test-coverage',
            title: 'Missing Test Coverage',
            description: 'This invariant points at a missing test.',
            sourceFiles: ['src/core/foo.ts'],
            testFiles: ['src/core/foo.test.ts'],
          },
        ],
      },
      null,
      2,
    ),
  );

  await assert.rejects(
    () => buildKnowledgeGraph(rootDir),
    /invariant missing-test-coverage references missing graph node "src\/core\/foo.test.ts"/,
  );
});

test('rejects review packs that reference missing invariants', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## Web UI Surfaces\n');
  await writeFixtureFile(rootDir, 'src/core/foo.ts', 'export const foo = 1;\n');
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [],
        reviewPacks: [
          {
            id: 'missing-invariant-pack',
            title: 'Missing Invariant Pack',
            summary: 'This pack points at a missing invariant.',
            sourceFiles: ['src/core/foo.ts'],
            invariantIds: ['missing-invariant'],
          },
        ],
      },
      null,
      2,
    ),
  );

  await assert.rejects(
    () => buildKnowledgeGraph(rootDir),
    /review pack missing-invariant-pack references missing graph node "invariant:missing-invariant"/,
  );
});

test('check rejects stale generated summary text', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  const consoleError = console.error;
  console.error = () => {};
  t.after(async () => {
    console.error = consoleError;
    process.exitCode = undefined;
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## Web UI Surfaces\n');
  await writeFixtureFile(rootDir, 'src/core/foo.ts', 'export const foo = 1;\n');
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify({ version: 1, documents: [] }, null, 2),
  );

  const graph = await buildKnowledgeGraph(rootDir, {
    generatedAt: '2026-06-25T00:00:00.000Z',
  });
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/generated/graph.json',
    `${JSON.stringify(graph, null, 2)}\n`,
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/generated/summary.md',
    '# Stale Summary\n',
  );

  assert.equal(await main(['--check'], rootDir), false);
  assert.equal(process.exitCode, 1);
});

test('check rejects devvit trigger endpoints missing from the route graph', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  const consoleError = console.error;
  console.error = () => {};
  t.after(async () => {
    console.error = consoleError;
    process.exitCode = undefined;
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## UI And API\n');
  await writeFixtureFile(
    rootDir,
    'src/index.ts',
    [
      "import { Hono } from 'hono';",
      "import { triggers } from './routes/triggers';",
      '',
      'const app = new Hono();',
      "app.route('/internal/triggers', triggers);",
      '',
      'export default app;',
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'src/routes/triggers.ts',
    [
      "import { Hono } from 'hono';",
      '',
      'export const triggers = new Hono();',
      "triggers.post('/on-app-install', (c) => c.json({ status: 'success' }));",
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'devvit.json',
    JSON.stringify(
      {
        triggers: {
          onAppInstall: '/internal/triggers/on-app-install',
          onPostSubmit: '/internal/triggers/on-post-submit',
        },
      },
      null,
      2,
    ),
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [],
      },
      null,
      2,
    ),
  );

  const graph = await buildKnowledgeGraph(rootDir, {
    generatedAt: '2026-06-25T00:00:00.000Z',
  });
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/generated/graph.json',
    `${JSON.stringify(graph, null, 2)}\n`,
  );

  assert.equal(await main(['--check'], rootDir), false);
  assert.equal(process.exitCode, 1);
});

test('check rejects non-trigger manifest endpoints missing from the route graph', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  const consoleError = console.error;
  console.error = () => {};
  t.after(async () => {
    console.error = consoleError;
    process.exitCode = undefined;
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## UI And API\n');
  await writeFixtureFile(
    rootDir,
    'src/index.ts',
    [
      "import { Hono } from 'hono';",
      "import { menu } from './routes/menu';",
      '',
      'const app = new Hono();',
      "app.route('/internal/menu', menu);",
      '',
      'export default app;',
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'src/routes/menu.ts',
    [
      "import { Hono } from 'hono';",
      '',
      'export const menu = new Hono();',
      "menu.post('/known', (c) => c.json({ status: 'success' }));",
      '',
    ].join('\n'),
  );
  await writeFixtureFile(
    rootDir,
    'devvit.json',
    JSON.stringify(
      {
        menu: {
          items: [
            {
              label: 'Known',
              location: 'post',
              endpoint: '/internal/menu/known',
            },
            {
              label: 'Missing',
              location: 'post',
              endpoint: '/internal/menu/missing',
            },
          ],
        },
        forms: {
          knownForm: '/internal/menu/known',
          missingForm: '/internal/form/missing',
        },
        settings: {
          subreddit: {
            knownSetting: {
              type: 'number',
              validationEndpoint: '/internal/menu/known',
            },
            missingSetting: {
              type: 'number',
              validationEndpoint: '/internal/settings/missing',
            },
          },
        },
        scheduler: {
          actions: [
            {
              name: 'knownTask',
              endpoint: '/internal/menu/known',
            },
            {
              name: 'missingTask',
              endpoint: '/internal/scheduler/missing',
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [],
      },
      null,
      2,
    ),
  );

  const graph = await buildKnowledgeGraph(rootDir, {
    generatedAt: '2026-06-25T00:00:00.000Z',
  });
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/generated/graph.json',
    `${JSON.stringify(graph, null, 2)}\n`,
  );

  assert.equal(await main(['--check'], rootDir), false);
  assert.equal(process.exitCode, 1);
});

test('rejects annotations that reference missing MVP sections', async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'strikeledger-kg-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  await writeFixtureFile(rootDir, 'MVP.md', '# MVP\n\n## Current Section\n');
  await writeFixtureFile(rootDir, 'src/core/foo.ts', 'export const foo = 1;\n');
  await writeFixtureFile(
    rootDir,
    'docs/knowledge-graph/annotations.json',
    JSON.stringify(
      {
        version: 1,
        documents: [
          {
            path: 'docs/knowledge-graph/modules/foo.md',
            kind: 'module',
            title: 'Foo',
            mvpSections: ['Missing Section'],
            sourceFiles: ['src/core/foo.ts'],
            testFiles: [],
          },
        ],
      },
      null,
      2,
    ),
  );

  await assert.rejects(
    () => buildKnowledgeGraph(rootDir),
    /references missing MVP section "Missing Section"/,
  );
});

test('normalizes generatedAt while preserving structural differences', () => {
  const first = {
    version: 1,
    generatedAt: '2026-06-25T00:00:00.000Z',
    nodes: [{ id: 'src/core/foo.ts' }],
    edges: [],
  };
  const second = {
    version: 1,
    generatedAt: '2026-06-26T00:00:00.000Z',
    nodes: [{ id: 'src/core/foo.ts' }],
    edges: [],
  };
  const changed = {
    version: 1,
    generatedAt: '2026-06-26T00:00:00.000Z',
    nodes: [{ id: 'src/core/bar.ts' }],
    edges: [],
  };

  assert.deepEqual(
    normalizeForComparison(first),
    normalizeForComparison(second),
  );
  assert.notDeepEqual(
    normalizeForComparison(first),
    normalizeForComparison(changed),
  );
});
