import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const configPath = path.join(repoRoot, 'src', 'core', 'config.ts');
const templatesPath = path.join(repoRoot, 'src', 'core', 'templates.ts');
const devvitPath = path.join(repoRoot, 'devvit.json');
const checkOnly = process.argv.includes('--check');

const parseSource = (filePath) =>
  ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

const isExported = (node) =>
  Boolean(
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );

const findExportedConst = (sourceFile, name) => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !isExported(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer;
      }
    }
  }

  throw new Error(`Missing exported const ${name}.`);
};

const unwrapExpression = (node) => {
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return unwrapExpression(node.expression);
  }

  return node;
};

const assertStringLiteral = (node, name) => {
  node = unwrapExpression(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  throw new Error(`${name} must be a string literal.`);
};

const assertObjectLiteral = (node, name) => {
  node = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(node)) {
    return node;
  }

  throw new Error(`${name} must be an object literal.`);
};

const assertArrayLiteral = (node, name) => {
  node = unwrapExpression(node);
  if (ts.isArrayLiteralExpression(node)) {
    return node;
  }

  throw new Error(`${name} must be an array literal.`);
};

const getProperty = (objectLiteral, name) => {
  for (const property of objectLiteral.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === name) ||
        (ts.isStringLiteral(property.name) && property.name.text === name))
    ) {
      return property.initializer;
    }
  }

  throw new Error(`Missing property ${name}.`);
};

const getNumberProperty = (objectLiteral, name) => {
  const initializer = getProperty(objectLiteral, name);
  if (ts.isNumericLiteral(initializer)) {
    return Number(initializer.text);
  }

  throw new Error(`${name} must be a number literal.`);
};

const getBooleanProperty = (objectLiteral, name) => {
  const initializer = getProperty(objectLiteral, name);
  if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }

  throw new Error(`${name} must be a boolean literal.`);
};

const getStringConst = (sourceFile, name) =>
  assertStringLiteral(findExportedConst(sourceFile, name), name);

const getPlaceholderList = (sourceFile, name) =>
  assertArrayLiteral(findExportedConst(sourceFile, name), name).elements.map(
    (element) => assertStringLiteral(element, name)
  );

const placeholderHelpText = (placeholders) =>
  `Allowed placeholders: ${placeholders
    .map((placeholder) => `{${placeholder}}`)
    .join(', ')}.`;

