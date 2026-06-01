import {
  DEFAULT_CONFIG,
  getRulePoints,
  validateConfig,
} from './config';
import {
  EMPTY_SIDE_EFFECTS,
  SCHEMA_VERSION,
  type LedgerEntry,
  type RuleConfig,
  type SideEffects,
  type StrikeAction,
  type StrikeLedgerConfig,
  type TargetKind,
} from './domain';
import {
  createDuplicateKey,
  createModeratorRetryKey,
} from './idempotency';

export const FORM_NONCE_TTL_MS = 10 * 60 * 1000;

export type TargetAuthorSnapshot = {
  authorId?: string;
  authorName?: string;
  userKey: string;
};

export type TargetSnapshot = {
  targetId: string;
  targetKind: TargetKind;
  targetPermalink: string;
  subredditName: string;
  author: TargetAuthorSnapshot;
};

export type BuildLedgerEntryInput = {
  entryId: string;
  formNonce: string;
  action: StrikeAction;
  rule: RuleConfig;
  target: TargetSnapshot;
  moderatorUsername: string;
  createdAtMs: number;
  publicCommentOverrideUsed: boolean;
  config?: StrikeLedgerConfig;
  moderatorNote?: string;
};

export const getRuntimeConfig = (): StrikeLedgerConfig => {
  const issues = validateConfig(DEFAULT_CONFIG);
  if (issues.length > 0) {
    throw new Error('Default StrikeLedger config is invalid.');
  }

  return DEFAULT_CONFIG;
};

export const getEnabledRules = (
  config: StrikeLedgerConfig = DEFAULT_CONFIG
): RuleConfig[] => config.rules.filter((rule) => rule.enabled);

export const findEnabledRule = (
  ruleId: string,
  config: StrikeLedgerConfig = DEFAULT_CONFIG
): RuleConfig | null =>
  getEnabledRules(config).find((rule) => rule.id === ruleId) ?? null;

export const normalizeSelectValue = (value: unknown): string | null => {
  const normalized = Array.isArray(value) ? value[0] : value;

  if (typeof normalized !== 'string') {
    return null;
  }

  const trimmed = normalized.trim();
  return trimmed ? trimmed : null;
};

export const createFormNonceRecordTimes = (
  createdAtMs: number
): { createdAtMs: number; expiresAtMs: number } => ({
  createdAtMs,
  expiresAtMs: createdAtMs + FORM_NONCE_TTL_MS,
});

export const buildInitialSideEffects = (
  action: StrikeAction,
  config: StrikeLedgerConfig
): SideEffects => ({
  ...EMPTY_SIDE_EFFECTS,
  publicComment: 'pending',
  remove: action === 'warn_remove' ? 'pending' : 'skipped',
  markNsfw: action === 'warn_nsfw' ? 'pending' : 'skipped',
  modNote: config.nativeModNotesEnabled ? 'pending' : 'skipped',
  userNotice: config.userNoticesEnabled ? 'pending' : 'skipped',
});

export const buildLedgerEntry = (input: BuildLedgerEntryInput): LedgerEntry => {
  const config = input.config ?? DEFAULT_CONFIG;
  const points = getRulePoints(config, input.rule, input.action);
  const duplicateKey = createDuplicateKey({
    targetId: input.target.targetId,
    action: input.action,
    ruleId: input.rule.id,
  });
  const moderatorRetryKey = createModeratorRetryKey({
    targetId: input.target.targetId,
    action: input.action,
    ruleId: input.rule.id,
    moderatorUsername: input.moderatorUsername,
    submittedAtMs: input.createdAtMs,
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    entryId: input.entryId,
    subredditName: input.target.subredditName,
    ...(input.target.author.authorId !== undefined
      ? { userId: input.target.author.authorId }
      : {}),
    username: input.target.author.authorName ?? '[unknown]',
    userKey: input.target.author.userKey,
    targetId: input.target.targetId,
    targetKind: input.target.targetKind,
    targetPermalink: input.target.targetPermalink,
    action: input.action,
    ruleId: input.rule.id,
    ruleLabel: input.rule.label,
    publicCommentOverrideUsed: input.publicCommentOverrideUsed,
    originalPoints: points,
    moderatorUsername: input.moderatorUsername,
    createdAtMs: input.createdAtMs,
    status: 'pending',
    duplicateKey,
    moderatorRetryKey,
    idempotencyInputs: {
      targetId: input.target.targetId,
      action: input.action,
      ruleId: input.rule.id,
      moderatorUsername: input.moderatorUsername,
      submittedAtMs: input.createdAtMs,
    },
    formNonce: input.formNonce,
    sideEffects: buildInitialSideEffects(input.action, config),
    ...(input.moderatorNote !== undefined
      ? { moderatorNote: input.moderatorNote }
      : {}),
  };
};
