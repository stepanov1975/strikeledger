import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';

const GRAPH_VERSION = 1;
const NORMALIZED_GENERATED_AT = '<normalized>';
const GRAPH_PATH = 'docs/knowledge-graph/generated/graph.json';
const SUMMARY_PATH = 'docs/knowledge-graph/generated/summary.md';
const ANNOTATIONS_PATH = 'docs/knowledge-graph/annotations.json';
const DEVVIT_PATH = 'devvit.json';
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all']);

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

const sortStrings = (values = []) => [...values].sort(sortString);

const routeTargetId = (moduleId, routerName) => `${moduleId}#${routerName}`;

const platformFactNodeId = (id) => `platform-fact:${id}`;

const invariantNodeId = (id) => `invariant:${id}`;

const reviewPackNodeId = (id) => `review-pack:${id}`;

const getStaticString = (node) => {
  if (!node) {
    return null;
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return null;
};

const unwrapExpression = (node) => {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) || ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
};

const extractStaticStringRows = (node) => {
  const expression = unwrapExpression(node);
  if (!expression || !ts.isArrayLiteralExpression(expression)) {
    return [];
  }

  const rows = [];
  for (const element of expression.elements) {
    const rowExpression = unwrapExpression(element);
    if (ts.isArrayLiteralExpression(rowExpression)) {
      const row = rowExpression.elements.map((item) =>
        getStaticString(unwrapExpression(item)),
      );
      if (row.every((value) => value !== null)) {
        rows.push(row);
      }
      continue;
    }

    const value = getStaticString(rowExpression);
    if (value !== null) {
      rows.push([value]);
    }
  }

  return rows;
};

const extractStaticStringCollections = (sourceFile) => {
  const collections = new Map();

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const rows = extractStaticStringRows(node.initializer);
      if (rows.length > 0) {
        collections.set(node.name.text, rows);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return collections;
};

const getStaticRoutePaths = (node, bindings) => {
  if (!node) {
    return [];
  }

  const literal = getStaticString(node);
  if (literal !== null) {
    return [literal];
  }

  if (ts.isIdentifier(node)) {
    return bindings.get(node.text) ?? [];
  }

  return [];
};

const joinRoutePaths = (prefix, routePath) => {
  const left = prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  const right = routePath === '/' ? '' : routePath.replace(/^\/+/, '');
  const combined = `${left}/${right}`.replace(/\/+/g, '/');
  return combined === '' ? '/' : combined;
};

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

const extractNamedImportTargets = (sourceFile, fromId, moduleIds) => {
  const targets = new Map();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const resolved = resolveLocalImport(
      fromId,
      statement.moduleSpecifier.text,
      moduleIds,
    );
    const namedBindings = statement.importClause?.namedBindings;
    if (!resolved || !namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const specifier of namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      targets.set(specifier.name.text, routeTargetId(resolved, importedName));
    }
  }

  return targets;
};