const buildSubredditSettings = () => {
  const configSource = parseSource(configPath);
  const templatesSource = parseSource(templatesPath);
  const defaultConfig = assertObjectLiteral(
    findExportedConst(configSource, 'DEFAULT_CONFIG'),
    'DEFAULT_CONFIG'
  );
  const actionPoints = assertObjectLiteral(
    getProperty(defaultConfig, 'actionPoints'),
    'DEFAULT_CONFIG.actionPoints'
  );
  const stickyAppComments = assertObjectLiteral(
    getProperty(defaultConfig, 'stickyAppComments'),
    'DEFAULT_CONFIG.stickyAppComments'
  );
  const publicPlaceholders = getPlaceholderList(
    templatesSource,
    'PUBLIC_PLACEHOLDERS'
  );
  const privatePlaceholders = getPlaceholderList(
    templatesSource,
    'PRIVATE_PLACEHOLDERS'
  );

  return {
    warnPoints: {
      type: 'number',
      label: 'Warn point value',
      helpText: 'Points added by StrikeLedger: Warn.',
      defaultValue: getNumberProperty(actionPoints, 'warn'),
      validationEndpoint: '/internal/settings/validate-points',
    },
    warnRemovePoints: {
      type: 'number',
      label: 'Warn and remove point value',
      helpText: 'Points added by StrikeLedger: Warn and remove.',
      defaultValue: getNumberProperty(actionPoints, 'warn_remove'),
      validationEndpoint: '/internal/settings/validate-points',
    },
    warnNsfwPoints: {
      type: 'number',
      label: 'Warn and mark NSFW point value',
      helpText: 'Points added by StrikeLedger: Warn and mark NSFW.',
      defaultValue: getNumberProperty(actionPoints, 'warn_nsfw'),
      validationEndpoint: '/internal/settings/validate-points',
    },
    decayAmount: {
      type: 'number',
      label: 'Decay amount',
      helpText: 'Active warning points removed each decay interval.',
      defaultValue: getNumberProperty(defaultConfig, 'decayAmount'),
      validationEndpoint: '/internal/settings/validate-decay-amount',
    },
    decayIntervalDays: {
      type: 'number',
      label: 'Decay interval days',
      helpText: 'Number of days per decay interval.',
      defaultValue: getNumberProperty(defaultConfig, 'decayIntervalDays'),
      validationEndpoint: '/internal/settings/validate-days',
    },
    defaultPublicCommentTemplate: {
      type: 'paragraph',
      label: 'Default public comment template',
      helpText: placeholderHelpText(publicPlaceholders),
      defaultValue: getStringConst(configSource, 'DEFAULT_PUBLIC_COMMENT_TEMPLATE'),
      validationEndpoint: '/internal/settings/validate-public-template',
    },
    defaultPrivateUserNoticeTemplate: {
      type: 'paragraph',
      label: 'Default private user notice template',
      helpText: placeholderHelpText(privatePlaceholders),
      defaultValue: getStringConst(
        configSource,
        'DEFAULT_PRIVATE_USER_NOTICE_TEMPLATE'
      ),
      validationEndpoint: '/internal/settings/validate-private-template',
    },
    defaultZeroPointPrivateUserNoticeTemplate: {
      type: 'paragraph',
      label: 'Zero-point private user notice template',
      helpText: placeholderHelpText(privatePlaceholders),
      defaultValue: getStringConst(
        configSource,
        'DEFAULT_ZERO_POINT_PRIVATE_USER_NOTICE_TEMPLATE'
      ),
      validationEndpoint: '/internal/settings/validate-private-template',
    },
    defaultNativeModNoteTemplate: {
      type: 'paragraph',
      label: 'Default native mod note template',
      helpText: placeholderHelpText(privatePlaceholders),
      defaultValue: getStringConst(configSource, 'DEFAULT_NATIVE_MOD_NOTE_TEMPLATE'),
      validationEndpoint: '/internal/settings/validate-private-template',
    },
    defaultZeroPointNativeModNoteTemplate: {
      type: 'paragraph',
      label: 'Zero-point native mod note template',
      helpText: placeholderHelpText(privatePlaceholders),
      defaultValue: getStringConst(
        configSource,
        'DEFAULT_ZERO_POINT_NATIVE_MOD_NOTE_TEMPLATE'
      ),
      validationEndpoint: '/internal/settings/validate-private-template',
    },
    userNoticesEnabled: {
      type: 'boolean',
      label: 'Send private user notices',
      helpText:
        'Send a private message to the affected user when a warning is recorded.',
      defaultValue: getBooleanProperty(defaultConfig, 'userNoticesEnabled'),
    },
    nativeModNotesEnabled: {
      type: 'boolean',
      label: 'Write native mod notes',
      helpText:
        'Write a Reddit mod note on the affected user when a warning is recorded.',
      defaultValue: getBooleanProperty(defaultConfig, 'nativeModNotesEnabled'),
    },
    reversalNativeModNotesEnabled: {
      type: 'boolean',
      label: 'Write reversal mod notes',
      helpText: 'Write a Reddit mod note when a moderator reverses a warning.',
      defaultValue: getBooleanProperty(
        defaultConfig,
        'reversalNativeModNotesEnabled'
      ),
    },
    distinguishAppComments: {
      type: 'boolean',
      label: 'Distinguish app comments',
      helpText: 'Mark app comments as moderator comments when Reddit allows it.',
      defaultValue: getBooleanProperty(defaultConfig, 'distinguishAppComments'),
    },
    lockAppComments: {
      type: 'boolean',
      label: 'Lock app comments',
      helpText: 'Prevent replies to public comments posted by the app.',
      defaultValue: getBooleanProperty(defaultConfig, 'lockAppComments'),
    },
    stickyCommentsWarn: {
      type: 'boolean',
      label: 'Sticky comments for Warn',
      helpText: 'Pin public app comments for Warn actions when the app posts one.',
      defaultValue: getBooleanProperty(stickyAppComments, 'warn'),
    },
    stickyCommentsWarnRemove: {
      type: 'boolean',
      label: 'Sticky comments for Warn and remove',
      helpText:
        'Pin public app comments for Warn and remove actions when the app posts one.',
      defaultValue: getBooleanProperty(stickyAppComments, 'warn_remove'),
    },
    stickyCommentsWarnNsfw: {
      type: 'boolean',
      label: 'Sticky comments for Warn and mark NSFW',
      helpText:
        'Pin public app comments for Warn and mark NSFW actions when the app posts one.',
      defaultValue: getBooleanProperty(stickyAppComments, 'warn_nsfw'),
    },
  };
};

const devvitConfig = JSON.parse(readFileSync(devvitPath, 'utf8'));
const generatedSubredditSettings = buildSubredditSettings();
const currentSubredditSettings = devvitConfig.settings?.subreddit ?? {};

if (
  checkOnly &&
  JSON.stringify(currentSubredditSettings) !==
    JSON.stringify(generatedSubredditSettings)
) {
  console.error(
    'devvit.json settings.subreddit is out of sync. Run npm run sync-devvit-settings.'
  );
  process.exit(1);
}

if (!checkOnly) {
  devvitConfig.settings = {
    ...(devvitConfig.settings ?? {}),
    subreddit: generatedSubredditSettings,
  };
  writeFileSync(devvitPath, `${JSON.stringify(devvitConfig, null, 2)}\n`);
}
