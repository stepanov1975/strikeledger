import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMPTY_SIDE_EFFECTS,
  SCHEMA_VERSION,
  type LedgerEntry,
} from '../core/domain';

type RedisZMember = {
  member: string;
  score: number;
};

class TriggerRedisMock {
  readonly values = new Map<string, string>();
  readonly sortedSets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(
    key: string,
    value: string,
    _options: { expiration?: Date } = {}
  ): Promise<string> {
    this.values.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.values.delete(key);
      this.sortedSets.delete(key);
    }
  }

  async zAdd(key: string, member: RedisZMember): Promise<number> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(member.member, member.score);
    this.sortedSets.set(key, set);
    return 1;
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return 0;
    }

    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) {
        removed += 1;
      }
    }

    return removed;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options: { reverse?: boolean } = {}
  ): Promise<RedisZMember[]> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return [];
    }

    const members = Array.from(set.entries())
      .sort(([leftMember, leftScore], [rightMember, rightScore]) => {
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }

        return leftMember.localeCompare(rightMember);
      })
      .map(([member, score]) => ({ member, score }));

    if (options.reverse) {
      members.reverse();
    }

    const normalizedStop = stop < 0 ? members.length + stop : stop;
    if (normalizedStop < start) {
      return [];
    }

    return members.slice(start, normalizedStop + 1);
  }

  async watch() {
    let commandCount = 0;
    return {
      multi: vi.fn(async () => undefined),
      set: vi.fn(async (key: string, value: string) => {
        commandCount += 1;
        return this.set(key, value);
      }),
      del: vi.fn(async (...keys: string[]) => {
        commandCount += 1;
        return this.del(...keys);
      }),
      incrBy: vi.fn(async (key: string, value: number) => {
        commandCount += 1;
        const current = Number(this.values.get(key) ?? '0');
        const next = Number.isFinite(current) ? current + value : value;
        this.values.set(key, String(next));
        return next;
      }),
      zAdd: vi.fn(async (key: string, member: RedisZMember) => {
        commandCount += 1;
        return this.zAdd(key, member);
      }),
      zRem: vi.fn(async (key: string, members: string[]) => {
        commandCount += 1;
        return this.zRem(key, members);
      }),
      exec: vi.fn(async () => Array.from({ length: commandCount }, () => 'OK')),
      discard: vi.fn(async () => undefined),
      unwatch: vi.fn(async () => undefined),
    };
  }
}

const buildEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: SCHEMA_VERSION,
  entryId: overrides.entryId ?? 'entry-1',
  subredditName: overrides.subredditName ?? 'testsub',
  username: overrides.username ?? 'target-user',
  userKey: overrides.userKey ?? 'id:t2_user',
  targetId: overrides.targetId ?? 't3_target',
  targetKind: overrides.targetKind ?? 'post',
  targetPermalink: overrides.targetPermalink ?? '/r/testsub/comments/target',
  action: overrides.action ?? 'warn',
  ruleId: overrides.ruleId ?? 'rule-general',
  ruleLabel: overrides.ruleLabel ?? 'Community rule violation',
  publicCommentOverrideUsed: overrides.publicCommentOverrideUsed ?? false,
  originalPoints: overrides.originalPoints ?? 1,
  moderatorUsername: overrides.moderatorUsername ?? 'mod-a',
  createdAtMs: overrides.createdAtMs ?? Date.UTC(2026, 0, 1),
  status: overrides.status ?? 'succeeded',
  duplicateKey: overrides.duplicateKey ?? 'duplicate',
  moderatorRetryKey: overrides.moderatorRetryKey ?? 'retry',
  idempotencyInputs: overrides.idempotencyInputs ?? {},
  formNonce: overrides.formNonce ?? 'nonce-1',
  sideEffects: overrides.sideEffects ?? { ...EMPTY_SIDE_EFFECTS },
  ...(overrides.targetPostId !== undefined
    ? { targetPostId: overrides.targetPostId }
    : {}),
  ...(overrides.targetDeletedAtMs !== undefined
    ? { targetDeletedAtMs: overrides.targetDeletedAtMs }
    : {}),
});

