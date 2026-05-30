import { describe, expect, it, vi } from 'vitest';
import { EMPTY_SIDE_EFFECTS, SCHEMA_VERSION, type LedgerEntry } from '../core/domain';

type RedisZMember = {
  member: string;
  score: number;
};

class ApiRedisMock {
  readonly values = new Map<string, string>();
  readonly sortedSets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<string> {
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
  createdAtMs: Date.now(),
  status: 'succeeded',
  idempotencyKey: 'retry',
  duplicateKey: 'duplicate',
  moderatorRetryKey: 'retry',
  idempotencyInputs: {},
  formNonce: 'nonce-1',
  sideEffects: { ...EMPTY_SIDE_EFFECTS, publicComment: 'succeeded' },
  ...overrides,
});

const loadApi = async (
  permissions: string[] | null,
  options: { listedModerator?: boolean } = {}
) => {
  vi.resetModules();
  const redis = new ApiRedisMock();
  const user =
    permissions === null
      ? null
      : {
          username: 'mod-a',
          getModPermissionsForSubreddit: vi.fn(async () => permissions),
        };
  const reddit = {
    getCurrentSubreddit: vi.fn(async () => ({ name: 'testsub' })),
    getCurrentUser: vi.fn(async () => user),
    getModerators: vi.fn(() => ({
      all: vi.fn(async () =>
        options.listedModerator && user
          ? [{ username: user.username }]
          : []
      ),
    })),
  };

  vi.doMock('@devvit/web/server', () => ({ reddit, redis }));
  const { api } = await import('./api');
  return { api, reddit, redis };
};

const seedViewContext = async (redis: ApiRedisMock) => {
  await redis.set(
    'view_context:token-1',
    JSON.stringify({
      token: 'token-1',
      targetId: 't3_target',
      targetKind: 'post',
      subredditName: 'testsub',
      userKey: 'id:t2_user',
      authorId: 't2_user',
      authorName: 'target-user',
      createdAtMs: Date.UTC(2026, 0, 1),
      expiresAtMs: Date.UTC(2026, 0, 1) + 15 * 60 * 1000,
    })
  );
};

const seedLedger = async (redis: ApiRedisMock, entry = buildEntry()) => {
  await redis.set(`ledger_entry:${entry.entryId}`, JSON.stringify(entry));
  await redis.zAdd(`user:${entry.userKey}:ledger`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
};

describe('api routes', () => {
  it('rejects non-moderators', async () => {
    const { api } = await loadApi(null);

    const response = await api.request('/settings');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'moderator_required',
    });
  });

  it('reads settings for moderators', async () => {
    const { api } = await loadApi(['posts']);

    const response = await api.request('/settings');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      subredditName: 'testsub',
      canManage: false,
      config: {
        revision: 1,
      },
    });
  });

  it('allows read APIs for listed moderators with no explicit permissions', async () => {
    const { api } = await loadApi([], { listedModerator: true });

    const response = await api.request('/settings');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      canManage: false,
    });
  });

  it('reads history from a server-side view context token', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis);
    await seedLedger(redis);

    const response = await api.request('/history?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      activeTotal: 3,
      entries: [
        {
          entryId: 'entry-1',
          activePoints: 3,
        },
      ],
    });
    expect(redis.values.get('user:id:t2_user:active_total')).toBe('3');
  });

  it('reads profile summaries from a server-side view context token', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis);
    await seedLedger(redis);

    const response = await api.request('/profile?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      summary: {
        activeTotal: 3,
        lifetimeOriginalPoints: 3,
        reversedEntries: 0,
        removalsByRule: {
          'Community rule violation': 1,
        },
      },
      recentEntries: [
        {
          entryId: 'entry-1',
        },
      ],
    });
  });

  it('normalizes username input when recalculating a user total', async () => {
    const { api, redis } = await loadApi(['all']);
    const entry = buildEntry({
      userKey: 'name:someuser',
      username: 'SomeUser',
    });
    await seedLedger(redis, entry);

    const response = await api.request('/recalculate-user-total', {
      method: 'POST',
      body: JSON.stringify({ username: 'u/SomeUser' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      userKey: 'name:someuser',
      activeTotal: 3,
    });
  });

  it('requires posts or all permission for reversal', async () => {
    const { api, redis } = await loadApi(['wiki']);
    await seedLedger(redis);

    const response = await api.request('/reverse', {
      method: 'POST',
      body: JSON.stringify({
        entryId: 'entry-1',
        reversalReason: 'issued in error',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'posts_permission_required',
    });
  });
});
