import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logging', () => ({
  logError: vi.fn(),
}));

import { DEFAULT_CONFIG } from './config';
import { EMPTY_SIDE_EFFECTS, SCHEMA_VERSION, type LedgerEntry } from './domain';
import { logError } from './logging';
import {
  executeReversalSideEffects,
  executeSideEffects,
  type SideEffectRedditClient,
} from './sideEffects';

const buildEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: SCHEMA_VERSION,
  entryId: 'entry-1',
  subredditName: 'testsub',
  userId: 't2_user',
  username: 'target-user',
  userKey: 'id:t2_user',
  targetId: 't3_target',
  targetKind: 'post',
  targetPermalink: '/r/testsub/comments/target',
  action: 'warn_remove',
  ruleId: 'rule-general',
  ruleLabel: 'Community rule violation',
  publicCommentOverrideUsed: false,
  originalPoints: 3,
  moderatorUsername: 'mod-a',
  createdAtMs: 1000,
  status: 'pending',
  duplicateKey: 'duplicate',
  moderatorRetryKey: 'retry',
  idempotencyInputs: {},
  formNonce: 'nonce-1',
  sideEffects: {
    ...EMPTY_SIDE_EFFECTS,
    publicComment: 'pending',
    remove: 'pending',
    modNote: 'pending',
    userNotice: 'pending',
  },
  ...overrides,
});

const buildReddit = () => ({
  addModNote: vi.fn(async () => ({ id: 'mod-note-1' })),
  modMail: {
    createConversation: vi.fn(async () => ({
      conversation: { id: 'conversation-1' },
    })),
  },
});

const logErrorMock = vi.mocked(logError);

const publicCommentText = (target: {
  addComment: ReturnType<typeof vi.fn>;
}): string => {
  const [[commentOptions]] = target.addComment.mock.calls as unknown as [
    [{ text: string }],
  ];
  return commentOptions.text;
};

const privateNoticeBody = (reddit: ReturnType<typeof buildReddit>): string => {
  const [[noticeOptions]] = reddit.modMail.createConversation.mock
    .calls as unknown as [[{ body: string }]];
  return noticeOptions.body;
};

