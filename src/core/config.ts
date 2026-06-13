import {
  SCHEMA_VERSION,
  STRIKE_ACTIONS,
  type RuleConfig,
  type StrikeAction,
  type StrikeLedgerConfig,
} from './domain';
import {
  PRIVATE_PLACEHOLDERS,
  PUBLIC_PLACEHOLDERS,
  validateTemplatePlaceholders,
} from './templates';

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export const DEFAULT_PUBLIC_COMMENT_TEMPLATE =
  'Moderator notice: this content violates {ruleLabel}. This action has been recorded in your subreddit warning history.';

export const DEFAULT_PRIVATE_USER_NOTICE_TEMPLATE =
  'Your content in r/{subredditName} violated {ruleLabel}. This action added {pointsAdded} warning point(s). Your current active warning total is {activeTotal}. Please review the community rules before participating again.';

export const DEFAULT_ZERO_POINT_PRIVATE_USER_NOTICE_TEMPLATE =
  'Your content in r/{subredditName} violated {ruleLabel}. This action was recorded as a warning without adding warning points. Your current active warning total is {activeTotal}. Please review the community rules before participating again.';

export const DEFAULT_NATIVE_MOD_NOTE_TEMPLATE =
  'StrikeLedger: {action} for {ruleLabel}. Points: {pointsAdded}. Active total: {activeTotal}. Target: {targetPermalink}';

export const DEFAULT_ZERO_POINT_NATIVE_MOD_NOTE_TEMPLATE =
  'StrikeLedger: {action} for {ruleLabel}. No points added. Active total: {activeTotal}. Target: {targetPermalink}';

export const DEFAULT_RULE: RuleConfig = {
  id: 'rule-general',
  label: 'Community rule violation',
  enabled: true,
};

export const DEFAULT_CONFIG: StrikeLedgerConfig = {
  schemaVersion: SCHEMA_VERSION,
  revision: 1,
  rules: [DEFAULT_RULE],
  actionPoints: {
    warn: 1,
    warn_remove: 3,
    warn_nsfw: 1,
  },
  decayAmount: 1,
  decayIntervalDays: 30,
  defaultPublicCommentTemplate: DEFAULT_PUBLIC_COMMENT_TEMPLATE,
  defaultPrivateUserNoticeTemplate: DEFAULT_PRIVATE_USER_NOTICE_TEMPLATE,
  defaultZeroPointPrivateUserNoticeTemplate:
    DEFAULT_ZERO_POINT_PRIVATE_USER_NOTICE_TEMPLATE,
  defaultNativeModNoteTemplate: DEFAULT_NATIVE_MOD_NOTE_TEMPLATE,
  defaultZeroPointNativeModNoteTemplate:
    DEFAULT_ZERO_POINT_NATIVE_MOD_NOTE_TEMPLATE,
  userNoticesEnabled: true,
  distinguishAppComments: true,
  stickyAppComments: {
    warn: false,
    warn_remove: false,
    warn_nsfw: false,
  },
  lockAppComments: true,
  nativeModNotesEnabled: true,
  reversalNativeModNotesEnabled: true,
};

const RULE_ID_PATTERN = /^[a-z0-9-]+$/;
const MAX_LABEL_LENGTH = 120;
const MAX_TEMPLATE_LENGTH = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isIntegerInRange = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

const requireTemplate = (
  issues: ConfigValidationIssue[],
  path: string,
  template: string,
  allowedPlaceholders: readonly string[]
) => {
  if (!template.trim()) {
    issues.push({ path, message: 'Template is required.' });
    return;
  }

  validateOptionalTemplate(issues, path, template, allowedPlaceholders);
};

const validateOptionalTemplate = (
  issues: ConfigValidationIssue[],
  path: string,
  template: string | undefined,
  allowedPlaceholders: readonly string[]
) => {
  if (template === undefined) {
    return;
  }

  if (template.length > MAX_TEMPLATE_LENGTH) {
    issues.push({
      path,
      message: `Template must be ${MAX_TEMPLATE_LENGTH} characters or fewer.`,
    });
  }

  issues.push(...validateTemplatePlaceholders(path, template, allowedPlaceholders));
};

const validateActionPoints = (
  issues: ConfigValidationIssue[],
  path: string,
  actionPoints: Record<string, unknown>
) => {
  for (const action of STRIKE_ACTIONS) {
    const value = actionPoints[action];
    if (typeof value !== 'number' || !isIntegerInRange(value, 0, 100)) {
      issues.push({
        path: `${path}.${action}`,
        message: 'Point value must be an integer from 0 to 100.',
      });
    }
  }
};