const extractRouteMetadata = (sourceFile, id, moduleIds) => {
  const importTargets = extractNamedImportTargets(sourceFile, id, moduleIds);
  const staticStringCollections = extractStaticStringCollections(sourceFile);
  const routes = [];
  const mounts = [];
  const resolveRouterTarget = (routerName) =>
    importTargets.get(routerName) ?? routeTargetId(id, routerName);

  const visit = (node, bindings = new Map()) => {
    if (ts.isForOfStatement(node)) {
      const rows = ts.isIdentifier(node.expression)
        ? staticStringCollections.get(node.expression.text)
        : null;
      const loopBindings = new Map(bindings);
      const declaration = ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations[0]
        : null;

      if (rows && declaration && ts.isArrayBindingPattern(declaration.name)) {
        declaration.name.elements.forEach((element, index) => {
          if (
            element &&
            ts.isBindingElement(element) &&
            ts.isIdentifier(element.name)
          ) {
            loopBindings.set(
              element.name.text,
              rows.map((row) => row[index]).filter((value) => value !== undefined),
            );
          }
        });
      }

      visit(node.statement, loopBindings);
      return;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const routerName = node.expression.expression.text;
      const methodName = node.expression.name.text;
      const routePaths = getStaticRoutePaths(node.arguments[0], bindings);

      if (ROUTE_METHODS.has(methodName)) {
        for (const routePath of routePaths) {
          routes.push({
            target: resolveRouterTarget(routerName),
            router: routerName,
            method: methodName.toUpperCase(),
            path: routePath,
            sourceFile: id,
          });
        }
      }

      if (
        routePaths.length > 0 &&
        methodName === 'route' &&
        ts.isIdentifier(node.arguments[1])
      ) {
        for (const routePath of routePaths) {
          mounts.push({
            owner: resolveRouterTarget(routerName),
            child: resolveRouterTarget(node.arguments[1].text),
            prefix: routePath,
          });
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, bindings));
  };

  visit(sourceFile);
  return { routes, mounts };
};

const buildRouteGraph = (routeDefinitions, routeMounts, docsByFile) => {
  const prefixesByRouter = new Map();
  const routeNodes = new Map();
  const routeEdges = [];
  const edgeIds = new Set();

  const addPrefix = (target, prefix) => {
    const prefixes = prefixesByRouter.get(target) ?? new Set();
    const sizeBefore = prefixes.size;
    prefixes.add(prefix);
    prefixesByRouter.set(target, prefixes);
    return prefixes.size !== sizeBefore;
  };

  addPrefix(routeTargetId('src/index.ts', 'app'), '');

  let changed = true;
  while (changed) {
    changed = false;
    for (const mount of routeMounts) {
      const ownerPrefixes = prefixesByRouter.get(mount.owner);
      if (!ownerPrefixes) {
        continue;
      }

      for (const ownerPrefix of ownerPrefixes) {
        changed =
          addPrefix(mount.child, joinRoutePaths(ownerPrefix, mount.prefix)) ||
          changed;
      }
    }
  }

  for (const route of routeDefinitions) {
    const prefixes = prefixesByRouter.get(route.target);
    if (!prefixes) {
      continue;
    }

    for (const prefix of prefixes) {
      const fullPath = joinRoutePaths(prefix, route.path);
      const id = `route:${route.method} ${fullPath}`;

      if (!routeNodes.has(id)) {
        routeNodes.set(id, {
          id,
          kind: 'route',
          method: route.method,
          path: fullPath,
          sourceFile: route.sourceFile,
          router: route.router,
          curatedDocs: [...(docsByFile.get(route.sourceFile) ?? [])].sort(
            sortString,
          ),
        });
      }

      const edgeId = `${route.sourceFile}->${id}:definesRoute`;
      if (!edgeIds.has(edgeId)) {
        routeEdges.push({ from: route.sourceFile, to: id, kind: 'definesRoute' });
        edgeIds.add(edgeId);
      }
    }
  }

  return { nodes: [...routeNodes.values()], edges: routeEdges };
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

const extractMarkdownHeadings = (text) => {
  const headings = new Set();

  for (const line of text.split(/\r?\n/)) {
    const match = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      headings.add(match[1].trim());
    }
  }

  return headings;
};

const readMvpSections = async (rootDir) => {
  const mvpPath = path.join(rootDir, 'MVP.md');
  if (!existsSync(mvpPath)) {
    return null;
  }

  return extractMarkdownHeadings(await readFile(mvpPath, 'utf8'));
};

const readAnnotations = async (rootDir) => {
  const annotationPath = fromGraphPath(rootDir, ANNOTATIONS_PATH);
  if (!existsSync(annotationPath)) {
    return {
      documents: [],
      platformFacts: [],
      invariants: [],
      reviewPacks: [],
    };
  }

  const parsed = JSON.parse(await readFile(annotationPath, 'utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.documents)) {
    throw new Error(`${ANNOTATIONS_PATH} must contain version 1 documents`);
  }

  const mvpSections = await readMvpSections(rootDir);
  const documents = parsed.documents.map((document) => {
    for (const section of document.mvpSections ?? []) {
      if (mvpSections && !mvpSections.has(section)) {
        throw new Error(
          `${ANNOTATIONS_PATH} document ${document.path} references missing MVP section "${section}"`,
        );
      }
    }

    return {
      path: document.path,
      kind: document.kind,
      title: document.title,
      mvpSections: sortStrings(document.mvpSections ?? []),
      sourceFiles: sortStrings(document.sourceFiles ?? []),
      testFiles: sortStrings(document.testFiles ?? []),
    };
  });

  return {
    documents,
    platformFacts: (parsed.platformFacts ?? []).map((fact) => ({
      id: fact.id,
      title: fact.title,
      source: fact.source,
      reviewedAt: fact.reviewedAt,
      summary: fact.summary,
      appliesTo: sortStrings(fact.appliesTo ?? []),
    })),
    invariants: (parsed.invariants ?? []).map((invariant) => ({
      id: invariant.id,
      title: invariant.title,
      description: invariant.description,
      sourceFiles: sortStrings(invariant.sourceFiles ?? []),
      testFiles: sortStrings(invariant.testFiles ?? []),
      documentPaths: sortStrings(invariant.documentPaths ?? []),
      routeIds: sortStrings(invariant.routeIds ?? []),
      platformFactIds: sortStrings(invariant.platformFactIds ?? []),
    })),
    reviewPacks: (parsed.reviewPacks ?? []).map((pack) => ({
      id: pack.id,
      title: pack.title,
      summary: pack.summary,
      documents: sortStrings(pack.documents ?? []),
      sourceFiles: sortStrings(pack.sourceFiles ?? []),
      testFiles: sortStrings(pack.testFiles ?? []),
      invariantIds: sortStrings(pack.invariantIds ?? []),
      platformFactIds: sortStrings(pack.platformFactIds ?? []),
    })),
  };
};

const isExplicitNodeReference = (reference) =>
  reference.startsWith('route:') ||
  reference.startsWith('invariant:') ||
  reference.startsWith('platform-fact:') ||
  reference.startsWith('review-pack:');

const collectAnnotatedFileReferences = (annotations) => {
  const references = new Set();
  const addFile = (reference) => {
    if (reference && !isExplicitNodeReference(reference)) {
      references.add(reference);
    }
  };

  for (const document of annotations.documents) {
    for (const file of [...document.sourceFiles, ...document.testFiles]) {
      addFile(file);
    }
  }

  for (const fact of annotations.platformFacts) {
    for (const reference of fact.appliesTo) {
      addFile(reference);
    }
  }

  for (const invariant of annotations.invariants) {
    for (const file of [...invariant.sourceFiles, ...invariant.testFiles]) {
      addFile(file);
    }
  }

  for (const pack of annotations.reviewPacks) {
    for (const file of [...pack.sourceFiles, ...pack.testFiles]) {
      addFile(file);
    }
  }

  return references;
};

const addAnnotatedFileNodes = (rootDir, annotations, nodes) => {
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const reference of collectAnnotatedFileReferences(annotations)) {
    if (nodeIds.has(reference)) {
      continue;
    }

    if (!existsSync(fromGraphPath(rootDir, reference))) {
      continue;
    }

    nodes.push({
      id: reference,
      kind: 'file',
      layer: getLayer(reference),
    });
    nodeIds.add(reference);
  }
};

const requireGraphNodes = (owner, references, nodeIds) => {
  for (const reference of references) {
    if (!nodeIds.has(reference)) {
      throw new Error(
        `${ANNOTATIONS_PATH} ${owner} references missing graph node "${reference}"`,
      );
    }
  }
};

const validateAnnotationReferences = (annotations, nodes) => {
  const nodeIds = new Set();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      throw new Error(`${ANNOTATIONS_PATH} creates duplicate graph node "${node.id}"`);
    }
    nodeIds.add(node.id);
  }

  for (const document of annotations.documents) {
    requireGraphNodes(
      `document ${document.path}`,
      [...document.sourceFiles, ...document.testFiles],
      nodeIds,
    );
  }

  for (const fact of annotations.platformFacts) {
    requireGraphNodes(`platform fact ${fact.id}`, fact.appliesTo, nodeIds);
  }

  for (const invariant of annotations.invariants) {
    requireGraphNodes(
      `invariant ${invariant.id}`,
      [
        ...invariant.sourceFiles,
        ...invariant.testFiles,
        ...invariant.documentPaths,
        ...invariant.routeIds,
        ...invariant.platformFactIds.map(platformFactNodeId),
      ],
      nodeIds,
    );
  }

  for (const pack of annotations.reviewPacks) {
    requireGraphNodes(
      `review pack ${pack.id}`,
      [
        ...pack.documents,
        ...pack.sourceFiles,
        ...pack.testFiles,
        ...pack.invariantIds.map(invariantNodeId),
        ...pack.platformFactIds.map(platformFactNodeId),
      ],
      nodeIds,
    );
  }
};

