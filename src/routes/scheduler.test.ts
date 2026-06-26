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

class SchedulerRedisMock {
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

  async incrBy(key: string, value: number): Promise<number> {
    const current = Number(this.values.get(key) ?? '0');
    const next = Number.isFinite(current) ? current + value : value;
    this.values.set(key, String(next));
    return next;
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
    options: { reverse?: boolean; by?: 'rank' | 'score' } = {}
  ): Promise<RedisZMember[]> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return [];
    }

    const sortedMembers = Array.from(set.entries())
      .sort(([leftMember, leftScore], [rightMember, rightScore]) => {
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }

        return leftMember.localeCompare(rightMember);
      })
      .map(([member, score]) => ({ member, score }));
    const members =
      options.by === 'score'
        ? sortedMembers.filter(({ score }) => score >= start && score <= stop)
        : sortedMembers;

    if (options.reverse) {
      members.reverse();
    }

    if (options.by === 'score') {
      return members;
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
        return this.incrBy(key, value);
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

const buildEntry = (
  createdAtMs: number,
  overrides: Partial<LedgerEntry> = {}
): LedgerEntry => ({
  schemaVersion: SCHEMA_VERSION,
  entryId: 'old-inactive',
  subredditName: 'testsub',
  userId: 't2_user',
  username: 'target-user',
  userKey: 'id:t2_user',
  targetId: 't3_target',
  targetKind: 'post',
  targetPermalink: '/r/testsub/comments/target',
  action: 'warn',
  ruleId: 'rule-general',
  ruleLabel: 'Community rule violation',
  publicCommentOverrideUsed: false,
  originalPoints: 1,
  moderatorUsername: 'mod-a',
  createdAtMs,
  status: 'succeeded',
  duplicateKey: 'duplicate',
  moderatorRetryKey: 'retry',
  idempotencyInputs: {},
  formNonce: 'nonce-1',
  sideEffects: { ...EMPTY_SIDE_EFFECTS },
  ...overrides,
});

const loadScheduler = async () => {
  vi.resetModules();
  const redis = new SchedulerRedisMock();
  const reddit = {
    getCurrentSubreddit: vi.fn(async () => ({ name: 'testsub' })),
    getUserById: vi.fn(
      async (): Promise<{ id: string } | undefined> => ({ id: 't2_user' })
    ),
  };
  const settings = { getAll: vi.fn(async () => ({})) };

  vi.doMock('@devvit/web/server', () => ({ reddit, redis, settings }));
  const { schedulerRoutes } = await import('./scheduler');
  return { reddit, redis, schedulerRoutes };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler routes', () => {
  it('runs scheduled ledger cleanup with task data for the current subreddit', async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const oldMs = nowMs - 400 * 24 * 60 * 60 * 1000;
    const { reddit, redis, schedulerRoutes } = await loadScheduler();
    const entry = buildEntry(oldMs);

    await redis.set(`ledger_entry:${entry.entryId}`, JSON.stringify(entry));
    await redis.zAdd('user:id:t2_user:ledger', {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
    await redis.zAdd('target:t3_target:entries', {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
    await redis.zAdd('post:t3_target:entries', {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
    await redis.zAdd('ledger:testsub:entries', {
      member: entry.entryId,
      score: entry.createdAtMs,
    });

    const response = await schedulerRoutes.request('/ledger-cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ledgerCleanup',
        data: { retentionDays: 999999, maxEntries: 1 },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
    expect(reddit.getCurrentSubreddit).toHaveBeenCalled();
    expect(redis.values.has('ledger_entry:old-inactive')).toBe(true);
  });

  it('rejects scheduler requests for the wrong task name', async () => {
    const { reddit, redis, schedulerRoutes } = await loadScheduler();
    await redis.set('ledger_entry:old-inactive', JSON.stringify(buildEntry(0)));

    const response = await schedulerRoutes.request('/ledger-cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'otherTask' }),
    });

    expect(response.status).toBe(400);
    expect(reddit.getCurrentSubreddit).not.toHaveBeenCalled();
    expect(redis.values.has('ledger_entry:old-inactive')).toBe(true);
  });

  it('runs scheduled account deletion checks', async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const oldMs = nowMs - 2 * 24 * 60 * 60 * 1000;
    const { reddit, redis, schedulerRoutes } = await loadScheduler();
    const entry = buildEntry(oldMs);
    reddit.getUserById.mockResolvedValueOnce(undefined);

    await redis.set(`ledger_entry:${entry.entryId}`, JSON.stringify(entry));
    await redis.zAdd('user:id:t2_user:ledger', {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
    await redis.zAdd('target:t3_target:entries', {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
    await redis.zAdd('post:t3_target:entries', {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
    await redis.zAdd('ledger:testsub:entries', {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
    await redis.zAdd('users:tracked', {
      member: 't2_user',
      score: entry.createdAtMs,
    });

    const response = await schedulerRoutes.request('/account-deletion-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'accountDeletionCheck',
        data: {
          checkIntervalHours: 24,
          maxUsers: 5,
          maxEntriesPerUser: 10,
          maxEntriesPerRun: 10,
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
    expect(reddit.getUserById).toHaveBeenCalledWith('t2_user');
    expect(redis.values.has('ledger_entry:old-inactive')).toBe(false);
    expect(await redis.zRange('post:t3_target:entries', 0, -1)).toEqual([]);
    expect(await redis.zRange('users:tracked', 0, -1)).toEqual([]);
  });

  it('runs scheduled deleted-target scrub continuations', async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const oldMs = nowMs - 60_000;
    const deletedAtMs = nowMs - 30_000;
    const { redis, schedulerRoutes } = await loadScheduler();
    const firstEntry = buildEntry(oldMs, {
      entryId: 'entry-1',
      targetId: 't3_post',
      targetKind: 'post',
      targetPostId: 't3_post',
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
    const secondEntry = buildEntry(oldMs + 1, {
      entryId: 'entry-2',
      targetId: 't1_comment',
      targetKind: 'comment',
      targetPostId: 't3_post',
      targetPermalink: '/r/testsub/comments/target/_/comment',
    });

    await redis.set('ledger_entry:entry-1', JSON.stringify(firstEntry));
    await redis.set('ledger_entry:entry-2', JSON.stringify(secondEntry));
    await redis.zAdd('post:t3_post:entries', {
      member: 'entry-2',
      score: secondEntry.createdAtMs,
    });
    await redis.set(
      'target_delete_scrub:post:t3_post',
      JSON.stringify({
        targetId: 't3_post',
        targetKind: 'post',
        subredditName: 'testsub',
        deletedAtMs,
        cursor: 0,
        updatedAtMs: oldMs,
      })
    );
    await redis.zAdd('target_delete_scrub:pending', {
      member: 'target_delete_scrub:post:t3_post',
      score: oldMs,
    });

    const response = await schedulerRoutes.request('/target-delete-scrub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'targetDeleteScrub',
        data: {
          maxTargets: 1,
          maxEntriesPerTarget: 1,
          maxRuntimeMs: 1000,
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
    expect(
      JSON.parse(redis.values.get('ledger_entry:entry-2') ?? '{}')
    ).toMatchObject({
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
    expect(redis.values.has('target_delete_scrub:post:t3_post')).toBe(false);
    expect(await redis.zRange('target_delete_scrub:pending', 0, -1)).toEqual(
      []
    );
  });

  it('registers scheduled tasks in Devvit config', () => {
    const config = JSON.parse(readFileSync('devvit.json', 'utf8')) as {
      scheduler?: {
        tasks?: Record<
          string,
          {
            endpoint: string;
            cron?: string;
            data?: Record<string, number>;
          }
        >;
      };
    };

    expect(config.scheduler?.tasks?.ledgerCleanup).toEqual({
      endpoint: '/internal/scheduler/ledger-cleanup',
      cron: '17 * * * *',
      data: {
        retentionDays: 365,
        maxEntries: 2000,
        maxRuntimeMs: 10000,
      },
    });
    expect(config.scheduler?.tasks?.accountDeletionCheck).toEqual({
      endpoint: '/internal/scheduler/account-deletion-check',
      cron: '37 * * * *',
      data: {
        checkIntervalHours: 24,
        maxUsers: 50,
        maxEntriesPerUser: 200,
        maxEntriesPerRun: 1000,
        maxRuntimeMs: 10000,
      },
    });
    expect(config.scheduler?.tasks?.targetDeleteScrub).toEqual({
      endpoint: '/internal/scheduler/target-delete-scrub',
      cron: '47 * * * *',
      data: {
        maxTargets: 25,
        maxEntriesPerTarget: 200,
        maxRuntimeMs: 10000,
      },
    });
  });
});