const validateRule = (
  issues: ConfigValidationIssue[],
  rule: unknown,
  index: number
) => {
  const path = `rules.${index}`;

  if (!isRecord(rule)) {
    issues.push({ path, message: 'Rule must be an object.' });
    return;
  }

  if (typeof rule.id !== 'string' || !RULE_ID_PATTERN.test(rule.id)) {
    issues.push({
      path: `${path}.id`,
      message: 'Rule ID must contain only lowercase letters, numbers, and hyphens.',
    });
  }

  if (
    typeof rule.label !== 'string' ||
    !rule.label.trim() ||
    rule.label.length > MAX_LABEL_LENGTH
  ) {
    issues.push({
      path: `${path}.label`,
      message: `Rule label is required and must be ${MAX_LABEL_LENGTH} characters or fewer.`,
    });
  }

  if (typeof rule.enabled !== 'boolean') {
    issues.push({
      path: `${path}.enabled`,
      message: 'Rule enabled must be true or false.',
    });
  }

  if (
    rule.publicTemplate !== undefined &&
    typeof rule.publicTemplate !== 'string'
  ) {
    issues.push({
      path: `${path}.publicTemplate`,
      message: 'Template must be text.',
    });
  } else {
    validateOptionalTemplate(
      issues,
      `${path}.publicTemplate`,
      rule.publicTemplate,
      PUBLIC_PLACEHOLDERS
    );
  }

  if (
    rule.internalNoteTemplate !== undefined &&
    typeof rule.internalNoteTemplate !== 'string'
  ) {
    issues.push({
      path: `${path}.internalNoteTemplate`,
      message: 'Template must be text.',
    });
  } else {
    validateOptionalTemplate(
      issues,
      `${path}.internalNoteTemplate`,
      rule.internalNoteTemplate,
      PRIVATE_PLACEHOLDERS
    );
  }

  if (rule.pointOverrides !== undefined && !isRecord(rule.pointOverrides)) {
    issues.push({
      path: `${path}.pointOverrides`,
      message: 'Point overrides must be an object.',
    });
  } else if (rule.pointOverrides) {
    for (const action of STRIKE_ACTIONS) {
      const value = rule.pointOverrides[action];
      if (
        value !== undefined &&
        (typeof value !== 'number' || !isIntegerInRange(value, 0, 100))
      ) {
        issues.push({
          path: `${path}.pointOverrides.${action}`,
          message: 'Point override must be an integer from 0 to 100.',
        });
      }
    }
  }
};

export const validateConfig = (
  config: unknown
): ConfigValidationIssue[] => {
  const issues: ConfigValidationIssue[] = [];

  if (!isRecord(config)) {
    return [{ path: 'config', message: 'Config must be an object.' }];
  }

  if (config.schemaVersion !== SCHEMA_VERSION) {
    issues.push({
      path: 'schemaVersion',
      message: `Unsupported config schema version ${config.schemaVersion}.`,
    });
  }

  if (
    typeof config.revision !== 'number' ||
    !Number.isInteger(config.revision) ||
    config.revision < 1
  ) {
    issues.push({
      path: 'revision',
      message: 'Revision must be an integer greater than or equal to 1.',
    });
  }

  if (!Array.isArray(config.rules)) {
    issues.push({
      path: 'rules',
      message: 'Rules must be an array.',
    });
  } else {
    if (config.rules.length === 0) {
      issues.push({ path: 'rules', message: 'At least one rule is required.' });
    }

    if (
      !config.rules.some((rule) => isRecord(rule) && rule.enabled === true)
    ) {
      issues.push({
        path: 'rules',
        message: 'At least one enabled rule is required.',
      });
    }

    const ruleIds = new Set<string>();
    config.rules.forEach((rule, index) => validateRule(issues, rule, index));
    config.rules.forEach((rule, index) => {
      if (!isRecord(rule) || typeof rule.id !== 'string') {
        return;
      }

      if (ruleIds.has(rule.id)) {
        issues.push({
          path: `rules.${index}.id`,
          message: 'Rule ID must be unique.',
        });
        return;
      }

      ruleIds.add(rule.id);
    });
  }

  if (!isRecord(config.actionPoints)) {
    issues.push({
      path: 'actionPoints',
      message: 'Action points must be an object.',
    });
  } else {
    validateActionPoints(issues, 'actionPoints', config.actionPoints);
  }

  if (
    typeof config.decayAmount !== 'number' ||
    !isIntegerInRange(config.decayAmount, 0, 100)
  ) {
    issues.push({
      path: 'decayAmount',
      message: 'Decay amount must be an integer from 0 to 100.',
    });
  }

  if (
    typeof config.decayIntervalDays !== 'number' ||
    !isIntegerInRange(config.decayIntervalDays, 1, 3650)
  ) {
    issues.push({
      path: 'decayIntervalDays',
      message: 'Decay interval must be an integer from 1 to 3650 days.',
    });
  }

  const requiredTemplates = [
    ['defaultPublicCommentTemplate', PUBLIC_PLACEHOLDERS],
    ['defaultPrivateUserNoticeTemplate', PRIVATE_PLACEHOLDERS],
    ['defaultZeroPointPrivateUserNoticeTemplate', PRIVATE_PLACEHOLDERS],
    ['defaultNativeModNoteTemplate', PRIVATE_PLACEHOLDERS],
    ['defaultZeroPointNativeModNoteTemplate', PRIVATE_PLACEHOLDERS],
  ] as const;

  for (const [path, placeholders] of requiredTemplates) {
    const template = config[path];
    if (typeof template !== 'string') {
      issues.push({ path, message: 'Template is required.' });
    } else {
      requireTemplate(issues, path, template, placeholders);
    }
  }

  for (const path of [
    'userNoticesEnabled',
    'distinguishAppComments',
    'lockAppComments',
    'nativeModNotesEnabled',
    'reversalNativeModNotesEnabled',
  ] as const) {
    if (typeof config[path] !== 'boolean') {
      issues.push({ path, message: 'Value must be true or false.' });
    }
  }

  if (!isRecord(config.stickyAppComments)) {
    issues.push({
      path: 'stickyAppComments',
      message: 'Sticky comment settings must be an object.',
    });
  } else {
    for (const action of STRIKE_ACTIONS) {
      if (typeof config.stickyAppComments[action] !== 'boolean') {
        issues.push({
          path: `stickyAppComments.${action}`,
          message: 'Value must be true or false.',
        });
      }
    }
  }

  return issues;
};

export const getRulePoints = (
  config: StrikeLedgerConfig,
  rule: RuleConfig,
  action: StrikeAction
): number => rule.pointOverrides?.[action] ?? config.actionPoints[action];
