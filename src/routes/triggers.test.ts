import { afterEach, describe, expect, it, vi } from 'vitest';

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
}

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
  it('records post submissions and refreshes the cached score summary', async () => {
    const nowMs = Date.UTC(2026, 0, 31);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const { reddit, redis, triggers } = await loadTriggers();

    const response = await triggers.request('/on-post-submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'PostSubmit',
        subreddit: { name: 'testsub' },
        author: { id: 't2_user', name: 'TargetUser' },
        post: { id: 't3_new' },
      }),
    });

    expect(response.status).toBe(200);
    expect(reddit.getPostsByUser).toHaveBeenCalledWith({
      username: 'TargetUser',
      sort: 'new',
      limit: 1000,
      pageSize: 100,
    });
    expect(
      redis.sortedSets.get('user:id:t2_user:post_rate')?.get('t3_new')
    ).toBe(nowMs);

    const rawSummary = redis.values.get('user:id:t2_user:post_score_summary');
    expect(rawSummary).toBeDefined();
    expect(JSON.parse(rawSummary as string)).toMatchObject({
      subredditName: 'testsub',
      username: 'TargetUser',
      summary: {
        averagePostScore: 15,
        postScorePostCount: 2,
        postScoreWindowDays: 30,
      },
    });
  });
});
