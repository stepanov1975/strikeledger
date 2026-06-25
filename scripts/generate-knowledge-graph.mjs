import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

const GRAPH_VERSION = 1;
const NORMALIZED_GENERATED_AT = '<normalized>';
const GRAPH_PATH = 'docs/knowledge-graph/generated/graph.json';
const ANNOTATIONS_PATH = 'docs/knowledge-graph/annotations.json';

const toGraphPath = (filePath) => filePath.split(path.sep).join('/');

const fromGraphPath = (rootDir, graphPath) =>
  path.join(rootDir, ...graphPath.split('/'));

const toRelativeGraphPath = (rootDir, filePath) =>
  toGraphPath(path.relative(rootDir, filePath));

const sortString = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const hasExportModifier = (node) =>
  Boolean(
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ),
  );

const collectBindingNames = (name, names) => {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingNames(element.name, names);
      }
    }
  }
};

const getLayer = (id) => {
  if (id === 'src/index.ts') {
    return 'entrypoint';
  }

  const parts = id.split('/');
  if (parts[0] !== 'src') {
    return 'unknown';
  }

  return parts[1] ?? 'source';
};

const sortById = (left, right) => sortString(left.id, right.id);

const sortEdge = (left, right) =>
  sortString(
    `${left.kind}:${left.from}:${left.to}`,
    `${right.kind}:${right.from}:${right.to}`,
  );

const listTypeScriptFiles = async (rootDir) => {
  const srcDir = path.join(rootDir, 'src');
  if (!existsSync(srcDir)) {
    return [];
  }

  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(entryPath);
      }
    }
  };

  await visit(srcDir);
  return files.sort(sortString);
};

const resolveLocalImport = (fromId, moduleSpecifier, moduleIds) => {
  if (!moduleSpecifier.startsWith('.')) {
    return null;
  }

  const fromDirectory = path.posix.dirname(fromId);
  const rawBase = path.posix.normalize(
    path.posix.join(fromDirectory, moduleSpecifier),
  );
  const base =
    rawBase.endsWith('.js') || rawBase.endsWith('.jsx')
      ? rawBase.replace(/\.jsx?$/, '')
      : rawBase;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    `${base}/index.ts`,
  ];

  return candidates.find((candidate) => moduleIds.has(candidate)) ?? null;
};

const extractExports = (sourceFile) => {
  const exportedNames = new Set();

  for (const statement of sourceFile.statements) {
    if (hasExportModifier(statement)) {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name
      ) {
        exportedNames.add(statement.name.text);
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          collectBindingNames(declaration.name, exportedNames);
        }
      }
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const specifier of statement.exportClause.elements) {
        exportedNames.add(specifier.name.text);
      }
    }
  }

  return [...exportedNames].sort(sortString);
};

const extractImports = (sourceFile, fromId, moduleIds) => {
  const imports = new Set();

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const resolved = resolveLocalImport(
        fromId,
        statement.moduleSpecifier.text,
        moduleIds,
      );
      if (resolved) {
        imports.add(resolved);
      }
    }
  }

  return [...imports].sort(sortString);
};

const getPairedTests = (id, moduleIds) => {
  if (id.endsWith('.test.ts')) {
    return [];
  }

  const extension = path.posix.extname(id);
  const base = id.slice(0, -extension.length);
  const testId = `${base}.test${extension}`;
  return moduleIds.has(testId) ? [testId] : [];
};

const readAnnotations = async (rootDir) => {
  const annotationPath = fromGraphPath(rootDir, ANNOTATIONS_PATH);
  if (!existsSync(annotationPath)) {
    return [];
  }

  const parsed = JSON.parse(await readFile(annotationPath, 'utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.documents)) {
    throw new Error(`${ANNOTATIONS_PATH} must contain version 1 documents`);
  }

  return parsed.documents.map((document) => ({
    path: document.path,
    kind: document.kind,
    title: document.title,
    mvpSections: document.mvpSections ?? [],
    sourceFiles: document.sourceFiles ?? [],
    testFiles: document.testFiles ?? [],
  }));
};

export async function buildKnowledgeGraph(rootDir, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const files = await listTypeScriptFiles(rootDir);
  const moduleIds = new Set(
    files.map((filePath) => toRelativeGraphPath(rootDir, filePath)),
  );
  const annotations = await readAnnotations(rootDir);
  const docsByFile = new Map();

  for (const document of annotations) {
    for (const file of [...document.sourceFiles, ...document.testFiles]) {
      const docs = docsByFile.get(file) ?? [];
      docs.push(document.path);
      docsByFile.set(file, docs);
    }
  }

  const nodes = [];
  const edges = [];

  for (const filePath of files) {
    const id = toRelativeGraphPath(rootDir, filePath);
    const sourceText = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      id,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = extractImports(sourceFile, id, moduleIds);
    const tests = getPairedTests(id, moduleIds);
    const curatedDocs = [...(docsByFile.get(id) ?? [])].sort(sortString);

    nodes.push({
      id,
      kind: 'module',
      layer: getLayer(id),
      exports: extractExports(sourceFile),
      imports,
      tests,
      curatedDocs,
    });

    for (const imported of imports) {
      edges.push({ from: id, to: imported, kind: 'imports' });
    }

    for (const test of tests) {
      edges.push({ from: id, to: test, kind: 'tests' });
    }
  }

  for (const document of annotations) {
    nodes.push({
      id: document.path,
      kind: 'document',
      documentKind: document.kind,
      title: document.title,
      mvpSections: document.mvpSections,
    });

    for (const file of [...document.sourceFiles, ...document.testFiles]) {
      edges.push({ from: document.path, to: file, kind: 'documents' });
    }

    if (document.kind === 'workflow') {
      for (const file of document.sourceFiles) {
        edges.push({ from: document.path, to: file, kind: 'workflowTouches' });
      }
    }
  }

  return {
    version: GRAPH_VERSION,
    generatedAt,
    nodes: nodes.sort(sortById),
    edges: edges.sort(sortEdge),
  };
}

export function normalizeForComparison(graph) {
  return {
    ...graph,
    generatedAt: NORMALIZED_GENERATED_AT,
  };
}

const readGeneratedGraph = async (rootDir) => {
  const graphPath = fromGraphPath(rootDir, GRAPH_PATH);
  return JSON.parse(await readFile(graphPath, 'utf8'));
};

const writeGeneratedGraph = async (rootDir, graph) => {
  const graphPath = fromGraphPath(rootDir, GRAPH_PATH);
  await mkdir(path.dirname(graphPath), { recursive: true });
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
};

const stableJson = (value) => JSON.stringify(value, null, 2);

export async function main(argv = process.argv.slice(2), rootDir = process.cwd()) {
  const checkOnly = argv.includes('--check');
  const graph = await buildKnowledgeGraph(rootDir);

  if (checkOnly) {
    let existing;
    try {
      existing = await readGeneratedGraph(rootDir);
    } catch {
      console.error(`${GRAPH_PATH} is missing or unreadable`);
      process.exitCode = 1;
      return false;
    }

    const current = stableJson(normalizeForComparison(existing));
    const expected = stableJson(normalizeForComparison(graph));
    if (current !== expected) {
      console.error(`${GRAPH_PATH} is stale. Run npm run generate-knowledge-graph.`);
      process.exitCode = 1;
      return false;
    }

    console.log(`${GRAPH_PATH} is current.`);
    return true;
  }

  await writeGeneratedGraph(rootDir, graph);
  console.log(`Wrote ${GRAPH_PATH}.`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
