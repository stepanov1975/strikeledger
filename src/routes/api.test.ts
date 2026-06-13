import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SIDE_EFFECTS,
  SCHEMA_VERSION,
  type LedgerEntry,
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

class ApiRedisMock {
  readonly values = new Map<string, string>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly setCalls: Array<{ key: string; value: string }> = [];

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<string> {
    this.setCalls.push({ key, value });
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
          username: 'mod-a',
          getModPermissionsForSubreddit: vi.fn(async () => permissions),
        };
  const reddit = {
    getCurrentSubreddit: vi.fn(async () => ({ name: 'testsub' })),
    getCurrentUser: vi.fn(async () => user),
    getModerators: vi.fn(() => ({
      all: vi.fn(async () =>
        options.listedModerator && user ? [{ username: user.username }] : []
      ),
    })),
    getRules: vi.fn(async () => options.redditRules ?? []),
    getPostsByUser: vi.fn(() => buildAsyncListing(options.postsByUser ?? [])),
    getPostById: vi.fn(async () =>
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
    getCommentById: vi.fn(async () =>
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
  await redis.set(
    `view_context:${String(overrides.token ?? 'token-1')}`,
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
      ...overrides,
    })
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

  it('marks bootstrap responses that consume pending menu launches', async () => {
    const { api, redis } = await loadApi(['posts']);
    await redis.set(
      'dashboard_bootstrap:testsub:mod-a',
      JSON.stringify({
        view: 'profile',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        contextToken: 'view-token',
        createdAtMs: Date.UTC(2026, 0, 1),
        expiresAtMs: Date.UTC(2026, 0, 1) + 15 * 60 * 1000,
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

  it('checks the username fallback ledger for ID-key history contexts', async () => {
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
    const { api, redis } = await loadApi(['posts']);
    const entry = buildEntry({
      userKey: 'name:someuser',
      username: 'SomeUser',
    });
    await seedLedger(redis, entry);

    const response = await api.request('/history?username=u%2FSomeUser');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      context: {
        userKey: 'name:someuser',
        authorName: 'SomeUser',
      },
      activeTotal: 3,
      entries: [{ entryId: 'entry-1' }],
    });
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

  it('checks the username fallback ledger for ID-key profile contexts', async () => {
    const { api, redis } = await loadApi(['posts']);
    await seedViewContext(redis);
    await seedLedger(
      redis,
      buildEntry({
        userKey: 'name:target-user',
        username: 'TargetUser',
      })
    );

    const response = await api.request('/profile?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      summary: {
        activeTotal: 3,
        lifetimeOriginalPoints: 3,
      },
      recentEntries: [
        {
          entryId: 'entry-1',
        },
      ],
    });
  });

  it('filters profile summaries to the current subreddit', async () => {
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

    const response = await api.request('/profile?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary).toMatchObject({
      activeTotal: 3,
      lifetimeOriginalPoints: 3,
      removalsByRule: {
        'Community rule violation': 1,
      },
    });
    expect(body.recentEntries).toEqual([
      expect.objectContaining({ entryId: 'entry-current' }),
    ]);
  });

  it('calculates average post score for current subreddit posts in the profile window', async () => {
    const daysAgo = (days: number): Date =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { api, reddit, redis } = await loadApi(['posts'], {
      postsByUser: [
        { subredditName: 'testsub', createdAt: daysAgo(10), score: 10 },
        { subredditName: 'othersub', createdAt: daysAgo(12), score: 999 },
        { subredditName: 'TESTSUB', createdAt: daysAgo(29), score: 20 },
        { subredditName: 'testsub', createdAt: daysAgo(31), score: 100 },
      ],
    });
    await seedViewContext(redis);

    const response = await api.request('/profile?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(reddit.getPostsByUser).toHaveBeenCalledWith({
      username: 'target-user',
      sort: 'new',
      limit: 1000,
      pageSize: 100,
    });
    expect(body.summary).toMatchObject({
      averagePostScore: 15,
      postScorePostCount: 2,
      postScoreWindowDays: 30,
    });
  });

  it('uses the cached post score summary for profile lookups', async () => {
    const nowMs = Date.now();
    const { api, reddit, redis } = await loadApi(['posts']);
    await seedViewContext(redis, {
      userKey: 'name:target-user',
      authorName: 'target-user',
    });
    await redis.set(
      'user:name:target-user:post_score_summary',
      JSON.stringify({
        schemaVersion: 1,
        subredditName: 'testsub',
        username: 'target-user',
        calculatedAtMs: nowMs,
        expiresAtMs: nowMs + 60 * 60 * 1000,
        summary: {
          averagePostScore: 42,
          postScorePostCount: 3,
          postScoreWindowDays: 30,
        },
      })
    );

    const response = await api.request('/profile?contextToken=token-1');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(reddit.getPostsByUser).not.toHaveBeenCalled();
    expect(body.summary).toMatchObject({
      averagePostScore: 42,
      postScorePostCount: 3,
      postScoreWindowDays: 30,
    });
  });

  it('reads profile by user key for moderator dashboard lookup', async () => {
    const { api, redis } = await loadApi(['posts']);
    const entry = buildEntry({
      userKey: 'name:someuser',
      username: 'SomeUser',
    });
    await seedLedger(redis, entry);

    const response = await api.request('/profile?userKey=name%3Asomeuser');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      context: {
        userKey: 'name:someuser',
        authorName: 'someuser',
      },
      summary: {
        activeTotal: 3,
        lifetimeOriginalPoints: 3,
      },
    });
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

  it('filters manual recalculation totals to the current subreddit', async () => {
    const { api, redis } = await loadApi(['all']);
    await seedLedger(
      redis,
      buildEntry({
        entryId: 'entry-current',
        userKey: 'name:someuser',
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
        userKey: 'name:someuser',
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
      userKey: 'name:someuser',
      activeTotal: 3,
    });
    expect(redis.values.get('user:name:someuser:active_total')).toBe('3');
  });

  it('retries failed side effects without duplicating successful ones', async () => {
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
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(addComment).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(body.entry).toMatchObject({
      status: 'succeeded',
      publicCommentId: 't1_warning',
      sideEffects: {
        publicComment: 'succeeded',
        remove: 'succeeded',
      },
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
