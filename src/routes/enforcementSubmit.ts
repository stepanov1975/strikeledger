import type { UiResponse } from '@devvit/web/shared';
import type { Comment, Post } from '@devvit/web/server';
import type { T1, T3 } from '@devvit/shared-types/tid.js';
import type { ConfigRepository } from '../core/configRepository';
import {
  ACTION_LABELS,
  type LedgerEntry,
  type PublicCommentOptionStatus,
  type SideEffects,
  type TargetKind,
} from '../core/domain';
import {
  buildLedgerEntry,
  findEnabledRule,
  normalizeSelectValue,
  type TargetSnapshot,
} from '../core/enforcement';
import { getTargetAuthorUserKey } from '../core/identity';
import type {
  LedgerRepository,
  FormNonceRecord,
} from '../core/ledgerRepository';
import { logError, logInfo, logWarn, type LogDetails } from '../core/logging';
import {
  executeSideEffects,
  type ExecuteSideEffectsInput,
  type SideEffectRedditClient,
} from '../core/sideEffects';
import {
  PUBLIC_PLACEHOLDERS,
  validateTemplatePlaceholders,
} from '../core/templates';

export type EnforcementFormValues = {
  formNonce?: string | string[];
  ruleId?: string | string[];
  moderatorNote?: string;
  publicCommentOverride?: string;
};

type TargetState = {
  target: Post | Comment;
  parentPost?: Post;
};

type CurrentModeratorUser = {
  username: string;
  getModPermissionsForSubreddit(subredditName: string): Promise<string[]>;
};

export type EnforcementSubmitRedditClient = SideEffectRedditClient & {
  getPostById(id: T3): Promise<Post>;
  getCommentById(id: T1): Promise<Comment>;
  getCurrentUser(): Promise<CurrentModeratorUser | null | undefined>;
};

export type EnforcementSubmitDependencies = {
  repository: Pick<
    LedgerRepository,
    'getFormNonce' | 'createLedgerEntry' | 'updateLedgerEntry'
  >;
  configRepository: Pick<ConfigRepository, 'getConfig'>;
  reddit: EnforcementSubmitRedditClient;
  nowMs?: () => number;
  createEntryId?: () => string;
  executeSideEffects?: (input: ExecuteSideEffectsInput) => Promise<LedgerEntry>;
};

const trimOptional = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const fetchTargetState = async (
  reddit: EnforcementSubmitRedditClient,
  nonce: FormNonceRecord
): Promise<TargetState> => {
  if (nonce.targetKind === 'post') {
    return { target: await reddit.getPostById(nonce.targetId as T3) };
  }

  const comment = await reddit.getCommentById(nonce.targetId as T1);
  const parentPost = await reddit.getPostById(comment.postId);
  return { target: comment, parentPost };
};

const getCurrentModeratorUsername = async (
  reddit: EnforcementSubmitRedditClient,
  subredditName: string
): Promise<string | null> => {
  const user = await reddit.getCurrentUser();
  if (!user) {
    return null;
  }

  const permissions = await user.getModPermissionsForSubreddit(subredditName);
  const canEnforce =
    permissions.includes('all') || permissions.includes('posts');

  return canEnforce ? user.username : null;
};

const validateTargetPreconditions = (
  nonce: FormNonceRecord,
  state: TargetState
): string | null => {
  if (state.target.locked) {
    return 'Locked content cannot be warned.';
  }

  if (state.parentPost?.locked) {
    return 'Comments on locked posts cannot be warned.';
  }

  if (nonce.action === 'warn_remove' && state.target.removed) {
    return 'Already removed content cannot be warned and removed.';
  }

  if (nonce.action === 'warn_nsfw') {
    if (nonce.targetKind !== 'post') {
      return 'Warn and mark NSFW can only apply to posts.';
    }

    if ((state.target as Post).nsfw) {
      return 'Already NSFW posts cannot be warned and marked NSFW.';
    }
  }

  return null;
};

const buildTargetSnapshot = (
  nonce: FormNonceRecord,
  target: Post | Comment
): TargetSnapshot | null => {
  const userKey = getTargetAuthorUserKey(nonce);
  if (!userKey) {
    return null;
  }

  return {
    targetId: nonce.targetId,
    targetKind: nonce.targetKind as TargetKind,
    targetPermalink: target.permalink,
    subredditName: nonce.subredditName,
    author: {
      userKey,
      ...(nonce.authorId !== undefined ? { authorId: nonce.authorId } : {}),
      ...(nonce.authorName !== undefined
        ? { authorName: nonce.authorName }
        : {}),
    },
  };
};

const SIDE_EFFECT_LABELS: Record<
  Exclude<keyof SideEffects, 'publicCommentOptions'>,
  string
