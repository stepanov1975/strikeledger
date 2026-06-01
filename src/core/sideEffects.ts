import {
  ACTION_LABELS,
  type LedgerEntry,
  type SideEffectStatus,
  type SideEffects,
  type StrikeLedgerConfig,
} from './domain';
import { logError } from './logging';
import { renderTemplate, type TemplateValues } from './templates';

const MAX_NATIVE_MOD_NOTE_LENGTH = 250;

export type PublicComment = {
  id: string;
  distinguish(makeSticky?: boolean): Promise<void>;
  lock(): Promise<void>;
};

export type SideEffectTarget = {
  addComment?(opts: {
    text: string;
    runAs?: 'USER' | 'APP';
  }): Promise<PublicComment>;
  reply?(opts: {
    text: string;
    runAs?: 'USER' | 'APP';
  }): Promise<PublicComment>;
  remove(isSpam?: boolean): Promise<void>;
  markAsNsfw?(): Promise<void>;
};

export type SideEffectRedditClient = {
  addModNote(options: {
    subreddit: string;
    user: string;
    redditId?: string;
    note: string;
  }): Promise<{ id: string }>;
  modMail: {
    createConversation(params: {
      body: string;
      isAuthorHidden: boolean;
      subredditName: string;
      subject: string;
      to: string;
    }): Promise<{ conversation: { id?: string | undefined } }>;
  };
};

export type ExecuteSideEffectsInput = {
  entry: LedgerEntry;
  activeTotal: number;
  target: SideEffectTarget;
  reddit: SideEffectRedditClient;
  config: StrikeLedgerConfig;
  publicCommentOverride?: string;
};

export type ExecuteReversalSideEffectsInput = {
  entry: LedgerEntry;
  activeTotal: number;
  reddit: SideEffectRedditClient;
  config: StrikeLedgerConfig;
  addNativeModNote: boolean;
};

const succeededOrFailed = async (
  operation: () => Promise<void>
): Promise<SideEffectStatus> => {
  try {
    await operation();
    return 'succeeded';
  } catch (error) {
    logError('side_effect.failed', {}, error);
    return 'failed';
  }
};

const buildTemplateValues = (
  entry: LedgerEntry,
  activeTotal: number
): TemplateValues => ({
  subredditName: entry.subredditName,
  ruleLabel: entry.ruleLabel,
  action: ACTION_LABELS[entry.action],
  pointsAdded: entry.originalPoints,
  activeTotal,
  targetPermalink: entry.targetPermalink,
});

const choosePrivateTemplate = (
  entry: LedgerEntry,
  config: StrikeLedgerConfig
): string =>
  entry.originalPoints === 0
    ? config.defaultZeroPointPrivateUserNoticeTemplate
    : config.defaultPrivateUserNoticeTemplate;

const chooseNativeModNoteTemplate = (
  entry: LedgerEntry,
  config: StrikeLedgerConfig
): string => {
  const ruleTemplate = config.rules.find(
    (rule) => rule.id === entry.ruleId
  )?.internalNoteTemplate;
  if (ruleTemplate) {
    return ruleTemplate;
  }

  return entry.originalPoints === 0
    ? config.defaultZeroPointNativeModNoteTemplate
    : config.defaultNativeModNoteTemplate;
};

const choosePublicTemplate = (
  entry: LedgerEntry,
  config: StrikeLedgerConfig,
  publicCommentOverride: string | undefined
): string =>
  publicCommentOverride ??
  config.rules.find((rule) => rule.id === entry.ruleId)?.publicTemplate ??
  config.defaultPublicCommentTemplate;