export async function buildKnowledgeGraph(rootDir, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const files = await listTypeScriptFiles(rootDir);
  const moduleIds = new Set(
    files.map((filePath) => toRelativeGraphPath(rootDir, filePath)),
  );
  const annotations = await readAnnotations(rootDir);
  const docsByFile = new Map();

  for (const document of annotations.documents) {
    for (const file of [...document.sourceFiles, ...document.testFiles]) {
      const docs = docsByFile.get(file) ?? [];
      docs.push(document.path);
      docsByFile.set(file, docs);
    }
  }

  const nodes = [];
  const edges = [];
  const routeDefinitions = [];
  const routeMounts = [];

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
    const routeMetadata = extractRouteMetadata(sourceFile, id, moduleIds);
    routeDefinitions.push(...routeMetadata.routes);
    routeMounts.push(...routeMetadata.mounts);

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

  for (const document of annotations.documents) {
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

  addAnnotatedFileNodes(rootDir, annotations, nodes);

  const routeGraph = buildRouteGraph(routeDefinitions, routeMounts, docsByFile);
  nodes.push(...routeGraph.nodes);
  edges.push(...routeGraph.edges);

  for (const fact of annotations.platformFacts) {
    const factId = platformFactNodeId(fact.id);
    nodes.push({
      id: factId,
      kind: 'platformFact',
      title: fact.title,
      source: fact.source,
      reviewedAt: fact.reviewedAt,
      summary: fact.summary,
      appliesTo: fact.appliesTo,
    });

    for (const target of fact.appliesTo) {
      edges.push({ from: factId, to: target, kind: 'appliesTo' });
    }
  }

  for (const invariant of annotations.invariants) {
    const invariantId = invariantNodeId(invariant.id);
    const platformFacts = invariant.platformFactIds.map(platformFactNodeId);
    nodes.push({
      id: invariantId,
      kind: 'invariant',
      title: invariant.title,
      description: invariant.description,
      sourceFiles: invariant.sourceFiles,
      testFiles: invariant.testFiles,
      documentPaths: invariant.documentPaths,
      routeIds: invariant.routeIds,
      platformFacts,
    });

    for (const file of invariant.sourceFiles) {
      edges.push({ from: invariantId, to: file, kind: 'guards' });
    }
    for (const testFile of invariant.testFiles) {
      edges.push({ from: invariantId, to: testFile, kind: 'coveredBy' });
    }
    for (const documentPath of invariant.documentPaths) {
      edges.push({ from: invariantId, to: documentPath, kind: 'documentedBy' });
    }
    for (const routeId of invariant.routeIds) {
      edges.push({ from: invariantId, to: routeId, kind: 'guardsRoute' });
    }
    for (const factId of platformFacts) {
      edges.push({ from: invariantId, to: factId, kind: 'constrainedBy' });
    }
  }

  for (const pack of annotations.reviewPacks) {
    const packId = reviewPackNodeId(pack.id);
    const invariants = pack.invariantIds.map(invariantNodeId);
    const platformFacts = pack.platformFactIds.map(platformFactNodeId);
    nodes.push({
      id: packId,
      kind: 'reviewPack',
      title: pack.title,
      summary: pack.summary,
      documents: pack.documents,
      sourceFiles: pack.sourceFiles,
      testFiles: pack.testFiles,
      invariants,
      platformFacts,
    });

    for (const documentPath of pack.documents) {
      edges.push({ from: packId, to: documentPath, kind: 'includesDocument' });
    }
    for (const file of pack.sourceFiles) {
      edges.push({ from: packId, to: file, kind: 'includesSource' });
    }
    for (const testFile of pack.testFiles) {
      edges.push({ from: packId, to: testFile, kind: 'includesTest' });
    }
    for (const invariantId of invariants) {
      edges.push({ from: packId, to: invariantId, kind: 'includesInvariant' });
    }
    for (const factId of platformFacts) {
      edges.push({ from: packId, to: factId, kind: 'includesPlatformFact' });
    }
  }

  validateAnnotationReferences(annotations, nodes);

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

const readGeneratedSummary = async (rootDir) => {
  const summaryPath = fromGraphPath(rootDir, SUMMARY_PATH);
  return readFile(summaryPath, 'utf8');
};

const addManifestEndpoint = (endpoints, kind, name, path) => {
  if (typeof path === 'string') {
    endpoints.push({ kind, name, path });
  }
};

const collectSettingsValidationEndpoints = (node, endpoints, pathParts = []) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return;
  }

  addManifestEndpoint(
    endpoints,
    'settings',
    pathParts.join('.') || 'settings',
    node.validationEndpoint,
  );

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'validationEndpoint') {
      collectSettingsValidationEndpoints(value, endpoints, [...pathParts, key]);
    }
  }
};

