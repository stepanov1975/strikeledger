import { describe, expect, it, vi } from 'vitest';
import type { Comment, Post } from '@devvit/web/server';
import { DEFAULT_CONFIG } from '../core/config';
import { LedgerRepository, type FormNonceRecord } from '../core/ledgerRepository';
import { FakeRedisStore } from '../core/redisStore';
import {
  handleEnforcementSubmit,
  type EnforcementSubmitRedditClient,
} from './enforcementSubmit';

const nowMs = Date.UTC(2026, 0, 1);

type MockPublicComment = {
  id: string;
  distinguish: ReturnType<typeof vi.fn>;
  lock: ReturnType<typeof vi.fn>;
};

const buildPublicComment = (): MockPublicComment => ({
  id: 't1_warning',
  distinguish: vi.fn(async () => undefined),
  lock: vi.fn(async () => undefined),
});

const buildPost = (
  publicComment: MockPublicComment,
  overrides: Partial<{
    id: string;
    subredditName: string;
    authorId: string | undefined;
    authorName: string | undefined;
    locked: boolean;
    removed: boolean;
    nsfw: boolean;
  }> = {}
) =>
  ({
    id: overrides.id ?? 't3_target',
    subredditName: overrides.subredditName ?? 'testsub',
    authorId: 'authorId' in overrides ? overrides.authorId : 't2_user',
    authorName:
      'authorName' in overrides ? overrides.authorName : 'target-user',
    permalink: '/r/testsub/comments/target',
    locked: overrides.locked ?? false,
    removed: overrides.removed ?? false,
    nsfw: overrides.nsfw ?? false,
    addComment: vi.fn(async () => publicComment),
    remove: vi.fn(async () => undefined),
    markAsNsfw: vi.fn(async () => undefined),
  }) as unknown as Post;

const buildComment = (
  publicComment: MockPublicComment,
  overrides: Partial<{
    id: string;
    subredditName: string;
    locked: boolean;
    removed: boolean;
    authorId: string | undefined;
    authorName: string | undefined;
  }> = {}
) =>
  ({
    id: overrides.id ?? 't1_target',
    postId: 't3_parent',
    subredditName: overrides.subredditName ?? 'testsub',
    authorId: 'authorId' in overrides ? overrides.authorId : 't2_user',
    authorName:
      'authorName' in overrides ? overrides.authorName : 'target-user',
    permalink: '/r/testsub/comments/parent/_/target',
    locked: overrides.locked ?? false,
    removed: overrides.removed ?? false,
    reply: vi.fn(async () => publicComment),
    remove: vi.fn(async () => undefined),
  }) as unknown as Comment;

const buildNonce = (
  overrides: Partial<FormNonceRecord> = {}
): FormNonceRecord => ({
  nonce: overrides.nonce ?? 'nonce-1',
  targetId: overrides.targetId ?? 't3_target',
  targetKind: overrides.targetKind ?? 'post',
  subredditName: overrides.subredditName ?? 'testsub',
  userKey: overrides.userKey ?? 'id:t2_user',
  authorId: overrides.authorId ?? 't2_user',
  authorName: overrides.authorName ?? 'target-user',
  action: overrides.action ?? 'warn_remove',
  moderatorUsername: overrides.moderatorUsername ?? 'mod-a',
  createdAtMs: overrides.createdAtMs ?? nowMs,
  expiresAtMs: overrides.expiresAtMs ?? nowMs + 10 * 60 * 1000,
  ...(overrides.consumedAtMs !== undefined
    ? { consumedAtMs: overrides.consumedAtMs }
    : {}),
  ...(overrides.entryId !== undefined ? { entryId: overrides.entryId } : {}),
});