const hasUsableUsername = (username: string): boolean => {
  const normalized = username.trim().replace(/^u\//i, '').toLowerCase();
  return (
    Boolean(normalized) &&
    normalized !== '[deleted]' &&
    normalized !== '[unknown]'
  );
};

const truncateNativeModNote = (note: string): string =>
  note.length <= MAX_NATIVE_MOD_NOTE_LENGTH
    ? note
    : `${note.slice(0, MAX_NATIVE_MOD_NOTE_LENGTH - 3).trimEnd()}...`;

const getFinalStatus = (sideEffects: SideEffects): LedgerEntry['status'] => {
  const statuses: SideEffectStatus[] = [
    sideEffects.publicComment,
    sideEffects.remove,
    sideEffects.markNsfw,
    sideEffects.modNote,
    sideEffects.userNotice,
    sideEffects.reversalModNote,
    sideEffects.reversalUserNotice,
    ...(sideEffects.publicCommentOptions
      ? Object.values(sideEffects.publicCommentOptions)
      : []),
  ];

  return statuses.includes('failed') ? 'partial' : 'succeeded';
};

const submitPublicComment = async (
  target: SideEffectTarget,
  text: string
): Promise<PublicComment> => {
  if (target.addComment) {
    return target.addComment({ text, runAs: 'APP' });
  }

  if (target.reply) {
    return target.reply({ text, runAs: 'APP' });
  }

  throw new Error('Target cannot receive a public comment.');
};

const executePublicCommentOptions = async (
  publicComment: PublicComment,
  entry: LedgerEntry,
  config: StrikeLedgerConfig
): Promise<SideEffects['publicCommentOptions']> => {
  const options: NonNullable<SideEffects['publicCommentOptions']> = {};
  const shouldDistinguish = config.distinguishAppComments;
  const shouldSticky = config.stickyAppComments[entry.action];

  if (shouldDistinguish || shouldSticky) {
    const status = await succeededOrFailed(() =>
      publicComment.distinguish(shouldSticky)
    );

    if (shouldDistinguish) {
      options.distinguish = status;
    }

    if (shouldSticky) {
      options.sticky = status;
    }
  }

  if (config.lockAppComments) {
    options.lock = await succeededOrFailed(() => publicComment.lock());
  }

  return Object.keys(options).length > 0 ? options : undefined;
};

export const executeSideEffects = async (
  input: ExecuteSideEffectsInput
): Promise<LedgerEntry> => {
  const values = buildTemplateValues(input.entry, input.activeTotal);
  const sideEffects: SideEffects = { ...input.entry.sideEffects };
  let publicCommentId = input.entry.publicCommentId;
  let modNoteId = input.entry.modNoteId;
  let userNoticeId = input.entry.userNoticeId;

  try {
    const publicComment = await submitPublicComment(
      input.target,
      renderTemplate(
        choosePublicTemplate(
          input.entry,
          input.config,
          input.publicCommentOverride
        ),
        values
      )
    );
    publicCommentId = publicComment.id;
    sideEffects.publicComment = 'succeeded';
    const publicCommentOptions = await executePublicCommentOptions(
      publicComment,
      input.entry,
      input.config
    );
    if (publicCommentOptions) {
      sideEffects.publicCommentOptions = publicCommentOptions;
    }
  } catch (error) {
    logError(
      'side_effect.public_comment_failed',
      {
        entryId: input.entry.entryId,
        subredditName: input.entry.subredditName,
        targetId: input.entry.targetId,
        targetKind: input.entry.targetKind,
        action: input.entry.action,
        ruleId: input.entry.ruleId,
      },
      error
    );
    sideEffects.publicComment = 'failed';
  }

  if (input.entry.action === 'warn_remove') {
    sideEffects.remove = await succeededOrFailed(() =>
      input.target.remove(false)
    );
  }

  if (input.entry.action === 'warn_nsfw') {
    sideEffects.markNsfw = await succeededOrFailed(async () => {
      if (!input.target.markAsNsfw) {
        throw new Error('Target cannot be marked NSFW.');
      }

      await input.target.markAsNsfw();
    });
  }

  if (
    input.config.nativeModNotesEnabled &&
    hasUsableUsername(input.entry.username)
  ) {
    try {
      const modNote = await input.reddit.addModNote({
        subreddit: input.entry.subredditName,
        user: input.entry.username,
        redditId: input.entry.targetId,
        note: truncateNativeModNote(
          renderTemplate(
            chooseNativeModNoteTemplate(input.entry, input.config),
            values
          )
        ),
      });
      modNoteId = modNote.id;
      sideEffects.modNote = 'succeeded';
    } catch (error) {
      logError(
        'side_effect.native_mod_note_failed',
        {
          entryId: input.entry.entryId,
          subredditName: input.entry.subredditName,
          targetId: input.entry.targetId,
          targetKind: input.entry.targetKind,
          action: input.entry.action,
          ruleId: input.entry.ruleId,
        },
        error
      );
      sideEffects.modNote = 'failed';
    }
  } else {
    sideEffects.modNote = 'skipped';
  }

  if (
    input.config.userNoticesEnabled &&
    hasUsableUsername(input.entry.username)
  ) {
    try {
      const response = await input.reddit.modMail.createConversation({
        isAuthorHidden: true,
        subredditName: input.entry.subredditName,
        to: input.entry.username,
        subject: `StrikeLedger notice for r/${input.entry.subredditName}`.slice(
          0,
          100
        ),
        body: renderTemplate(
          choosePrivateTemplate(input.entry, input.config),
          values
        ),
      });
      userNoticeId = response.conversation.id;
      sideEffects.userNotice = 'succeeded';
    } catch (error) {
      logError(
        'side_effect.user_notice_failed',
        {
          entryId: input.entry.entryId,
          subredditName: input.entry.subredditName,
          targetId: input.entry.targetId,
          targetKind: input.entry.targetKind,
          action: input.entry.action,
          ruleId: input.entry.ruleId,
        },
        error
      );
      sideEffects.userNotice = 'failed';
    }
  } else {
    sideEffects.userNotice = 'skipped';
  }

  return {
    ...input.entry,
    status: getFinalStatus(sideEffects),
    sideEffects,
    ...(publicCommentId !== undefined ? { publicCommentId } : {}),
    ...(modNoteId !== undefined ? { modNoteId } : {}),
    ...(userNoticeId !== undefined ? { userNoticeId } : {}),
  };
};

const buildReversalModNote = (
  entry: LedgerEntry,
  activeTotal: number
): string =>
  `StrikeLedger reversal: ${ACTION_LABELS[entry.action]} for ${entry.ruleLabel} was reversed by u/${entry.reversedBy ?? 'unknown'}. Reason: ${entry.reversalReason ?? 'No reason provided'}. Active total: ${activeTotal}. Target: ${entry.targetPermalink}`;

const buildReversalUserNotice = (
  entry: LedgerEntry,
  activeTotal: number
): string =>
  `A previous moderation warning in r/${entry.subredditName} for ${entry.ruleLabel} was reversed. Your current active warning total is ${activeTotal}.`;

export const executeReversalSideEffects = async (
  input: ExecuteReversalSideEffectsInput
): Promise<LedgerEntry> => {
  const sideEffects: SideEffects = { ...input.entry.sideEffects };
  let reversalModNoteId = input.entry.reversalModNoteId;
  let reversalUserNoticeId = input.entry.reversalUserNoticeId;

  if (
    input.config.reversalNativeModNotesEnabled &&
    input.addNativeModNote &&
    hasUsableUsername(input.entry.username)
  ) {
    try {
      const modNote = await input.reddit.addModNote({
        subreddit: input.entry.subredditName,
        user: input.entry.username,
        redditId: input.entry.targetId,
        note: truncateNativeModNote(
          buildReversalModNote(input.entry, input.activeTotal)
        ),
      });
      reversalModNoteId = modNote.id;
      sideEffects.reversalModNote = 'succeeded';
    } catch (error) {
      logError(
        'side_effect.reversal_mod_note_failed',
        {
          entryId: input.entry.entryId,
          subredditName: input.entry.subredditName,
          targetId: input.entry.targetId,
          targetKind: input.entry.targetKind,
          action: input.entry.action,
          ruleId: input.entry.ruleId,
        },
        error
      );
      sideEffects.reversalModNote = 'failed';
    }
  } else {
    sideEffects.reversalModNote = 'skipped';
  }

  if (
    input.config.userNoticesEnabled &&
    hasUsableUsername(input.entry.username)
  ) {
    try {
      const response = await input.reddit.modMail.createConversation({
        isAuthorHidden: true,
        subredditName: input.entry.subredditName,
        to: input.entry.username,
        subject:
          `StrikeLedger reversal for r/${input.entry.subredditName}`.slice(
            0,
            100
          ),
        body: buildReversalUserNotice(input.entry, input.activeTotal),
      });
      reversalUserNoticeId = response.conversation.id;
      sideEffects.reversalUserNotice = 'succeeded';
    } catch (error) {
      logError(
        'side_effect.reversal_user_notice_failed',
        {
          entryId: input.entry.entryId,
          subredditName: input.entry.subredditName,
          targetId: input.entry.targetId,
          targetKind: input.entry.targetKind,
          action: input.entry.action,
          ruleId: input.entry.ruleId,
        },
        error
      );
      sideEffects.reversalUserNotice = 'failed';
    }
  } else {
    sideEffects.reversalUserNotice = 'skipped';
  }

  return {
    ...input.entry,
    status: 'reversed',
    sideEffects,
    ...(reversalModNoteId !== undefined ? { reversalModNoteId } : {}),
    ...(reversalUserNoticeId !== undefined ? { reversalUserNoticeId } : {}),
  };
};
