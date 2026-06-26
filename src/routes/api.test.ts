import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SIDE_EFFECTS,
  SCHEMA_VERSION,
  type LedgerEntry,
  type StrikeLedgerConfig,
} from '../core/domain';

type RedisZMember = {
  member: string;
  score: number;
};

type PostScoreMock = {
  subredditName: string;
  createdAt: Date;
  score: number;
};

type RedisSetMockOptions = {
  expiration?: Date;
  expiresAtMs?: number;
};

class ApiRedisMock {
  readonly values = new Map<string, string>();
  readonly expiresAtMs = new Map<string, number>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly setCalls: Array<{ key: string; value: string }> = [];
  readonly zRangeCalls: Array<{
    key: string;
    start: number;
    stop: number;
    options: { reverse?: boolean };
  }> = [];

  async get(key: string): Promise<string | undefined> {
    const expiresAtMs = this.expiresAtMs.get(key);
    if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
      this.values.delete(key);
      this.expiresAtMs.delete(key);
      return undefined;
    }

    return this.values.get(key);
  }

  async set(
    key: string,
    value: string,
    options: RedisSetMockOptions = {}
  ): Promise<string> {
    this.setCalls.push({ key, value });
    this.values.set(key, value);
    const expiresAtMs =
      options.expiresAtMs ?? options.expiration?.getTime() ?? null;
    if (expiresAtMs === null) {
      this.expiresAtMs.delete(key);
    } else {
      this.expiresAtMs.set(key, expiresAtMs);
    }
    return 'OK';
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.values.delete(key);
      this.expiresAtMs.delete(key);
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

  async zRem(key: string, members: string[]): Promise<void> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return;
    }

    for (const member of members) {
      set.delete(member);
    }
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options: { reverse?: boolean } = {}
  ): Promise<RedisZMember[]> {
    this.zRangeCalls.push({ key, start, stop, options });
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
      set: vi.fn(
        async (key: string, value: string, options?: RedisSetMockOptions) => {
          commandCount += 1;
          return this.set(key, value, options);
        }
      ),
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
  createdAtMs: Date.now(),
  status: 'succeeded',
  duplicateKey: 'duplicate',
  moderatorRetryKey: 'retry',
  idempotencyInputs: {},
  formNonce: 'nonce-1',
  sideEffects: { ...EMPTY_SIDE_EFFECTS, publicComment: 'succeeded' },
  ...overrides,
});

const loadApi = async (
  permissions: string[] | null,
  options: {
    listedModerator?: boolean;
    redditRules?: Array<{
      shortName: string;
      description: string;
      kind: string;
      violationReason: string;
      priority: number;
    }>;
    nativeSettings?: Record<string, unknown>;
    postsByUser?: PostScoreMock[];
    targetPost?: Record<string, unknown>;
    targetComment?: Record<string, unknown>;
  } = {}
) => {
  vi.resetModules();
  const redis = new ApiRedisMock();
  const user =
    permissions === null
      ? null
      : {
          id: 't2_mod_a',
          username: 'mod-a',
          getModPermissionsForSubreddit: vi.fn(async () => permissions),
        };
  const reddit = {
    getCurrentSubreddit: vi.fn(async () => ({ name: 'testsub' })),
    getCurrentUser: vi.fn(async () => user),
    getUserByUsername: vi.fn(async (username: string) => ({
      id: `t2_${username.toLowerCase().replace(/[^a-z0-9_]/g, '')}`,
      username,
    })),
    getUserById: vi.fn(
      async (
        userId: string
      ): Promise<{ id: string; username: string } | undefined> => ({
        id: userId,
        username: userId.replace(/^t2_/, ''),
      })
    ),
    getModerators: vi.fn(() => ({
      all: vi.fn(async () =>
        options.listedModerator && user ? [{ username: user.username }] : []
      ),
    })),
    getRules: vi.fn(async () => options.redditRules ?? []),
    getPostsByUser: vi.fn(() => buildAsyncListing(options.postsByUser ?? [])),
    getPostById: vi.fn(
      async () =>
        options.targetPost ?? {
          id: 't3_target',
          subredditName: 'testsub',
          authorId: 't2_user',
          authorName: 'target-user',
          permalink: '/r/testsub/comments/target',
          locked: false,
          removed: false,
          nsfw: false,
          addComment: vi.fn(async () => ({
            id: 't1_warning',
            distinguish: vi.fn(async () => undefined),
            lock: vi.fn(async () => undefined),
          })),
          remove: vi.fn(async () => undefined),
          markAsNsfw: vi.fn(async () => undefined),
        }
    ),
    getCommentById: vi.fn(
      async () =>
        options.targetComment ?? {
          id: 't1_target',
          postId: 't3_target',
          subredditName: 'testsub',
          authorId: 't2_user',
          authorName: 'target-user',
          permalink: '/r/testsub/comments/target/_/comment',
          locked: false,
          removed: false,
          reply: vi.fn(async () => ({
            id: 't1_warning',
            distinguish: vi.fn(async () => undefined),
            lock: vi.fn(async () => undefined),
          })),
          remove: vi.fn(async () => undefined),
        }
    ),
    addModNote: vi.fn(async () => ({ id: 'mod-note-1' })),
    modMail: {
      createConversation: vi.fn(async () => ({
        conversation: { id: 'conversation-1' },
      })),
    },
  };
  const settings = {
    getAll: vi.fn(async () => options.nativeSettings ?? {}),
  };

  vi.doMock('@devvit/web/server', () => ({ reddit, redis, settings }));
  const { api } = await import('./api');
  return { api, reddit, redis, settings };
};

