import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildKnowledgeGraph,
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