const seedEntry = async (
  redis: TriggerRedisMock,
  entry: LedgerEntry
): Promise<void> => {
  await redis.set(`ledger_entry:${entry.entryId}`, JSON.stringify(entry));
  await redis.zAdd(`user:${entry.userKey}:ledger`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
  await redis.zAdd(`target:${entry.targetId}:entries`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
  if (entry.targetPostId) {
    await redis.zAdd(`post:${entry.targetPostId}:entries`, {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
  }
  await redis.zAdd(`ledger:${entry.subredditName.toLowerCase()}:entries`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
};

const buildAsyncListing = <T>(items: T[]) => ({
  all: vi.fn(async () => items),
  get: vi.fn(async (count: number) => items.slice(0, count)),
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      yield item;
    }
  },
});

const loadTriggers = async () => {
  vi.resetModules();
  const redis = new TriggerRedisMock();
  const reddit = {
    getPostsByUser: vi.fn(() =>
      buildAsyncListing([
        {
          subredditName: 'testsub',
          createdAt: new Date(Date.UTC(2026, 0, 30)),
          score: 12,
        },
        {
          subredditName: 'testsub',
          createdAt: new Date(Date.UTC(2026, 0, 29)),
          score: 18,
        },
      ])
    ),
  };
  const settings = { getAll: vi.fn(async () => ({})) };

  vi.doMock('@devvit/web/server', () => ({ reddit, redis, settings }));
  const { triggers } = await import('./triggers');
  return { reddit, redis, triggers };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('trigger routes', () => {
  it('keeps event trigger placeholders as no-ops until functionality exists', async () => {
    const nowMs = Date.UTC(2026, 0, 31);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const { reddit, redis, triggers } = await loadTriggers();

    for (const endpoint of [
      '/on-post-submit',
      '/on-post-create',
      '/on-post-update',
      '/on-post-flair-update',
      '/on-post-nsfw-update',
      '/on-post-spoiler-update',
      '/on-mod-action',
    ]) {
      const response = await triggers.request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: endpoint,
          subreddit: { name: 'testsub' },
          author: { id: 't2_user', name: 'TargetUser' },
          post: { id: 't3_new' },
        }),
      });

      await expect(response.json()).resolves.toEqual({ status: 'success' });
      expect(response.status).toBe(200);
    }

    expect(reddit.getPostsByUser).not.toHaveBeenCalled();
    expect(redis.sortedSets.size).toBe(0);
    expect(redis.values.size).toBe(0);
  });

  it('scrubs deleted post targets and indexed comment targets', async () => {
    const { redis, triggers } = await loadTriggers();
    const deletedAtMs = Date.UTC(2026, 0, 31);
    const postEntry = buildEntry({
      entryId: 'post-entry',
      targetId: 't3_post',
      targetKind: 'post',
      targetPostId: 't3_post',
      targetPermalink: '/r/testsub/comments/post_title',
    });
    const commentEntry = buildEntry({
      entryId: 'comment-entry',
      targetId: 't1_comment',
      targetKind: 'comment',
      targetPostId: 't3_post',
      targetPermalink: '/r/testsub/comments/post_title/_/comment',
    });
    await seedEntry(redis, postEntry);
    await seedEntry(redis, commentEntry);

    const response = await triggers.request('/on-post-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'PostDelete',
        postId: 't3_post',
        deletedAt: new Date(deletedAtMs).toISOString(),
        subreddit: { name: 'testsub' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'success' });
    expect(
      JSON.parse(redis.values.get('ledger_entry:post-entry') ?? '{}')
    ).toMatchObject({
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
    expect(
      JSON.parse(redis.values.get('ledger_entry:comment-entry') ?? '{}')
    ).toMatchObject({
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
  });

  it('scrubs deleted comment targets', async () => {
    const { redis, triggers } = await loadTriggers();
    const deletedAtMs = Date.UTC(2026, 0, 31);
    const entry = buildEntry({
      entryId: 'comment-entry',
      targetId: 't1_comment',
      targetKind: 'comment',
      targetPostId: 't3_post',
      targetPermalink: '/r/testsub/comments/post_title/_/comment',
    });
    await seedEntry(redis, entry);

    const response = await triggers.request('/on-comment-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'CommentDelete',
        commentId: 't1_comment',
        postId: 't3_post',
        deletedAt: new Date(deletedAtMs).toISOString(),
        subreddit: { name: 'testsub' },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'success' });
    expect(
      JSON.parse(redis.values.get('ledger_entry:comment-entry') ?? '{}')
    ).toMatchObject({
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
  });

  it('registers placeholder triggers in Devvit config', () => {
    const config = JSON.parse(readFileSync('devvit.json', 'utf8')) as {
      triggers?: Record<string, string>;
    };

    expect(config.triggers).toEqual({
      onAppInstall: '/internal/triggers/on-app-install',
      onCommentDelete: '/internal/triggers/on-comment-delete',
      onModAction: '/internal/triggers/on-mod-action',
      onPostCreate: '/internal/triggers/on-post-create',
      onPostDelete: '/internal/triggers/on-post-delete',
      onPostFlairUpdate: '/internal/triggers/on-post-flair-update',
      onPostNsfwUpdate: '/internal/triggers/on-post-nsfw-update',
      onPostSpoilerUpdate: '/internal/triggers/on-post-spoiler-update',
      onPostSubmit: '/internal/triggers/on-post-submit',
      onPostUpdate: '/internal/triggers/on-post-update',
    });
  });
});