> = {
  publicComment: 'public comment',
  remove: 'remove target',
  markNsfw: 'mark NSFW',
  modNote: 'native mod note',
  userNotice: 'private user notice',
  reversalModNote: 'reversal native mod note',
  reversalUserNotice: 'reversal private user notice',
};

const PUBLIC_COMMENT_OPTION_LABELS: Record<
  keyof PublicCommentOptionStatus,
  string
> = {
  distinguish: 'distinguish warning comment',
  sticky: 'sticky warning comment',
  lock: 'lock warning comment',
};

export const failedSideEffectLabels = (sideEffects: SideEffects): string[] => {
  const labels: string[] = [];
  for (const [name, label] of Object.entries(SIDE_EFFECT_LABELS)) {
    if (sideEffects[name as keyof typeof SIDE_EFFECT_LABELS] === 'failed') {
      labels.push(label);
    }
  }

  for (const [name, status] of Object.entries(
    sideEffects.publicCommentOptions ?? {}
  )) {
    if (status === 'failed') {
      labels.push(
        PUBLIC_COMMENT_OPTION_LABELS[
          name as keyof PublicCommentOptionStatus
        ]
      );
    }
  }

  return labels;
};

export const formatCreatedToast = (
  entry: LedgerEntry,
  activeTotal: number,
  wasIdempotent = false
): string => {
  const prefix = wasIdempotent ? 'Strike already recorded' : 'Strike recorded';
  if (entry.status === 'partial') {
    const failedLabels = failedSideEffectLabels(entry.sideEffects);
    const detail =
      failedLabels.length > 0
        ? failedLabels.join(', ')
        : 'unknown Reddit side effect';
    return `${prefix}, but failed Reddit side effects: ${detail}. Active total: ${activeTotal}.`;
  }

  return `${prefix}: ${ACTION_LABELS[entry.action]} for ${entry.ruleLabel}. Active total: ${activeTotal}.`;
};

const buildEntryLogDetails = (
  entry: LedgerEntry,
  activeTotal: number
): LogDetails => ({
  entryId: entry.entryId,
  subredditName: entry.subredditName,
  moderatorUsername: entry.moderatorUsername,
  username: entry.username,
  userKey: entry.userKey,
  targetId: entry.targetId,
  targetKind: entry.targetKind,
  action: entry.action,
  ruleId: entry.ruleId,
  status: entry.status,
  activeTotal,
  publicComment: entry.sideEffects.publicComment,
  remove: entry.sideEffects.remove,
  markNsfw: entry.sideEffects.markNsfw,
  modNote: entry.sideEffects.modNote,
  userNotice: entry.sideEffects.userNotice,
});