const collectSchedulerEndpoints = (scheduler, endpoints) => {
  if (!scheduler || typeof scheduler !== 'object' || Array.isArray(scheduler)) {
    return;
  }

  const collectTaskMap = (tasks) => {
    if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
      return;
    }

    for (const [name, task] of Object.entries(tasks)) {
      if (typeof task === 'string') {
        addManifestEndpoint(endpoints, 'scheduler', name, task);
      } else if (task && typeof task === 'object' && !Array.isArray(task)) {
        addManifestEndpoint(endpoints, 'scheduler', name, task.endpoint);
      }
    }
  };

  collectTaskMap(scheduler.tasks);
  if (Array.isArray(scheduler.actions)) {
    for (const action of scheduler.actions) {
      if (action && typeof action === 'object') {
        addManifestEndpoint(
          endpoints,
          'scheduler',
          String(action.name ?? 'scheduler action'),
          action.endpoint,
        );
      }
    }
  }
};

const readDevvitManifestEndpoints = async (rootDir) => {
  const manifestPath = fromGraphPath(rootDir, DEVVIT_PATH);
  if (!existsSync(manifestPath)) {
    return [];
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [];
  }

  const endpoints = [];
  if (manifest.triggers && typeof manifest.triggers === 'object') {
    for (const [name, path] of Object.entries(manifest.triggers)) {
      addManifestEndpoint(endpoints, 'trigger', name, path);
    }
  }

  if (Array.isArray(manifest.menu?.items)) {
    for (const item of manifest.menu.items) {
      addManifestEndpoint(
        endpoints,
        'menu',
        String(item?.label ?? item?.description ?? 'menu item'),
        item?.endpoint,
      );
    }
  }

  if (manifest.forms && typeof manifest.forms === 'object') {
    for (const [name, path] of Object.entries(manifest.forms)) {
      addManifestEndpoint(endpoints, 'form', name, path);
    }
  }

  collectSettingsValidationEndpoints(manifest.settings, endpoints);
  collectSchedulerEndpoints(manifest.scheduler, endpoints);

  return endpoints.sort((left, right) =>
    sortString(
      `${left.kind}:${left.name}:${left.path}`,
      `${right.kind}:${right.name}:${right.path}`,
    ),
  );
};

