import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import { EMPTY_SIDE_EFFECTS, SCHEMA_VERSION, type LedgerEntry } from './domain';
import { executeSideEffects, type SideEffectRedditClient } from './sideEffects';

const buildEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: SCHEMA_VERSION,
  entryId: 'entry-1',
  subredditName: 'testsub',
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
  idempotencyKey: 'retry',
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

describe('executeSideEffects', () => {
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

  it('marks NSFW failures partial', async () => {
    const publicComment = {
      id: 'comment-1',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    };
    const target = {
      addComment: vi.fn(async () => publicComment),
      remove: vi.fn(async () => undefined),
      markAsNsfw: vi.fn(async () => {
        throw new Error('nsfw failed');
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
  });
});