const seedViewContext = async (
  redis: ApiRedisMock,
  overrides: Record<string, unknown> = {}
) => {
  const createdAtMs =
    typeof overrides.createdAtMs === 'number'
      ? overrides.createdAtMs
      : Date.now();
  const expiresAtMs =
    typeof overrides.expiresAtMs === 'number'
      ? overrides.expiresAtMs
      : createdAtMs + 15 * 60 * 1000;
  const record = {
    token: 'token-1',
    targetId: 't3_target',
    targetKind: 'post',
    subredditName: 'testsub',
    userKey: 'id:t2_user',
    authorId: 't2_user',
    authorName: 'target-user',
    createdAtMs,
    expiresAtMs,
    ...overrides,
  };

  await redis.set(
    `view_context:${String(overrides.token ?? 'token-1')}`,
    JSON.stringify(record),
    { expiresAtMs }
  );
};

const seedLedger = async (redis: ApiRedisMock, entry = buildEntry()) => {
  await redis.set(`ledger_entry:${entry.entryId}`, JSON.stringify(entry));
  await redis.zAdd(`user:${entry.userKey}:ledger`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
  await redis.zAdd(`target:${entry.targetId}:entries`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
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

  it('marks bootstrap responses without pending menu launches', async () => {
    const { api } = await loadApi(['posts']);

    const response = await api.request('/bootstrap');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      view: 'settings',
      hasPendingBootstrap: false,
    });
  });

  it('returns limited bootstrap information for logged-in non-moderators', async () => {
    const { api } = await loadApi([]);

    const response = await api.request('/bootstrap');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      view: 'limited',
      subredditName: 'testsub',
      currentUsername: 'mod-a',
      hasPendingBootstrap: false,
    });
  });

  it('marks bootstrap responses that consume pending menu launches', async () => {
    const { api, redis } = await loadApi(['posts']);
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/bootstrap');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      view: 'profile',
      contextToken: 'view-token',
      hasPendingBootstrap: true,
    });
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(false);
  });

  it('ignores expired pending dashboard bootstrap records', async () => {
    const { api, redis } = await loadApi(['posts']);
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now() - 16 * 60 * 1000,
        expiresAtMs: Date.now() - 1,
      })
    );

    const response = await api.request('/bootstrap');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      view: 'settings',
      hasPendingBootstrap: false,
    });
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(false);
  });

  it('returns inline profile preview without consuming pending profile launches', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis, { token: 'view-token' });
    await seedLedger(redis);
    await redis.set('user:id:t2_user:active_total', '3');
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/inline-profile-preview');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'available',
      contextToken: 'view-token',
      context: {
        userKey: 'id:t2_user',
        authorName: 'target-user',
      },
      summary: {
        activeTotal: 3,
        originalPoints: 3,
        reversedEntries: 0,
      },
    });
    expect(body).not.toHaveProperty('recentEntries');
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(true);

    const bootstrapResponse = await api.request('/bootstrap');
    await expect(bootstrapResponse.json()).resolves.toMatchObject({
      view: 'profile',
      contextToken: 'view-token',
      hasPendingBootstrap: true,
    });
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(false);
  });

  it('uses cached active total for inline profile preview without recalculating totals', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis, { token: 'view-token' });
    await seedLedger(redis);
    await redis.set('user:id:t2_user:active_total', '9');
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/inline-profile-preview');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'available',
      summary: {
        activeTotal: 9,
      },
    });
    expect(
      redis.setCalls.filter(
        (call) => call.key === 'user:id:t2_user:active_total'
      )
    ).toHaveLength(1);
    expect(
      redis.zRangeCalls
        .filter((call) => call.key === 'user:id:t2_user:ledger')
        .every((call) => call.stop <= 25)
    ).toBe(true);
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(true);
  });

  it('keeps inline profile preview to one raw ledger page when other subreddits dominate', async () => {
    const { api, redis } = await loadApi(['posts']);
    const baseMs = Date.now();
    await seedViewContext(redis, { token: 'view-token' });
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'current-subreddit-entry',
        createdAtMs: baseMs,
      })
    );
    for (let index = 0; index < 40; index += 1) {
      await seedLedger(
        redis,
        buildEntry({
          entryId: `other-subreddit-entry-${index}`,
          subredditName: 'othersub',
          targetId: `t3_other_${index}`,
          targetPermalink: `/r/othersub/comments/other_${index}`,
          originalPoints: 99,
          createdAtMs: baseMs + index + 1,
        })
      );
    }
    await redis.set('user:id:t2_user:active_total', '3');
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/inline-profile-preview');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'available',
      summary: {
        activeTotal: 3,
        originalPoints: 0,
        hasMoreEntries: true,
      },
    });
    expect(
      redis.zRangeCalls.filter((call) => call.key === 'user:id:t2_user:ledger')
    ).toEqual([
      expect.objectContaining({
        start: 0,
        stop: 25,
      }),
    ]);
  });

  it('returns inline history launch state without consuming pending history launches', async () => {
    const { api, redis } = await loadApi(['posts']);
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'history',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/inline-profile-preview');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'history',
      contextToken: 'view-token',
    });
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(true);
  });

  it('does not expose inline profile preview data to non-moderators', async () => {
    const { api, redis } = await loadApi([]);
    await seedViewContext(redis, { token: 'view-token' });
    await seedLedger(redis);
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/inline-profile-preview');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'unavailable',
      subredditName: 'testsub',
      currentUsername: 'mod-a',
    });
    expect(body).not.toHaveProperty('moderatorUsername');
    expect(body).not.toHaveProperty('contextToken');
    expect(body).not.toHaveProperty('context');
    expect(body).not.toHaveProperty('summary');
    expect(body).not.toHaveProperty('recentEntries');
  });

  it('falls back when inline profile preview cache is unavailable', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis, { token: 'view-token' });
    await seedLedger(redis);
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/inline-profile-preview');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'unavailable',
      subredditName: 'testsub',
      currentUsername: 'mod-a',
      moderatorUsername: 'mod-a',
    });
    expect(body).not.toHaveProperty('contextToken');
    expect(body).not.toHaveProperty('context');
    expect(body).not.toHaveProperty('summary');
    expect(
      redis.zRangeCalls.filter((call) => call.key === 'user:id:t2_user:ledger')
    ).toHaveLength(0);
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(true);
  });

  it('falls back when inline profile preview context is expired', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis, {
      token: 'view-token',
      createdAtMs: Date.now() - 16 * 60 * 1000,
      expiresAtMs: Date.now() - 1,
    });
    await seedLedger(redis);
    await redis.set('user:id:t2_user:active_total', '3');
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/inline-profile-preview');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'unavailable',
      subredditName: 'testsub',
      currentUsername: 'mod-a',
      moderatorUsername: 'mod-a',
    });
    expect(body).not.toHaveProperty('contextToken');
    expect(body).not.toHaveProperty('context');
    expect(body).not.toHaveProperty('summary');
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(true);
  });

  it('keeps inline profile preview scoped to the ID-key context', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis, { token: 'view-token' });
    await seedLedger(
      redis,
      buildEntry({
        userKey: 'name:target-user',
        username: 'TargetUser',
      })
    );
    await redis.set('user:id:t2_user:active_total', '3');
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/inline-profile-preview');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'available',
      summary: {
        activeTotal: 3,
        originalPoints: 0,
      },
    });
  });

  it('keeps listed moderators with no explicit permissions on moderator bootstrap', async () => {
    const { api, redis } = await loadApi([], { listedModerator: true });
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60 * 1000,
      })
    );

    const response = await api.request('/bootstrap');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      view: 'profile',
      moderatorUsername: 'mod-a',
      currentUsername: 'mod-a',
      contextToken: 'view-token',
      hasPendingBootstrap: true,
    });
    expect(redis.values.has('dashboard_bootstrap:testsub:mod-a')).toBe(false);
  });

  it('reads scalar runtime config from native install settings', async () => {
    const { api, settings } = await loadApi(['posts'], {
      nativeSettings: {
        warnPoints: 2,
        decayIntervalDays: 14,
        userNoticesEnabled: false,
      },
    });

    const response = await api.request('/settings');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(settings.getAll).toHaveBeenCalled();
    expect(body.config).toMatchObject({
      actionPoints: expect.objectContaining({ warn: 2 }),
      decayIntervalDays: 14,
      userNoticesEnabled: false,
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

  it('imports current subreddit rules as a flat ordered preview', async () => {
    const { api, reddit } = await loadApi(['all'], {
      redditRules: [
        {
          shortName: 'Rule 2: Spam',
          description: 'No spam.',
          kind: 'all',
          violationReason: 'Spam',
          priority: 2,
        },
        {
          shortName: 'Rule 1: Personal attacks',
          description: 'No attacks.',
          kind: 'comment',
          violationReason: 'Personal attacks',
          priority: 1,
        },
      ],
    });

    const response = await api.request('/settings/reddit-rules');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(reddit.getRules).toHaveBeenCalledWith('testsub');
    expect(body).toEqual({
      subredditName: 'testsub',
      rules: [
        {
          id: 'rule-1',
          label: 'Rule 1 - Personal attacks',
          redditShortName: 'Rule 1: Personal attacks',
          description: 'No attacks.',
          kind: 'comment',
          violationReason: 'Personal attacks',
          priority: 1,
          enabled: true,
        },
        {
          id: 'rule-2',
          label: 'Rule 2 - Spam',
          redditShortName: 'Rule 2: Spam',
          description: 'No spam.',
          kind: 'all',
          violationReason: 'Spam',
          priority: 2,
          enabled: true,
        },
      ],
    });
  });

  it('requires all permission to import subreddit rules', async () => {
    const { api } = await loadApi(['posts']);

    const response = await api.request('/settings/reddit-rules');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'all_permission_required',
    });
  });

  it('reads compact self summary for logged-in non-moderators', async () => {
    const { api, redis } = await loadApi([]);
    const createdAtMs = Date.now();
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'self-entry',
        userKey: 'id:t2_mod_a',
        username: 'mod-a',
        ruleLabel: 'Rule 1 - Spam',
        originalPoints: 3,
        createdAtMs,
      })
    );
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'other-subreddit-entry',
        subredditName: 'othersub',
        userKey: 'id:t2_mod_a',
        username: 'mod-a',
        originalPoints: 99,
        createdAtMs: createdAtMs + 1,
      })
    );
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'other-user-entry',
        userKey: 'id:t2_other',
        username: 'other-user',
        originalPoints: 99,
        createdAtMs: createdAtMs + 2,
      })
    );

    const response = await api.request('/self-summary');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      subredditName: 'testsub',
      username: 'mod-a',
      activeTotal: 3,
      entries: [
        {
          createdAtMs,
          ruleLabel: 'Rule 1 - Spam',
          activePoints: 3,
        },
      ],
    });
  });

  it('reads current-subreddit self history past newer entries from another subreddit', async () => {
    const { api, redis } = await loadApi([]);
    const createdAtMs = Date.now();
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'self-entry',
        userKey: 'id:t2_mod_a',
        username: 'mod-a',
        ruleLabel: 'Rule 1 - Spam',
        originalPoints: 3,
        createdAtMs,
      })
    );
    for (let index = 0; index < 25; index += 1) {
      await seedLedger(
        redis,
        buildEntry({
          entryId: `other-subreddit-entry-${index}`,
          subredditName: 'othersub',
          userKey: 'id:t2_mod_a',
          username: 'mod-a',
          targetId: `t3_other_${index}`,
          originalPoints: 99,
          createdAtMs: createdAtMs + index + 1,
        })
      );
    }

    const response = await api.request('/self-summary');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.activeTotal).toBe(3);
    expect(body.entries).toEqual([
      {
        createdAtMs,
        ruleLabel: 'Rule 1 - Spam',
        activePoints: 3,
      },
    ]);
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

  it('rejects history offsets beyond the bounded review window', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis);

    const response = await api.request(
      '/history?contextToken=token-1&offset=100000'
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_offset',
    });
  });

  it('does not read username-key legacy ledger entries for ID-key history contexts', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis);
    await seedLedger(
      redis,
      buildEntry({
        userKey: 'name:target-user',
        username: 'TargetUser',
      })
    );

    const response = await api.request('/history?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      activeTotal: 0,
      entries: [],
    });
    expect(redis.values.get('user:id:t2_user:active_total')).toBe('0');
  });

  it('filters history entries and totals to the current subreddit', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis);
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'entry-current',
        originalPoints: 3,
      })
    );
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'entry-other',
        subredditName: 'othersub',
        targetId: 't3_other',
        targetPermalink: '/r/othersub/comments/other',
        originalPoints: 99,
      })
    );

    const response = await api.request('/history?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.activeTotal).toBe(3);
    expect(body.entries).toEqual([
      expect.objectContaining({ entryId: 'entry-current' }),
    ]);
    expect(redis.values.get('user:id:t2_user:active_total')).toBe('3');
  });

  it('reads history by username for moderator dashboard lookup', async () => {
    const { api, reddit, redis } = await loadApi(['all']);
    const entry = buildEntry({
      userId: 't2_someuser',
      userKey: 'id:t2_someuser',
      username: 'SomeUser',
    });
    await seedLedger(redis, entry);

    const response = await api.request('/history?username=u%2FSomeUser');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      context: {
        userKey: 'id:t2_someuser',
        authorName: 'SomeUser',
      },
      activeTotal: 3,
      entries: [{ entryId: 'entry-1' }],
    });
    expect(reddit.getUserByUsername).toHaveBeenCalledWith('SomeUser');
  });

  it('reads target-only history from a server-side view context token', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis, {
      userKey: undefined,
      authorId: undefined,
      authorName: undefined,
    });
    await seedLedger(redis);

    const response = await api.request('/history?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      context: {
        targetId: 't3_target',
        targetKind: 'post',
      },
      activeTotal: 0,
      entries: [{ entryId: 'entry-1' }],
    });
  });

  it('does not advertise history pages beyond the bounded review window', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis, {
      userKey: undefined,
      authorId: undefined,
      authorName: undefined,
    });
    const baseMs = Date.UTC(2026, 0, 1);
    for (let index = 0; index < 525; index += 1) {
      await seedLedger(
        redis,
        buildEntry({
          entryId: `entry-${index}`,
          targetId: 't3_target',
          formNonce: `nonce-${index}`,
          createdAtMs: baseMs + index,
        })
      );
    }

    const response = await api.request(
      '/history?contextToken=token-1&offset=500'
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.entries).toHaveLength(25);
    expect(body.nextOffset).toBeNull();
  });

  it('rejects raw history lookups for read-only moderators', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedLedger(
      redis,
      buildEntry({
        userId: 't2_someuser',
        userKey: 'id:t2_someuser',
        username: 'SomeUser',
      })
    );

    const response = await api.request('/history?username=u%2FSomeUser');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'all_permission_required',
    });
  });

  it('does not expose the retired full profile API', async () => {
    const { api, reddit, redis } = await loadApi(['all']);
    await seedViewContext(redis);
    await seedLedger(redis);

    const contextResponse = await api.request('/profile?contextToken=token-1');
    const lookupResponse = await api.request('/profile?userKey=id:t2_deleted');

    expect(contextResponse.status).toBe(404);
    expect(lookupResponse.status).toBe(404);
    expect(reddit.getUserById).not.toHaveBeenCalled();
  });

  it('exposes compact settings audit records to settings managers', async () => {
    const { api } = await loadApi(['all']);

    const settingsResponse = await api.request('/settings');
    const settingsBody = await settingsResponse.json();
    const nextConfig = {
      ...settingsBody.config,
      rules: settingsBody.config.rules.map((rule: Record<string, unknown>) =>
        rule.id === 'rule-general'
          ? { ...rule, label: 'Rule 1 - General violation' }
          : rule
      ),
    };
    const saveResponse = await api.request('/settings', {
      method: 'POST',
      body: JSON.stringify({
        revision: settingsBody.config.revision,
        config: nextConfig,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(saveResponse.status).toBe(200);

    const response = await api.request('/settings/audit');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records).toEqual([
      expect.objectContaining({
        moderatorUsername: 'mod-a',
        changedFields: ['rules'],
      }),
    ]);
    expect(body.records[0]).not.toHaveProperty('beforeConfig');
  });

  it('allows ordinary moderators to read compact settings audit records', async () => {
    const { api, redis } = await loadApi(['posts']);
    const timestampMs = Date.UTC(2026, 0, 1);
    const auditKey = `settings_audit:${timestampMs}:mod-a`;
    const snapshotKey = `settings_audit_snapshot:${timestampMs}:mod-a`;
    await redis.set(
      auditKey,
      JSON.stringify({
        moderatorUsername: 'mod-a',
        timestampMs,
        changedFields: ['rules'],
        beforeHash: 'before',
        afterHash: 'after',
      })
    );
    await redis.set(
      snapshotKey,
      JSON.stringify({
        auditKey,
        beforeConfig: '{}',
        afterConfig: '{}',
      })
    );
    await redis.zAdd('settings_audit_snapshots', {
      member: snapshotKey,
      score: timestampMs,
    });

    const response = await api.request('/settings/audit');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.records).toEqual([
      expect.objectContaining({
        moderatorUsername: 'mod-a',
        changedFields: ['rules'],
      }),
    ]);
  });

  it('rejects settings saves when the config revision differs from the request revision', async () => {
    const { api } = await loadApi(['all']);

    const settingsResponse = await api.request('/settings');
    const settingsBody = await settingsResponse.json();
    const staleConfig = settingsBody.config as StrikeLedgerConfig;
    const currentRevision = staleConfig.revision;
    const updatedConfig: StrikeLedgerConfig = {
      ...staleConfig,
      rules: staleConfig.rules.map((rule) =>
        rule.id === 'rule-general'
          ? { ...rule, label: 'Rule 1 Playtest' }
          : rule
      ),
    };
    const saveResponse = await api.request('/settings', {
      method: 'POST',
      body: JSON.stringify({
        revision: currentRevision,
        config: updatedConfig,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(saveResponse.status).toBe(200);

    const staleSaveResponse = await api.request('/settings', {
      method: 'POST',
      body: JSON.stringify({
        revision: currentRevision + 1,
        config: staleConfig,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const staleSaveBody = await staleSaveResponse.json();

    expect(staleSaveResponse.status).toBe(400);
    expect(staleSaveBody).toEqual({
      status: 'invalid',
      issues: [
        {
          path: 'revision',
          message: 'Config revision must match request revision.',
        },
      ],
    });

    const latestResponse = await api.request('/settings');
    const latestBody = await latestResponse.json();
    expect(latestBody.config).toMatchObject({
      revision: currentRevision + 1,
      rules: [expect.objectContaining({ label: 'Rule 1 Playtest' })],
    });
  });

  it('runs bounded cleanup for old inactive ledger entries', async () => {
    const { api, redis } = await loadApi(['all']);
    const nowMs = Date.now();
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'old-inactive',
        targetId: 't3_old',
        createdAtMs: nowMs - 400 * 24 * 60 * 60 * 1000,
      })
    );
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'recent-active',
        targetId: 't3_recent',
        createdAtMs: nowMs - 10 * 24 * 60 * 60 * 1000,
      })
    );

    const response = await api.request('/cleanup-ledger', {
      method: 'POST',
      body: JSON.stringify({ retentionDays: 365, maxEntries: 10 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deleted).toBe(1);
    expect(redis.values.has('ledger_entry:old-inactive')).toBe(false);
    expect(redis.values.has('ledger_entry:recent-active')).toBe(true);
    expect(
      Array.from(redis.sortedSets.get('user:id:t2_user:ledger')?.keys() ?? [])
    ).toEqual(['recent-active']);
    expect(
      Array.from(redis.sortedSets.get('ledger:testsub:entries')?.keys() ?? [])
    ).toEqual(['recent-active']);
  });

  it('normalizes username input when recalculating a user total', async () => {
    const { api, reddit, redis } = await loadApi(['all']);
    const entry = buildEntry({
      userId: 't2_someuser',
      userKey: 'id:t2_someuser',
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
      userKey: 'id:t2_someuser',
      activeTotal: 3,
    });
    expect(reddit.getUserByUsername).toHaveBeenCalledWith('SomeUser');
  });

  it('allows direct user-key recalculation for users that still resolve', async () => {
    const { api, reddit, redis } = await loadApi(['all']);
    const entry = buildEntry({
      userId: 't2_someuser',
      userKey: 'id:t2_someuser',
      username: 'SomeUser',
    });
    await seedLedger(redis, entry);

    const response = await api.request('/recalculate-user-total', {
      method: 'POST',
      body: JSON.stringify({ userKey: 'id:t2_someuser' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      userKey: 'id:t2_someuser',
      activeTotal: 3,
    });
    expect(reddit.getUserById).toHaveBeenCalledWith('t2_someuser');
  });

  it('filters manual recalculation totals to the current subreddit', async () => {
    const { api, redis } = await loadApi(['all']);
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'entry-current',
        userId: 't2_someuser',
        userKey: 'id:t2_someuser',
        username: 'SomeUser',
        originalPoints: 3,
      })
    );
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'entry-other',
        subredditName: 'othersub',
        targetId: 't3_other',
        targetPermalink: '/r/othersub/comments/other',
        userId: 't2_someuser',
        userKey: 'id:t2_someuser',
        username: 'SomeUser',
        originalPoints: 99,
      })
    );

    const response = await api.request('/recalculate-user-total', {
      method: 'POST',
      body: JSON.stringify({ username: 'u/SomeUser' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      userKey: 'id:t2_someuser',
      activeTotal: 3,
    });
    expect(redis.values.get('user:id:t2_someuser:active_total')).toBe('3');
  });

  it('rejects direct user-key recalculation unless the key is a Reddit user ID', async () => {
    const { api, redis } = await loadApi(['all']);

    const response = await api.request('/recalculate-user-total', {
      method: 'POST',
      body: JSON.stringify({ userKey: 'id:t3_post' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'missing_user' });
    expect(redis.values.has('user:id:t3_post:active_total')).toBe(false);
  });

  it('does not recreate cached totals for deleted direct user IDs', async () => {
    const { api, reddit, redis } = await loadApi(['all']);
    reddit.getUserById.mockResolvedValueOnce(undefined);

    const response = await api.request('/recalculate-user-total', {
      method: 'POST',
      body: JSON.stringify({ userKey: 'id:t2_deleted' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'missing_user' });
    expect(reddit.getUserById).toHaveBeenCalledWith('t2_deleted');
    expect(redis.values.has('user:id:t2_deleted:active_total')).toBe(false);
  });

  it('rejects deleted direct user IDs for history lookups without recreating caches', async () => {
    const { api, reddit, redis } = await loadApi(['all']);
    reddit.getUserById.mockResolvedValueOnce(undefined);

    const response = await api.request('/history?userKey=id:t2_deleted');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_context',
    });
    expect(reddit.getUserById).toHaveBeenCalledWith('t2_deleted');
    expect(redis.values.has('user:id:t2_deleted:active_total')).toBe(false);
  });

  it('does not expose a client-initiated side-effect retry API', async () => {
    const addComment = vi.fn(async () => ({
      id: 't1_warning_2',
      distinguish: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
    }));
    const remove = vi.fn(async () => undefined);
    const targetPost = {
      id: 't3_target',
      subredditName: 'testsub',
      authorId: 't2_user',
      authorName: 'target-user',
      permalink: '/r/testsub/comments/target',
      locked: false,
      removed: false,
      nsfw: false,
      addComment,
      remove,
      markAsNsfw: vi.fn(async () => undefined),
    };
    const { api, redis } = await loadApi(['posts'], { targetPost });
    await seedLedger(
      redis,
      buildEntry({
        status: 'partial',
        publicCommentId: 't1_warning',
        sideEffects: {
          ...EMPTY_SIDE_EFFECTS,
          publicComment: 'succeeded',
          remove: 'failed',
          modNote: 'skipped',
          userNotice: 'skipped',
        },
      })
    );

    const response = await api.request('/retry-side-effects', {
      method: 'POST',
      body: JSON.stringify({ entryId: 'entry-1' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(404);
    expect(addComment).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
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

  it('uses reversal context and honors per-request native mod-note opt-out', async () => {
    const { api, reddit, redis } = await loadApi(['posts']);
    await seedViewContext(redis);
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'entry-id',
        userKey: 'id:t2_user',
        username: 'target-user',
        targetId: 't3_current',
        originalPoints: 2,
      })
    );
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'entry-legacy',
        userKey: 'id:t2_user',
        username: 'target-user',
        targetId: 't3_legacy',
        originalPoints: 3,
      })
    );

    const response = await api.request('/reverse', {
      method: 'POST',
      body: JSON.stringify({
        entryId: 'entry-legacy',
        reversalReason: 'issued in error',
        contextToken: 'token-1',
        addNativeModNote: false,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'reversed',
      activeTotal: 2,
    });
    expect(redis.values.get('user:id:t2_user:active_total')).toBe('2');
    expect(reddit.addModNote).not.toHaveBeenCalled();
    expect(body.sideEffects.reversalModNote).toBe('skipped');
  });

  it('checkpoints reversal side effects before the final ledger update', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedLedger(redis);

    const response = await api.request('/reverse', {
      method: 'POST',
      body: JSON.stringify({
        entryId: 'entry-1',
        reversalReason: 'issued in error',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const ledgerWrites = redis.setCalls
      .filter((call) => call.key === 'ledger_entry:entry-1')
      .map((call) => JSON.parse(call.value) as LedgerEntry);

    expect(ledgerWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reversalModNoteId: 'mod-note-1',
          sideEffects: expect.objectContaining({
            reversalModNote: 'succeeded',
          }),
        }),
        expect.objectContaining({
          reversalUserNoticeId: 'conversation-1',
          sideEffects: expect.objectContaining({
            reversalUserNotice: 'succeeded',
          }),
        }),
      ])
    );
    expect(ledgerWrites.at(-1)).toMatchObject({
      status: 'reversed',
      reversalModNoteId: 'mod-note-1',
      reversalUserNoticeId: 'conversation-1',
    });
  });
});
