import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';

class MenuRedisMock {
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
    keys.forEach((key) => this.values.delete(key));
  }

  async zAdd(
    key: string,
    member: { member: string; score: number }
  ): Promise<number> {
    const values = this.sortedSets.get(key) ?? new Map<string, number>();
    values.set(member.member, member.score);
    this.sortedSets.set(key, values);
    return 1;
  }

  async zScore(key: string, member: string): Promise<number | undefined> {
    return this.sortedSets.get(key)?.get(member);
  }

  async runTransaction<T>(
    _watchedKeys: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    return operation();
  }
}

class MenuStoreMock {
  constructor(private readonly redis: MenuRedisMock) {}

  get(key: string) {
    return this.redis.get(key).then((value) => value ?? null);
  }

  set(key: string, value: string) {
    return this.redis.set(key, value).then(() => undefined);
  }

  del(...keys: string[]) {
    return this.redis.del(...keys);
  }

  zAdd(key: string, member: { member: string; score: number }) {
    return this.redis.zAdd(key, member).then(() => undefined);
  }

  zScore(key: string, member: string) {
    return this.redis.zScore(key, member).then((value) => value ?? null);
  }

  runTransaction<T>(
    watchedKeys: readonly string[],
    operation: () => Promise<T>
  ) {
    return this.redis.runTransaction(watchedKeys, operation);
  }
}

const targetPost = (overrides: Record<string, unknown> = {}) => ({
  id: 't3_target',
  subredditName: 'testsub',
  authorId: 't2_target',
  authorName: 'target-user',
  permalink: '/r/testsub/comments/target',
  url: 'https://reddit.com/r/testsub/comments/target',
  ...overrides,
});

const dashboardPost = (overrides: Record<string, unknown> = {}) => ({
  id: 't3_dashboard',
  subredditName: 'testsub',
  permalink: '/r/testsub/comments/dashboard',
  url: 'https://reddit.com/r/testsub/comments/dashboard',
  ...overrides,
});

const loadMenu = async (
  permissions: string[] | null,
  options: {
    target?: Record<string, unknown>;
    dashboard?: Record<string, unknown>;
    dashboardReadError?: Error;
  } = {}
) => {
  vi.resetModules();
  const redis = new MenuRedisMock();
  const user =
    permissions === null
      ? null
      : {
          username: 'mod-a',
          getModPermissionsForSubreddit: vi.fn(async () => permissions),
        };
  const target = targetPost(options.target);
  const dashboard = dashboardPost(options.dashboard);
  const reddit = {
    getCurrentUser: vi.fn(async () => user),
    getModerators: vi.fn(() => ({ all: vi.fn(async () => []) })),
    getCurrentSubreddit: vi.fn(async () => ({ name: 'testsub' })),
    getPostById: vi.fn(async (postId: string) => {
      if (postId === 't3_dashboard') {
        if (options.dashboardReadError) {
          throw options.dashboardReadError;
        }
        return dashboard;
      }
      return target;
    }),
    getCommentById: vi.fn(async () => target),
    submitCustomPost: vi.fn(async () => dashboard),
  };

  vi.doMock('@devvit/web/server', () => ({
    reddit,
    redis,
    settings: { getAll: vi.fn(async () => ({})) },
  }));
  vi.doMock('../core/devvitRedisStore', () => ({
    DevvitRedisStore: MenuStoreMock,
  }));

  const { menu } = await import('./menu');
  return { menu, reddit, redis };
};

const requestMenu = (path: string, body: Record<string, unknown> = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetId: 't3_target', location: 'post', ...body }),
  });

const saveDashboardRecord = async (redis: MenuRedisMock) => {
  await redis.set(
    'dashboard_post_id',
    JSON.stringify({
      postId: 't3_dashboard',
      subredditName: 'testsub',
      createdAtMs: 1,
      updatedAtMs: 1,
    })
  );
};

describe('menu helpers', () => {
  it('shows action-specific points in enforcement rule options', async () => {
    vi.resetModules();
    vi.doMock('@devvit/web/server', () => ({
      reddit: {},
      redis: {},
      settings: { getAll: vi.fn(async () => ({})) },
    }));
    const { buildEnforcementFields } = await import('./menu');

    const fields = buildEnforcementFields('nonce-1', 'warn_remove', {
      ...DEFAULT_CONFIG,
      rules: [
        { id: 'rule-general', label: 'Community rule violation', enabled: true },
        {
          id: 'rule-severe',
          label: 'Severe violation',
          enabled: true,
          pointOverrides: { warn_remove: 7 },
        },
      ],
    });

    expect(fields[0]).toMatchObject({
      name: 'ruleId',
      options: [
        { label: 'Community rule violation (+3)', value: 'rule-general' },
        { label: 'Severe violation (+7)', value: 'rule-severe' },
      ],
    });

    const nonceField = fields.find(
      (field) => 'name' in field && field.name === 'formNonce'
    );
    expect(nonceField).toMatchObject({
      name: 'formNonce',
      label: 'Form token',
      type: 'select',
      required: true,
      options: [{ label: 'Current moderation action', value: 'nonce-1' }],
      defaultValue: ['nonce-1'],
    });
  });
});