export const handleEnforcementSubmit = async (
  values: EnforcementFormValues,
  dependencies: EnforcementSubmitDependencies
): Promise<UiResponse> => {
  const getNowMs = dependencies.nowMs ?? (() => Date.now());
  const createEntryId =
    dependencies.createEntryId ?? (() => crypto.randomUUID());
  const runSideEffects = dependencies.executeSideEffects ?? executeSideEffects;
  const formNonce = normalizeSelectValue(values.formNonce);
  const ruleId = normalizeSelectValue(values.ruleId);

  if (!formNonce || !ruleId) {
    logWarn('enforcement.submit.invalid', {
      hasFormNonce: formNonce !== null,
      hasRuleId: ruleId !== null,
    });
    return { showToast: 'StrikeLedger form is missing required fields.' };
  }

  const config = await dependencies.configRepository.getConfig();
  const nonce = await dependencies.repository.getFormNonce(formNonce);
  if (!nonce) {
    logWarn('enforcement.submit.nonce_missing', {
      ruleId,
    });
    return { showToast: 'StrikeLedger form expired. Reopen the action.' };
  }

  const rule = findEnabledRule(ruleId, config);
  if (!rule) {
    logWarn('enforcement.submit.rule_disabled', {
      ruleId,
      action: nonce.action,
      targetId: nonce.targetId,
      targetKind: nonce.targetKind,
      subredditName: nonce.subredditName,
      moderatorUsername: nonce.moderatorUsername,
    });
    return { showToast: 'Selected StrikeLedger rule is no longer enabled.' };
  }

  const publicCommentOverride = trimOptional(values.publicCommentOverride);
  if (publicCommentOverride !== undefined) {
    const templateIssues = validateTemplatePlaceholders(
      'publicCommentOverride',
      publicCommentOverride,
      PUBLIC_PLACEHOLDERS
    );
    if (templateIssues.length > 0) {
      logWarn('enforcement.submit.invalid_public_override', {
        ruleId,
        action: nonce.action,
        targetId: nonce.targetId,
        targetKind: nonce.targetKind,
        subredditName: nonce.subredditName,
        moderatorUsername: nonce.moderatorUsername,
        issueCount: templateIssues.length,
      });
      return {
        showToast:
          'Public comment override contains a private or unsupported placeholder.',
      };
    }
  }

  const moderatorUsername = await getCurrentModeratorUsername(
    dependencies.reddit,
    nonce.subredditName
  );
  if (!moderatorUsername || moderatorUsername !== nonce.moderatorUsername) {
    logWarn('enforcement.submit.moderator_mismatch', {
      action: nonce.action,
      targetId: nonce.targetId,
      targetKind: nonce.targetKind,
      subredditName: nonce.subredditName,
      expectedModeratorUsername: nonce.moderatorUsername,
      actualModeratorUsername: moderatorUsername,
    });
    return {
      showToast:
        'StrikeLedger form can only be submitted by the moderator who opened it.',
    };
  }

  let targetState: TargetState;
  try {
    targetState = await fetchTargetState(dependencies.reddit, nonce);
  } catch (error) {
    logError(
      'enforcement.submit.target_fetch_failed',
      {
        action: nonce.action,
        targetId: nonce.targetId,
        targetKind: nonce.targetKind,
        subredditName: nonce.subredditName,
        moderatorUsername: nonce.moderatorUsername,
      },
      error
    );
    return { showToast: 'StrikeLedger could not re-check the selected content.' };
  }

  const preconditionFailure = validateTargetPreconditions(nonce, targetState);
  if (preconditionFailure) {
    logWarn('enforcement.submit.precondition_failed', {
      action: nonce.action,
      targetId: nonce.targetId,
      targetKind: nonce.targetKind,
      subredditName: nonce.subredditName,
      moderatorUsername: nonce.moderatorUsername,
      reason: preconditionFailure,
    });
    return { showToast: preconditionFailure };
  }

  const nowMs = getNowMs();
  const moderatorNote = trimOptional(values.moderatorNote);
  const targetSnapshot = buildTargetSnapshot(nonce, targetState.target);
  if (!targetSnapshot) {
    logWarn('enforcement.submit.no_author', {
      action: nonce.action,
      targetId: nonce.targetId,
      targetKind: nonce.targetKind,
      subredditName: nonce.subredditName,
      moderatorUsername,
    });
    return { showToast: 'StrikeLedger cannot warn content without an author.' };
  }

  const entry = buildLedgerEntry({
    entryId: createEntryId(),
    formNonce,
    action: nonce.action,
    rule,
    target: targetSnapshot,
    moderatorUsername,
    createdAtMs: nowMs,
    publicCommentOverrideUsed: publicCommentOverride !== undefined,
    ...(moderatorNote !== undefined ? { moderatorNote } : {}),
    config,
  });

  const result = await dependencies.repository.createLedgerEntry({
    entry,
    formNonce,
    submittedAtMs: nowMs,
    nowMs,
    config,
  });

  switch (result.status) {
    case 'created': {
      const updatedEntry = await runSideEffects({
        entry: result.entry,
        activeTotal: result.activeTotal,
        target: targetState.target,
        reddit: dependencies.reddit,
        config,
        ...(publicCommentOverride !== undefined
          ? { publicCommentOverride }
          : {}),
      });
      await dependencies.repository.updateLedgerEntry(updatedEntry);
      logInfo(
        'enforcement.submit.created',
        buildEntryLogDetails(updatedEntry, result.activeTotal)
      );

      return {
        showToast: formatCreatedToast(updatedEntry, result.activeTotal),
      };
    }
    case 'idempotent':
      logInfo(
        'enforcement.submit.idempotent',
        buildEntryLogDetails(result.entry, result.activeTotal)
      );
      return {
        showToast: formatCreatedToast(result.entry, result.activeTotal, true),
      };
    case 'duplicate':
      logWarn('enforcement.submit.duplicate', {
        entryId: entry.entryId,
        existingEntryId: result.existingEntry.entryId,
        subredditName: entry.subredditName,
        moderatorUsername: entry.moderatorUsername,
        username: entry.username,
        userKey: entry.userKey,
        targetId: entry.targetId,
        targetKind: entry.targetKind,
        action: entry.action,
        ruleId: entry.ruleId,
      });
      return {
        showToast: `Duplicate blocked. Existing entry: ${result.existingEntry.entryId}.`,
      };
    case 'blocked':
      logWarn('enforcement.submit.blocked', {
        entryId: entry.entryId,
        subredditName: entry.subredditName,
        moderatorUsername: entry.moderatorUsername,
        targetId: entry.targetId,
        targetKind: entry.targetKind,
        action: entry.action,
        ruleId: entry.ruleId,
        reason: result.reason,
      });
      if (result.reason === 'transaction_conflict') {
        return {
          showToast:
            'StrikeLedger was busy saving this action. Reopen the action and try again.',
        };
      }

      return { showToast: 'StrikeLedger form expired. Reopen the action.' };
  }
};
