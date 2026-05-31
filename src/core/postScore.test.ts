import { describe, expect, it } from 'vitest';
import {
  getCachedOrLivePostScoreSummary,
  getPostRateKey,
  getPostScoreSummaryKey,
  POST_SCORE_SUMMARY_CACHE_TTL_MS,
  recordPostSubmission,
  savePostScoreSummary,
  summarizeUserPostScores,
} from './postScore';
import { FakeRedisStore } from './redisStore';

const nowMs = Date.UTC(2026, 0, 31);

const daysAgo = (days: number): Date =>
  new Date(nowMs - days * 24 * 60 * 60 * 1000);

const buildAsyncListing = <T>(items: T[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      yield item;
    }
  },
});

describe('post score summary', () => {
  it('summarizes only current-subreddit posts inside the configured window', async () => {
    const client = {
      getPostsByUser: () =>
        buildAsyncListing([
          { subredditName: 'testsub', createdAt: daysAgo(2), score: 8 },
          { subredditName: 'othersub', createdAt: daysAgo(5), score: 999 },
          { subredditName: 'TESTSUB', createdAt: daysAgo(29), score: 22 },
          { subredditName: 'testsub', createdAt: daysAgo(31), score: 100 },
        ]),
    };

    await expect(
      summarizeUserPostScores(client, 'TestSub', 'target-user', 30, nowMs)
    ).resolves.toEqual({
      averagePostScore: 15,
      postScorePostCount: 2,
      postScoreWindowDays: 30,
    });
  });

  it('uses a valid cached summary before doing a live lookup', async () => {
    const store = new FakeRedisStore();
    store.nowMs = nowMs;
    await savePostScoreSummary(
      store,
      'name:target-user',
      'testsub',
      'target-user',
      {
        averagePostScore: 42,
        postScorePostCount: 3,
        postScoreWindowDays: 30,
      },
      nowMs
    );
    const client = {
      getPostsByUser: () => {
        throw new Error('cache should avoid lookup');
      },
    };

    await expect(
      getCachedOrLivePostScoreSummary({
        store,
        client,
        userKey: 'name:target-user',
        username: 'target-user',
        subredditName: 'TESTSUB',
        windowDays: 30,
        nowMs,
      })
    ).resolves.toEqual({
      averagePostScore: 42,
      postScorePostCount: 3,
      postScoreWindowDays: 30,
    });
  });

  it('ignores expired cached summaries and refreshes from reddit', async () => {
    const store = new FakeRedisStore();
    store.nowMs = nowMs;
    await savePostScoreSummary(
      store,
      'name:target-user',
      'testsub',
      'target-user',
      {
        averagePostScore: 42,
        postScorePostCount: 3,
        postScoreWindowDays: 30,
      },
      nowMs
    );

    store.nowMs = nowMs + POST_SCORE_SUMMARY_CACHE_TTL_MS + 1;
    const client = {
      getPostsByUser: () =>
        buildAsyncListing([
          { subredditName: 'testsub', createdAt: daysAgo(1), score: 9 },
        ]),
    };

    await expect(
      getCachedOrLivePostScoreSummary({
        store,
        client,
        userKey: 'name:target-user',
        username: 'target-user',
        subredditName: 'testsub',
        windowDays: 30,
        nowMs: store.nowMs,
      })
    ).resolves.toEqual({
      averagePostScore: 9,
      postScorePostCount: 1,
      postScoreWindowDays: 30,
    });
    await expect(
      store.get(getPostScoreSummaryKey('name:target-user'))
    ).resolves.not.toBeNull();
  });

  it('records submitted posts in the per-user post-rate sorted set', async () => {
    const store = new FakeRedisStore();

    await recordPostSubmission(store, 'id:t2_user', 't3_post', nowMs);

    await expect(
      store.zRange(getPostRateKey('id:t2_user'), 0, -1)
    ).resolves.toEqual(['t3_post']);
  });
});
