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

const buildEntry = (createdAtMs: number): LedgerEntry => ({
  schemaVersion: SCHEMA_VERSION,
  entryId: 'old-inactive',
  subredditName: 'testsub',
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
});

const loadScheduler = async () => {
  vi.resetModules();
  const redis = new SchedulerRedisMock();
  const reddit = {
    getCurrentSubreddit: vi.fn(async () => ({ name: 'testsub' })),
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
  it('runs scheduled ledger cleanup for the current subreddit', async () => {
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
    expect(redis.values.has('ledger_entry:old-inactive')).toBe(false);
  });

  it('registers the scheduled cleanup task in Devvit config', () => {
    const config = JSON.parse(readFileSync('devvit.json', 'utf8')) as {
      scheduler?: {
        tasks?: Record<string, { endpoint: string; cron?: string }>;
      };
    };

    expect(config.scheduler?.tasks?.ledgerCleanup).toEqual({
      endpoint: '/internal/scheduler/ledger-cleanup',
      cron: '17 * * * *',
    });
  });
});
