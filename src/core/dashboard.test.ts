import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_CONTEXT_TTL_MS,
  DashboardRepository,
  createExpiringTimes,
} from './dashboard';
import { FakeRedisStore } from './redisStore';

const nowMs = Date.now();

const createRepo = () => {
  const store = new FakeRedisStore();
  store.nowMs = nowMs;
  return { repo: new DashboardRepository(store), store };
};

describe('DashboardRepository', () => {
  it('stores a readable dashboard post for the current subreddit only', async () => {
    const { repo } = createRepo();

    await repo.saveDashboardPost({
      postId: 't3_dashboard',
      subredditName: 'TestSub',
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    await expect(repo.getDashboardPost('testsub')).resolves.toMatchObject({
      postId: 't3_dashboard',
    });
    await expect(repo.getDashboardPost('othersub')).resolves.toBeNull();
  });

  it('stores view context records and cleanup indexes in one transaction', async () => {
    const { repo, store } = createRepo();
    const times = createExpiringTimes(nowMs);

    await repo.saveViewContext({
      token: 'view-token',
      targetId: 't3_target',
      targetKind: 'post',
      subredditName: 'testsub',
      userKey: 'id:t2_user',
      authorId: 't2_user',
      authorName: 'target-user',
      ...times,
    });

    expect(store.transactionWatchKeys).toContainEqual([
      'view_context:view-token',
      'user:id:t2_user:view_contexts',
    ]);
    await expect(repo.getViewContext('view-token')).resolves.toMatchObject({
      userKey: 'id:t2_user',
    });
    await expect(
      store.zRange('user:id:t2_user:view_contexts', 0, -1)
    ).resolves.toEqual(['view-token']);
  });

  it('expires read-only view context tokens after fifteen minutes', async () => {
    const { repo, store } = createRepo();
    const times = createExpiringTimes(nowMs);

    await repo.saveViewContext({
      token: 'view-token',
      targetId: 't3_target',
      targetKind: 'post',
      subredditName: 'testsub',
      userKey: 'id:t2_user',
      authorId: 't2_user',
      authorName: 'target-user',
      ...times,
    });

    await expect(repo.getViewContext('view-token')).resolves.toMatchObject({
      userKey: 'id:t2_user',
    });

    store.nowMs = nowMs + DASHBOARD_CONTEXT_TTL_MS + 1;
    await expect(repo.getViewContext('view-token')).resolves.toBeNull();
  });

  it('consumes per-moderator bootstrap records', async () => {
    const { repo } = createRepo();
    const times = createExpiringTimes(nowMs);

    await repo.saveDashboardBootstrap({
      view: 'profile',
      subredditName: 'testsub',
      moderatorUsername: 'Mod-A',
      contextToken: 'view-token',
      ...times,
    });

    await expect(
      repo.consumeDashboardBootstrap('TestSub', 'mod-a')
    ).resolves.toMatchObject({
      view: 'profile',
      contextToken: 'view-token',
    });
    await expect(
      repo.consumeDashboardBootstrap('testsub', 'mod-a')
    ).resolves.toBeNull();
  });

  it('peeks at per-moderator bootstrap records without consuming them', async () => {
    const { repo } = createRepo();
    const times = createExpiringTimes(nowMs);

    await repo.saveDashboardBootstrap({
      view: 'profile',
      subredditName: 'testsub',
      moderatorUsername: 'Mod-A',
      contextToken: 'view-token',
      ...times,
    });

    await expect(
      repo.getDashboardBootstrap('TestSub', 'mod-a')
    ).resolves.toMatchObject({
      view: 'profile',
      contextToken: 'view-token',
    });
    await expect(
      repo.consumeDashboardBootstrap('testsub', 'mod-a')
    ).resolves.toMatchObject({
      view: 'profile',
      contextToken: 'view-token',
    });
  });
});