describe('menu routes', () => {
  it('denies Warn without creating a form or nonce when enforcement permission is missing', async () => {
    const { menu, redis } = await loadMenu(['wiki']);

    const response = await menu.request(requestMenu('/warn-post'));
    const body = await response.json();

    expect(body).toEqual({
      showToast: 'StrikeLedger requires posts or all moderator permission.',
    });
    expect(body).not.toHaveProperty('showForm');
    expect(
      Array.from(redis.values.keys()).filter((key) => key.startsWith('form_nonce:'))
    ).toHaveLength(0);
  });

  it('denies History to non-moderators', async () => {
    const { menu, redis } = await loadMenu([]);

    const response = await menu.request(requestMenu('/history'));

    await expect(response.json()).resolves.toEqual({
      showToast: 'StrikeLedger requires moderator permission.',
    });
    expect(redis.values.size).toBe(0);
  });

  it('persists an enforcement nonce before showing the form', async () => {
    const { menu, redis } = await loadMenu(['posts']);

    const response = await menu.request(requestMenu('/warn-post'));
    const body = await response.json();
    const nonce = body.showForm.form.fields.find(
      (field: { name: string }) => field.name === 'formNonce'
    ).defaultValue[0];

    expect(redis.values.get(`form_nonce:${nonce}`)).toContain('t3_target');
  });

  it('creates and stores the dashboard when a manager opens History without one', async () => {
    const { menu, reddit, redis } = await loadMenu(['all']);

    const response = await menu.request(requestMenu('/history'));

    await expect(response.json()).resolves.toMatchObject({
      navigateTo: { url: 'https://reddit.com/r/testsub/comments/dashboard' },
    });
    expect(reddit.submitCustomPost).toHaveBeenCalledWith(
      expect.objectContaining({ entry: 'dashboard', subredditName: 'testsub' })
    );
    expect(redis.values.get('dashboard_post_id')).toContain('t3_dashboard');
  });

  it('rejects an authorless Profile without saving a view context', async () => {
    const { menu, redis } = await loadMenu(['posts'], {
      target: { authorId: undefined, authorName: undefined },
    });
    await saveDashboardRecord(redis);

    const response = await menu.request(requestMenu('/profile'));

    await expect(response.json()).resolves.toEqual({
      showToast: 'StrikeLedger cannot open a profile without an author.',
    });
    expect(
      Array.from(redis.values.keys()).filter((key) => key.startsWith('view_context:'))
    ).toHaveLength(0);
  });

  it('saves target-only History context when the target has no author', async () => {
    const { menu, redis } = await loadMenu(['posts'], {
      target: { authorId: undefined, authorName: undefined },
    });
    await saveDashboardRecord(redis);

    const response = await menu.request(requestMenu('/history'));

    await expect(response.json()).resolves.toMatchObject({ navigateTo: {} });
    const record = JSON.parse(
      Array.from(redis.values.entries()).find(([key]) =>
        key.startsWith('view_context:')
      )?.[1] ?? ''
    );
    expect(record).toMatchObject({ targetId: 't3_target' });
    expect(record).not.toHaveProperty('userKey');
  });

  it('navigates to the stored dashboard with saved History bootstrap state', async () => {
    const { menu, redis } = await loadMenu(['posts']);
    await saveDashboardRecord(redis);

    const response = await menu.request(requestMenu('/history'));
    const body = await response.json();

    expect(body).toEqual({
      navigateTo: {
        url: 'https://reddit.com/r/testsub/comments/dashboard',
        permalink: '/r/testsub/comments/dashboard',
      },
    });
    expect(redis.values.get('dashboard_bootstrap:testsub:mod-a')).toContain(
      '"view":"history"'
    );
  });

  it('keeps the stored dashboard and asks the moderator to retry after a transient read failure', async () => {
    const { menu, reddit, redis } = await loadMenu(['all'], {
      dashboardReadError: new Error('temporary Reddit failure'),
    });
    await saveDashboardRecord(redis);

    const response = await menu.request(requestMenu('/history'));

    await expect(response.json()).resolves.toEqual({
      showToast: 'StrikeLedger dashboard is temporarily unavailable. Please try again.',
    });
    expect(reddit.submitCustomPost).not.toHaveBeenCalled();
    expect(redis.values.get('dashboard_post_id')).toContain('t3_dashboard');
  });

  it('recreates a stored dashboard that Reddit reports as missing', async () => {
    const { menu, reddit, redis } = await loadMenu(['all'], {
      dashboard: { id: 't3_replacement' },
      dashboardReadError: new Error('no post t3_dashboard'),
    });
    await saveDashboardRecord(redis);

    const response = await menu.request(requestMenu('/history'));

    await expect(response.json()).resolves.toMatchObject({
      navigateTo: { url: 'https://reddit.com/r/testsub/comments/dashboard' },
    });
    expect(reddit.submitCustomPost).toHaveBeenCalledWith(
      expect.objectContaining({ entry: 'dashboard', subredditName: 'testsub' })
    );
    expect(redis.values.get('dashboard_post_id')).toContain('t3_replacement');
  });

  it('clears a stored dashboard only when the read post belongs to another subreddit', async () => {
    const { menu, redis } = await loadMenu(['posts'], {
      dashboard: { subredditName: 'othersub' },
    });
    await saveDashboardRecord(redis);

    const response = await menu.request(requestMenu('/history'));

    await expect(response.json()).resolves.toEqual({
      showToast:
        'StrikeLedger dashboard has not been created. A moderator with all permission must open Admin first.',
    });
    expect(redis.values.has('dashboard_post_id')).toBe(false);
  });
});