const createHarness = (options: {
  post?: Post;
  comment?: Comment;
  parentPost?: Post;
  moderatorUsername?: string;
  permissions?: string[];
} = {}) => {
  const store = new FakeRedisStore();
  store.nowMs = nowMs;
  const repository = new LedgerRepository(store);
  const publicComment = buildPublicComment();
  const post = options.post ?? buildPost(publicComment);
  const comment = options.comment ?? buildComment(publicComment);
  const parentPost =
    options.parentPost ??
    buildPost(publicComment, {
      id: 't3_parent',
    });
  const currentUser = {
    username: options.moderatorUsername ?? 'mod-a',
    getModPermissionsForSubreddit: vi.fn(
      async () => options.permissions ?? ['posts']
    ),
  };
  const reddit = {
    getPostById: vi.fn(async (id: string) =>
      id === 't3_parent' ? parentPost : post
    ),
    getCommentById: vi.fn(async () => comment),
    getCurrentUser: vi.fn(async () => currentUser),
    addModNote: vi.fn(async () => ({ id: 'mod-note-1' })),
    modMail: {
      createConversation: vi.fn(async () => ({
        conversation: { id: 'modmail-1' },
      })),
    },
  } as unknown as EnforcementSubmitRedditClient;

  return {
    store,
    repository,
    publicComment,
    post,
    comment,
    parentPost,
    reddit,
    dependencies: {
      repository,
      configRepository: { getConfig: vi.fn(async () => DEFAULT_CONFIG) },
      reddit,
      nowMs: () => nowMs,
      createEntryId: () => 'entry-1',
    },
  };
};

