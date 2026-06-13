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

type PersistLedgerEntry = (entry: LedgerEntry) => Promise<void>;

export type ExecuteSideEffectsInput = {
  entry: LedgerEntry;
  activeTotal: number;
  target: SideEffectTarget;
  reddit: SideEffectRedditClient;
  config: StrikeLedgerConfig;
  publicCommentOverride?: string;
  persistEntry?: PersistLedgerEntry;
};

export type ExecuteReversalSideEffectsInput = {
  entry: LedgerEntry;
  activeTotal: number;
  reddit: SideEffectRedditClient;
  config: StrikeLedgerConfig;
  addNativeModNote: boolean;
  persistEntry?: PersistLedgerEntry;
};

type PublicCommentOptionName =
  | 'distinguish'
  | 'sticky'
  | 'distinguish_sticky'
  | 'lock';

const publicCommentOptionSucceededOrFailed = async (
  entry: LedgerEntry,
  option: PublicCommentOptionName,
  operation: () => Promise<void>
): Promise<SideEffectStatus> => {
  try {
    await operation();
    return 'succeeded';
  } catch (error) {
    logError(
      'side_effect.public_comment_option_failed',
      {
        entryId: entry.entryId,
        subredditName: entry.subredditName,
        targetId: entry.targetId,
        targetKind: entry.targetKind,
        action: entry.action,
        ruleId: entry.ruleId,
        option,
      },
      error
    );
    return 'failed';
  }
};

const getDistinguishOptionName = (
  shouldDistinguish: boolean,
  shouldSticky: boolean
): PublicCommentOptionName => {
  if (shouldDistinguish && shouldSticky) {
    return 'distinguish_sticky';
  }

  return shouldSticky ? 'sticky' : 'distinguish';
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

const cloneSideEffects = (sideEffects: SideEffects): SideEffects => ({
  publicComment: sideEffects.publicComment,
  remove: sideEffects.remove,
  markNsfw: sideEffects.markNsfw,
  modNote: sideEffects.modNote,
  userNotice: sideEffects.userNotice,
  reversalModNote: sideEffects.reversalModNote,
  reversalUserNotice: sideEffects.reversalUserNotice,
  ...(sideEffects.publicCommentOptions
    ? { publicCommentOptions: { ...sideEffects.publicCommentOptions } }
    : {}),
});

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
    const status = await publicCommentOptionSucceededOrFailed(
      entry,
      getDistinguishOptionName(shouldDistinguish, shouldSticky),
      () => publicComment.distinguish(shouldSticky)
    );

    if (shouldDistinguish) {
      options.distinguish = status;
    }

    if (shouldSticky) {
      options.sticky = status;
    }
  }

  if (config.lockAppComments) {
    options.lock = await publicCommentOptionSucceededOrFailed(
      entry,
      'lock',
      () => publicComment.lock()
    );
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
  const buildUpdatedEntry = (status: LedgerEntry['status']): LedgerEntry => ({
    ...input.entry,
    status,
    sideEffects: cloneSideEffects(sideEffects),
    ...(publicCommentId !== undefined ? { publicCommentId } : {}),
    ...(modNoteId !== undefined ? { modNoteId } : {}),
    ...(userNoticeId !== undefined ? { userNoticeId } : {}),
  });
  const persistCheckpoint = async (): Promise<void> => {
    if (input.persistEntry) {
      await input.persistEntry(buildUpdatedEntry(input.entry.status));
    }
  };

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
    await persistCheckpoint();
    const publicCommentOptions = await executePublicCommentOptions(
      publicComment,
      input.entry,
      input.config
    );
    if (publicCommentOptions) {
      sideEffects.publicCommentOptions = publicCommentOptions;
      await persistCheckpoint();
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
    await persistCheckpoint();
  }

  if (input.entry.action === 'warn_remove') {
    try {
      await input.target.remove(false);
      sideEffects.remove = 'succeeded';
    } catch (error) {
      logError(
        'side_effect.remove_failed',
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
      sideEffects.remove = 'failed';
    }
    await persistCheckpoint();
  }

  if (input.entry.action === 'warn_nsfw') {
    try {
      if (!input.target.markAsNsfw) {
        throw new Error('Target cannot be marked NSFW.');
      }

      await input.target.markAsNsfw();
      sideEffects.markNsfw = 'succeeded';
    } catch (error) {
      logError(
        'side_effect.mark_nsfw_failed',
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
      sideEffects.markNsfw = 'failed';
    }
    await persistCheckpoint();
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
      await persistCheckpoint();
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
      await persistCheckpoint();
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
      await persistCheckpoint();
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
      await persistCheckpoint();
    }
  } else {
    sideEffects.userNotice = 'skipped';
  }

  return buildUpdatedEntry(getFinalStatus(sideEffects));
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
  const buildUpdatedEntry = (): LedgerEntry => ({
    ...input.entry,
    status: 'reversed',
    sideEffects: cloneSideEffects(sideEffects),
    ...(reversalModNoteId !== undefined ? { reversalModNoteId } : {}),
    ...(reversalUserNoticeId !== undefined ? { reversalUserNoticeId } : {}),
  });
  const persistCheckpoint = async (): Promise<void> => {
    if (input.persistEntry) {
      await input.persistEntry(buildUpdatedEntry());
    }
  };

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
      await persistCheckpoint();
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
      await persistCheckpoint();
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
      await persistCheckpoint();
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
      await persistCheckpoint();
    }
  } else {
    sideEffects.reversalUserNotice = 'skipped';
  }

  return buildUpdatedEntry();
};