export const getMissingDevvitManifestRoutes = async (rootDir, graph) => {
  const routeIds = new Set(
    graph.nodes
      .filter((node) => node.kind === 'route' && node.method === 'POST')
      .map((node) => node.id),
  );

  return (await readDevvitManifestEndpoints(rootDir)).filter(
    (endpoint) => !routeIds.has(`route:POST ${endpoint.path}`),
  );
};

const getEdgeTargets = (graph, from, kind) =>
  graph.edges
    .filter((edge) => edge.from === from && edge.kind === kind)
    .map((edge) => edge.to)
    .sort(sortString);

const findNode = (graph, id) => graph.nodes.find((node) => node.id === id);

const formatReference = (value) => `\`${value}\``;

const pushOptionalList = (lines, label, values) => {
  if (values.length > 0) {
    lines.push(`- ${label}: ${values.map(formatReference).join(', ')}`);
  }
};

export function buildKnowledgeGraphSummary(graph) {
  const counts = new Map();
  for (const node of graph.nodes) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }

  const lines = [
    '# Knowledge Graph Summary',
    '',
    'Generated from source analysis and docs/knowledge-graph/annotations.json.',
    '',
    '## Counts',
    '',
    ...[...counts.entries()]
      .sort(([left], [right]) => sortString(left, right))
      .map(([kind, count]) => `- ${kind}: ${count}`),
    '',
  ];

  const reviewPacks = graph.nodes
    .filter((node) => node.kind === 'reviewPack')
    .sort(sortById);
  if (reviewPacks.length > 0) {
    lines.push('## Review Packs', '');
    for (const pack of reviewPacks) {
      lines.push(`### ${pack.title}`, '');
      lines.push(`- Node: ${formatReference(pack.id)}`);
      if (pack.summary) {
        lines.push(`- Summary: ${pack.summary}`);
      }
      pushOptionalList(lines, 'Documents', getEdgeTargets(graph, pack.id, 'includesDocument'));
      pushOptionalList(lines, 'Sources', getEdgeTargets(graph, pack.id, 'includesSource'));
      pushOptionalList(lines, 'Tests', getEdgeTargets(graph, pack.id, 'includesTest'));
      pushOptionalList(
        lines,
        'Invariants',
        getEdgeTargets(graph, pack.id, 'includesInvariant'),
      );
      pushOptionalList(
        lines,
        'Platform facts',
        getEdgeTargets(graph, pack.id, 'includesPlatformFact'),
      );
      lines.push('');
    }
  }

  const invariants = graph.nodes
    .filter((node) => node.kind === 'invariant')
    .sort(sortById);
  if (invariants.length > 0) {
    lines.push('## Invariants', '');
    for (const invariant of invariants) {
      lines.push(`### ${invariant.title}`, '');
      lines.push(`- Node: ${formatReference(invariant.id)}`);
      if (invariant.description) {
        lines.push(`- Description: ${invariant.description}`);
      }
      pushOptionalList(lines, 'Sources', getEdgeTargets(graph, invariant.id, 'guards'));
      pushOptionalList(lines, 'Tests', getEdgeTargets(graph, invariant.id, 'coveredBy'));
      pushOptionalList(lines, 'Docs', getEdgeTargets(graph, invariant.id, 'documentedBy'));
      pushOptionalList(lines, 'Routes', getEdgeTargets(graph, invariant.id, 'guardsRoute'));
      pushOptionalList(
        lines,
        'Platform facts',
        getEdgeTargets(graph, invariant.id, 'constrainedBy'),
      );
      lines.push('');
    }
  }

  const platformFacts = graph.nodes
    .filter((node) => node.kind === 'platformFact')
    .sort(sortById);
  if (platformFacts.length > 0) {
    lines.push('## Platform Facts', '');
    for (const fact of platformFacts) {
      lines.push(`### ${fact.title}`, '');
      lines.push(`- Node: ${formatReference(fact.id)}`);
      lines.push(`- Source: ${fact.source}`);
      lines.push(`- Reviewed: ${fact.reviewedAt}`);
      if (fact.summary) {
        lines.push(`- Summary: ${fact.summary}`);
      }
      pushOptionalList(lines, 'Applies to', getEdgeTargets(graph, fact.id, 'appliesTo'));
      lines.push('');
    }
  }

  const routeNodes = graph.nodes
    .filter((node) => node.kind === 'route')
    .sort(sortById);
  if (routeNodes.length > 0) {
    lines.push('## Routes', '');
    for (const route of routeNodes) {
      const node = findNode(graph, route.id);
      lines.push(`- ${formatReference(route.id)} (${formatReference(node.sourceFile)})`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

const writeGeneratedArtifacts = async (rootDir, graph) => {
  const graphPath = fromGraphPath(rootDir, GRAPH_PATH);
  const summaryPath = fromGraphPath(rootDir, SUMMARY_PATH);
  await mkdir(path.dirname(graphPath), { recursive: true });
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  await writeFile(summaryPath, buildKnowledgeGraphSummary(graph));
};

const stableJson = (value) => JSON.stringify(value, null, 2);

export async function main(argv = process.argv.slice(2), rootDir = process.cwd()) {
  const checkOnly = argv.includes('--check');
  const graph = await buildKnowledgeGraph(rootDir);
  const missingDevvitManifestRoutes = await getMissingDevvitManifestRoutes(
    rootDir,
    graph,
  );

  if (missingDevvitManifestRoutes.length > 0) {
    console.error(
      [
        `${DEVVIT_PATH} endpoints are missing from generated route nodes:`,
        ...missingDevvitManifestRoutes.map(
          (endpoint) => `- ${endpoint.kind} ${endpoint.name}: ${endpoint.path}`,
        ),
      ].join('\n'),
    );
    process.exitCode = 1;
    return false;
  }

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

    let existingSummary;
    try {
      existingSummary = await readGeneratedSummary(rootDir);
    } catch {
      console.error(`${SUMMARY_PATH} is missing or unreadable`);
      process.exitCode = 1;
      return false;
    }

    if (existingSummary !== buildKnowledgeGraphSummary(graph)) {
      console.error(`${SUMMARY_PATH} is stale. Run npm run generate-knowledge-graph.`);
      process.exitCode = 1;
      return false;
    }

    console.log(`${GRAPH_PATH} and ${SUMMARY_PATH} are current.`);
    return true;
  }

  await writeGeneratedArtifacts(rootDir, graph);
  console.log(`Wrote ${GRAPH_PATH} and ${SUMMARY_PATH}.`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