describe('executeSideEffects', () => {
  beforeEach(() => {
    logErrorMock.mockClear();
  });

  it('records succeeded statuses and side-effect IDs', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    const updated = await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit,
      config: DEFAULT_CONFIG,
    });

    expect(updated.status).toBe('succeeded');
    expect(updated.publicCommentId).toBe('comment-1');
    expect(updated.modNoteId).toBe('mod-note-1');
    expect(updated.userNoticeId).toBe('conversation-1');
    expect(updated.sideEffects).toMatchObject({
      publicComment: 'succeeded',
      publicCommentOptions: {
        distinguish: 'succeeded',
        lock: 'succeeded',
      },
      remove: 'succeeded',
      modNote: 'succeeded',
      userNotice: 'succeeded',
    });
    expect(target.remove).toHaveBeenCalledWith(false);
    expect(reddit.addModNote).toHaveBeenCalledTimes(1);
    const [[modNoteOptions]] = reddit.addModNote.mock.calls as unknown as [
      [Parameters<SideEffectRedditClient['addModNote']>[0]],
    ];
    expect(modNoteOptions).not.toHaveProperty('label');
  });

  it('checkpoints enforcement side-effect progress after each attempt', async () => {
    const checkpoints: LedgerEntry[] = [];
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };

    const updated = await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit: buildReddit(),
      config: DEFAULT_CONFIG,
      persistEntry: async (entry: LedgerEntry) => {
        checkpoints.push(JSON.parse(JSON.stringify(entry)) as LedgerEntry);
      },
    });

    expect(updated.status).toBe('succeeded');
    expect(checkpoints).toHaveLength(5);
    expect(checkpoints[0]).toMatchObject({
      status: 'pending',
      publicCommentId: 'comment-1',
      sideEffects: {
        publicComment: 'succeeded',
        remove: 'pending',
        modNote: 'pending',
        userNotice: 'pending',
      },
    });
    expect(checkpoints[1]!.sideEffects.publicCommentOptions).toMatchObject({
      distinguish: 'succeeded',
      lock: 'succeeded',
    });
    expect(checkpoints[2]!.sideEffects.remove).toBe('succeeded');
    expect(checkpoints[3]).toMatchObject({
      modNoteId: 'mod-note-1',
      sideEffects: { modNote: 'succeeded' },
    });
    expect(checkpoints[4]).toMatchObject({
      userNoticeId: 'conversation-1',
      sideEffects: { userNotice: 'succeeded' },
    });
  });

  it('retries only pending or failed side effects', async () => {
    const publicComment = {
      id: 'comment-2',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    const updated = await executeSideEffects({
      entry: buildEntry({
        status: 'partial',
        publicCommentId: 'comment-1',
        modNoteId: 'mod-note-1',
        sideEffects: {
          ...EMPTY_SIDE_EFFECTS,
          publicComment: 'succeeded',
          remove: 'failed',
          modNote: 'succeeded',
          userNotice: 'skipped',
        },
      }),
      activeTotal: 3,
      target,
      reddit,
      config: DEFAULT_CONFIG,
    });

    expect(target.addComment).not.toHaveBeenCalled();
    expect(target.remove).toHaveBeenCalledTimes(1);
    expect(reddit.addModNote).not.toHaveBeenCalled();
    expect(reddit.modMail.createConversation).not.toHaveBeenCalled();
    expect(updated).toMatchObject({
      status: 'succeeded',
      publicCommentId: 'comment-1',
      modNoteId: 'mod-note-1',
      sideEffects: {
        publicComment: 'succeeded',
        remove: 'succeeded',
        modNote: 'succeeded',
        userNotice: 'skipped',
      },
    });
  });

  it('keeps ledger valid and partial when public comment fails', async () => {
    const target = {
      addComment: vi.fn(async () => {
        throw new Error('comment failed');
      }),
      remove: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    const updated = await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit,
      config: DEFAULT_CONFIG,
    });

    expect(updated.status).toBe('partial');
    expect(updated.sideEffects.publicComment).toBe('failed');
    expect(updated.sideEffects.remove).toBe('succeeded');
    expect(updated.sideEffects.modNote).toBe('succeeded');
    expect(updated.sideEffects.userNotice).toBe('succeeded');
  });

  it('keeps successful Reddit side effects when checkpoint persistence fails', async () => {
    const checkpointError = new Error('redis unavailable');
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };

    const updated = await executeSideEffects({
      entry: buildEntry({
        action: 'warn',
        sideEffects: {
          ...EMPTY_SIDE_EFFECTS,
          publicComment: 'pending',
        },
      }),
      activeTotal: 1,
      target,
      reddit: buildReddit(),
      config: {
        ...DEFAULT_CONFIG,
        distinguishAppComments: false,
        lockAppComments: false,
      },
      persistEntry: async () => {
        throw checkpointError;
      },
    });

    expect(updated.status).toBe('succeeded');
    expect(updated.publicCommentId).toBe('comment-1');
    expect(updated.sideEffects.publicComment).toBe('succeeded');
    expect(target.addComment).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      'side_effect.checkpoint_failed',
      {
        entryId: 'entry-1',
        subredditName: 'testsub',
        targetId: 't3_target',
        targetKind: 'post',
        action: 'warn',
        ruleId: 'rule-general',
      },
      checkpointError
    );
  });

  it('logs public comment option failures with option context', async () => {
    const distinguishError = new Error('distinguish failed');
    const lockError = new Error('lock failed');
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => {
        throw distinguishError;
      }),
      lock: vi.fn(async () => {
        throw lockError;
      }),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };

    const updated = await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit: buildReddit(),
      config: {
        ...DEFAULT_CONFIG,
        stickyAppComments: {
          ...DEFAULT_CONFIG.stickyAppComments,
          warn_remove: true,
        },
      },
    });

    expect(updated.status).toBe('partial');
    expect(updated.sideEffects.publicCommentOptions).toMatchObject({
      distinguish: 'failed',
      sticky: 'failed',
      lock: 'failed',
    });
    expect(logErrorMock).toHaveBeenCalledWith(
      'side_effect.public_comment_option_failed',
      {
        entryId: 'entry-1',
        subredditName: 'testsub',
        targetId: 't3_target',
        targetKind: 'post',
        action: 'warn_remove',
        ruleId: 'rule-general',
        option: 'distinguish_sticky',
      },
      distinguishError
    );
    expect(logErrorMock).toHaveBeenCalledWith(
      'side_effect.public_comment_option_failed',
      {
        entryId: 'entry-1',
        subredditName: 'testsub',
        targetId: 't3_target',
        targetKind: 'post',
        action: 'warn_remove',
        ruleId: 'rule-general',
        option: 'lock',
      },
      lockError
    );
  });

  it('uses zero-point notice templates', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    await executeSideEffects({
      entry: buildEntry({
        action: 'warn',
        originalPoints: 0,
        sideEffects: {
          ...EMPTY_SIDE_EFFECTS,
          publicComment: 'pending',
          modNote: 'pending',
          userNotice: 'pending',
        },
      }),
      activeTotal: 0,
      target,
      reddit,
      config: DEFAULT_CONFIG,
    });

    expect(reddit.addModNote).toHaveBeenCalledWith(
      expect.objectContaining({ note: expect.stringContaining('No points added') })
    );
    expect(reddit.modMail.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('without adding warning points'),
      })
    );
  });

  it('keeps default removal public comments neutral and private notices outcome-specific', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit,
      config: DEFAULT_CONFIG,
    });

    expect(publicCommentText(target)).not.toContain('was removed');
    expect(publicCommentText(target)).toContain(
      '/r/testsub/comments/target'
    );
    expect(privateNoticeBody(reddit)).toContain('The post was removed');
  });

  it('tells the user when removal could not be confirmed', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => {
        throw new Error('remove failed');
      }),
    };
    const reddit = buildReddit();

    await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit,
      config: DEFAULT_CONFIG,
    });

    expect(publicCommentText(target)).not.toContain('was removed');
    expect(privateNoticeBody(reddit)).toContain(
      'could not confirm that the post was removed'
    );
  });

  it('keeps default NSFW public comments neutral and private notices outcome-specific', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
      markAsNsfw: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    await executeSideEffects({
      entry: buildEntry({
        action: 'warn_nsfw',
        originalPoints: 1,
        sideEffects: {
          ...EMPTY_SIDE_EFFECTS,
          publicComment: 'pending',
          markNsfw: 'pending',
          modNote: 'pending',
          userNotice: 'pending',
        },
      }),
      activeTotal: 1,
      target,
      reddit,
      config: DEFAULT_CONFIG,
    });

    expect(publicCommentText(target)).not.toContain('marked NSFW');
    expect(publicCommentText(target)).toContain(
      '/r/testsub/comments/target'
    );
    expect(privateNoticeBody(reddit)).toContain('The post was marked NSFW');
  });

  it('uses selected rule templates before global defaults', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit,
      config: {
        ...DEFAULT_CONFIG,
        rules: [
          {
            id: 'rule-general',
            label: 'Community rule violation',
            enabled: true,
            publicTemplate: 'Rule public: {ruleLabel}',
            internalNoteTemplate: 'Rule internal: {activeTotal}',
          },
        ],
      },
    });

    expect(target.addComment).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Rule public: Community rule violation' })
    );
    expect(reddit.addModNote).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Rule internal: 3' })
    );
  });

  it('truncates native mod notes to the platform limit', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit,
      config: {
        ...DEFAULT_CONFIG,
        defaultNativeModNoteTemplate: 'x'.repeat(300),
      },
    });

    const [[modNoteOptions]] = reddit.addModNote.mock.calls as unknown as [
      [Parameters<SideEffectRedditClient['addModNote']>[0]],
    ];
    expect(modNoteOptions.note).toHaveLength(250);
    expect(modNoteOptions.note.endsWith('...')).toBe(true);
  });

  it('skips username-required side effects when the username is unavailable', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
    };
    const reddit = buildReddit();

    const updated = await executeSideEffects({
      entry: buildEntry({
        username: '[unknown]',
      }),
      activeTotal: 3,
      target,
      reddit,
      config: DEFAULT_CONFIG,
    });

    expect(updated.status).toBe('succeeded');
    expect(updated.sideEffects.modNote).toBe('skipped');
    expect(updated.sideEffects.userNotice).toBe('skipped');
    expect(target.addComment).toHaveBeenCalledTimes(1);
    expect(target.remove).toHaveBeenCalledWith(false);
    expect(reddit.addModNote).not.toHaveBeenCalled();
    expect(reddit.modMail.createConversation).not.toHaveBeenCalled();
  });

  it('logs remove failures with enforcement context', async () => {
    const removeError = new Error('remove failed');
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => {
        throw removeError;
      }),
    };

    const updated = await executeSideEffects({
      entry: buildEntry(),
      activeTotal: 3,
      target,
      reddit: buildReddit(),
      config: DEFAULT_CONFIG,
    });

    expect(updated.status).toBe('partial');
    expect(updated.sideEffects.remove).toBe('failed');
    expect(logErrorMock).toHaveBeenCalledWith(
      'side_effect.remove_failed',
      {
        entryId: 'entry-1',
        subredditName: 'testsub',
        targetId: 't3_target',
        targetKind: 'post',
        action: 'warn_remove',
        ruleId: 'rule-general',
      },
      removeError
    );
  });

  it('marks NSFW failures partial', async () => {
    const nsfwError = new Error('nsfw failed');
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
      markAsNsfw: vi.fn(async () => {
        throw nsfwError;
      }),
    };

    const updated = await executeSideEffects({
      entry: buildEntry({
        action: 'warn_nsfw',
        sideEffects: {
          ...EMPTY_SIDE_EFFECTS,
          publicComment: 'pending',
          markNsfw: 'pending',
          modNote: 'pending',
          userNotice: 'pending',
        },
      }),
      activeTotal: 1,
      target,
      reddit: buildReddit() satisfies SideEffectRedditClient,
      config: DEFAULT_CONFIG,
    });

    expect(updated.status).toBe('partial');
    expect(updated.sideEffects.markNsfw).toBe('failed');
    expect(logErrorMock).toHaveBeenCalledWith(
      'side_effect.mark_nsfw_failed',
      {
        entryId: 'entry-1',
        subredditName: 'testsub',
        targetId: 't3_target',
        targetKind: 'post',
        action: 'warn_nsfw',
        ruleId: 'rule-general',
      },
      nsfwError
    );
  });

  it('records reversal mod note and user notice side effects', async () => {
    const reddit = buildReddit();
    const updated = await executeReversalSideEffects({
      entry: buildEntry({
        status: 'reversed',
        reversedAtMs: 2000,
        reversedBy: 'mod-b',
        reversalReason: 'issued in error',
      }),
      activeTotal: 0,
      reddit,
      config: DEFAULT_CONFIG,
      addNativeModNote: true,
    });

    expect(updated.status).toBe('reversed');
    expect(updated.reversalModNoteId).toBe('mod-note-1');
    expect(updated.reversalUserNoticeId).toBe('conversation-1');
    expect(updated.sideEffects.reversalModNote).toBe('succeeded');
    expect(updated.sideEffects.reversalUserNotice).toBe('succeeded');
    expect(reddit.addModNote).toHaveBeenCalledWith(
      expect.not.objectContaining({ label: expect.anything() })
    );
    expect(reddit.modMail.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('was reversed'),
      })
    );
  });

  it('skips reversal mod notes when native mod notes are disabled globally', async () => {
    const reddit = buildReddit();
    const updated = await executeReversalSideEffects({
      entry: buildEntry({
        status: 'reversed',
        reversedAtMs: 2000,
        reversedBy: 'mod-b',
        reversalReason: 'issued in error',
      }),
      activeTotal: 0,
      reddit,
      config: {
        ...DEFAULT_CONFIG,
        nativeModNotesEnabled: false,
        reversalNativeModNotesEnabled: true,
      },
      addNativeModNote: true,
    });

    expect(updated.sideEffects.reversalModNote).toBe('skipped');
    expect(reddit.addModNote).not.toHaveBeenCalled();
  });

  it('checkpoints reversal side-effect progress after each attempt', async () => {
    const checkpoints: LedgerEntry[] = [];
    const updated = await executeReversalSideEffects({
      entry: buildEntry({
        status: 'reversed',
        reversedAtMs: 2000,
        reversedBy: 'mod-b',
        reversalReason: 'issued in error',
      }),
      activeTotal: 0,
      reddit: buildReddit(),
      config: DEFAULT_CONFIG,
      addNativeModNote: true,
      persistEntry: async (entry: LedgerEntry) => {
        checkpoints.push(JSON.parse(JSON.stringify(entry)) as LedgerEntry);
      },
    });

    expect(updated.status).toBe('reversed');
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({
      status: 'reversed',
      reversalModNoteId: 'mod-note-1',
      sideEffects: { reversalModNote: 'succeeded' },
    });
    expect(checkpoints[1]).toMatchObject({
      status: 'reversed',
      reversalUserNoticeId: 'conversation-1',
      sideEffects: { reversalUserNotice: 'succeeded' },
    });
  });

  it('skips username-required reversal side effects when username is deleted', async () => {
    const reddit = buildReddit();

    const updated = await executeReversalSideEffects({
      entry: buildEntry({
        username: '[deleted]',
        status: 'reversed',
        reversedAtMs: 2000,
        reversedBy: 'mod-b',
        reversalReason: 'issued in error',
      }),
      activeTotal: 0,
      reddit,
      config: DEFAULT_CONFIG,
      addNativeModNote: true,
    });

    expect(updated.status).toBe('reversed');
    expect(updated.sideEffects.reversalModNote).toBe('skipped');
    expect(updated.sideEffects.reversalUserNotice).toBe('skipped');
    expect(reddit.addModNote).not.toHaveBeenCalled();
    expect(reddit.modMail.createConversation).not.toHaveBeenCalled();
  });

  it('keeps reversal valid when private reversal notice fails', async () => {
    const reddit = {
      addModNote: vi.fn(async () => ({ id: 'mod-note-1' })),
      modMail: {
        createConversation: vi.fn(async () => {
          throw new Error('modmail failed');
        }),
      },
    };

    const updated = await executeReversalSideEffects({
      entry: buildEntry({
        status: 'reversed',
        reversedAtMs: 2000,
        reversedBy: 'mod-b',
        reversalReason: 'issued in error',
      }),
      activeTotal: 0,
      reddit,
      config: DEFAULT_CONFIG,
      addNativeModNote: false,
    });

    expect(updated.status).toBe('reversed');
    expect(updated.sideEffects.reversalModNote).toBe('skipped');
    expect(updated.sideEffects.reversalUserNotice).toBe('failed');
  });
});