describe('handleEnforcementSubmit', () => {
  it('creates one ledger entry and applies side effects to the nonce target', async () => {
    const harness = createHarness();
    const updateLedgerEntry = vi.spyOn(harness.repository, 'updateLedgerEntry');
    await harness.repository.saveFormNonce(buildNonce());

    const response = await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      harness.dependencies
    );

    expect(response.showToast).toContain('Strike recorded');
    expect(updateLedgerEntry).toHaveBeenCalledTimes(6);
    expect(updateLedgerEntry.mock.calls[0]?.[0]).toMatchObject({
      publicCommentId: 't1_warning',
      sideEffects: { publicComment: 'succeeded' },
    });
    expect(updateLedgerEntry.mock.calls[1]?.[0]).toMatchObject({
      sideEffects: {
        publicCommentOptions: {
          distinguish: 'succeeded',
          lock: 'succeeded',
        },
      },
    });
    expect(updateLedgerEntry.mock.calls[2]?.[0]).toMatchObject({
      sideEffects: { remove: 'succeeded' },
    });
    expect(updateLedgerEntry.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'succeeded',
      userNoticeId: 'modmail-1',
    });
    expect(harness.post.addComment).toHaveBeenCalledTimes(1);
    expect(harness.post.remove).toHaveBeenCalledTimes(1);
    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toMatchObject({
      entryId: 'entry-1',
      targetId: 't3_target',
      userKey: 'id:t2_user',
      status: 'succeeded',
      publicCommentId: 't1_warning',
      modNoteId: 'mod-note-1',
      userNoticeId: 'modmail-1',
    });
  });

  it('uses the nonce author snapshot when the submit-time author disappeared', async () => {
    const publicComment = buildPublicComment();
    const post = buildPost(publicComment, {
      authorId: undefined,
      authorName: '[deleted]',
    });
    const harness = createHarness({ post });
    await harness.repository.saveFormNonce(buildNonce());

    await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      harness.dependencies
    );

    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toMatchObject({
      username: 'target-user',
      userKey: 'id:t2_user',
    });
  });

  it('blocks when the refetched target ID no longer matches the nonce', async () => {
    const publicComment = buildPublicComment();
    const post = buildPost(publicComment, { id: 't3_other' });
    const harness = createHarness({ post });
    await harness.repository.saveFormNonce(buildNonce());

    const response = await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      harness.dependencies
    );

    expect(response.showToast).toBe(
      'Selected content no longer matches this StrikeLedger form. Reopen the action.'
    );
    expect(post.addComment).not.toHaveBeenCalled();
    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toBeNull();
  });

  it('blocks when the refetched target kind does not match the nonce', async () => {
    const publicComment = buildPublicComment();
    const comment = buildComment(publicComment, { id: 't3_target' });
    const harness = createHarness({ comment });
    await harness.repository.saveFormNonce(
      buildNonce({
        targetId: 't3_target',
        targetKind: 'comment',
      })
    );

    const response = await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      harness.dependencies
    );

    expect(response.showToast).toBe(
      'Selected content no longer matches this StrikeLedger form. Reopen the action.'
    );
    expect(comment.reply).not.toHaveBeenCalled();
    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toBeNull();
  });

  it('blocks when the refetched target subreddit no longer matches the nonce', async () => {
    const publicComment = buildPublicComment();
    const post = buildPost(publicComment, { subredditName: 'othersub' });
    const harness = createHarness({ post });
    await harness.repository.saveFormNonce(buildNonce());

    const response = await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      harness.dependencies
    );

    expect(response.showToast).toBe(
      'Selected content no longer matches this StrikeLedger form. Reopen the action.'
    );
    expect(post.addComment).not.toHaveBeenCalled();
    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toBeNull();
  });

  it('blocks when the refetched author identity no longer matches the nonce', async () => {
    const publicComment = buildPublicComment();
    const post = buildPost(publicComment, {
      authorId: 't2_other',
      authorName: 'other-user',
    });
    const harness = createHarness({ post });
    await harness.repository.saveFormNonce(buildNonce());

    const response = await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      harness.dependencies
    );

    expect(response.showToast).toBe(
      'Selected content no longer matches this StrikeLedger form. Reopen the action.'
    );
    expect(post.addComment).not.toHaveBeenCalled();
    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toBeNull();
  });

  it('blocks a submission from a different moderator before ledger creation', async () => {
    const harness = createHarness({ moderatorUsername: 'mod-b' });
    await harness.repository.saveFormNonce(buildNonce());

    const response = await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      harness.dependencies
    );

    expect(response.showToast).toContain(
      'can only be submitted by the moderator who opened it'
    );
    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toBeNull();
  });

  it('blocks comments on locked parent posts before ledger creation', async () => {
    const publicComment = buildPublicComment();
    const parentPost = buildPost(publicComment, {
      id: 't3_parent',
      locked: true,
    });
    const harness = createHarness({ parentPost });
    await harness.repository.saveFormNonce(
      buildNonce({
        targetId: 't1_target',
        targetKind: 'comment',
      })
    );

    const response = await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      harness.dependencies
    );

    expect(response.showToast).toBe('Comments on locked posts cannot be warned.');
    expect(harness.comment.remove).not.toHaveBeenCalled();
    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toBeNull();
  });

  it('rejects public overrides that expose private placeholders', async () => {
    const harness = createHarness();
    await harness.repository.saveFormNonce(buildNonce());

    const response = await handleEnforcementSubmit(
      {
        formNonce: 'nonce-1',
        ruleId: 'rule-general',
        publicCommentOverride: 'Active total: {activeTotal}',
      },
      harness.dependencies
    );

    expect(response.showToast).toBe(
      'Public comment override contains a private or unsupported placeholder.'
    );
    expect(harness.post.addComment).not.toHaveBeenCalled();
    await expect(harness.repository.getLedgerEntry('entry-1')).resolves.toBeNull();
  });

  it('returns a moderator-facing message if the ledger transaction stays conflicted', async () => {
    const harness = createHarness();
    const repository = {
      getFormNonce: vi.fn(async () => buildNonce()),
      createLedgerEntry: vi.fn(async () => ({
        status: 'blocked' as const,
        reason: 'transaction_conflict' as const,
      })),
      updateLedgerEntry: vi.fn(async () => undefined),
    };

    const response = await handleEnforcementSubmit(
      { formNonce: 'nonce-1', ruleId: 'rule-general' },
      {
        ...harness.dependencies,
        repository,
      }
    );

    expect(response.showToast).toContain('busy saving this action');
    expect(harness.post.addComment).not.toHaveBeenCalled();
  });
});
