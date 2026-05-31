import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnPostSubmitRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { reddit, redis } from '@devvit/web/server';
import { ConfigRepository } from '../core/configRepository';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import { getUserKey } from '../core/identity';
import {
  recordPostSubmission,
  refreshPostScoreSummary,
} from '../core/postScore';
import { logInfo, logWarn } from '../core/logging';

export const triggers = new Hono();

const normalizeTriggerUsername = (
  username: string | undefined
): string | null => {
  if (username === undefined) {
    return null;
  }

  const trimmed = username.trim().replace(/^u\//i, '');
  return trimmed ? trimmed : null;
};

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  logInfo('trigger.app_install', {
    subredditName: input.subreddit?.name,
  });

  return c.json<TriggerResponse>(
    {
      status: 'success',
    },
    200
  );
});

triggers.post('/on-post-submit', async (c) => {
  const input = await c.req.json<OnPostSubmitRequest>();
  const nowMs = Date.now();
  const subredditName = input.subreddit?.name;
  const username = normalizeTriggerUsername(input.author?.name);
  const userKey = getUserKey({
    ...(input.author?.id !== undefined ? { userId: input.author.id } : {}),
    ...(username !== null ? { username } : {}),
  });
  const postId = input.post?.id;

  if (!subredditName || !userKey || !postId) {
    logWarn('trigger.post_submit.skipped', {
      subredditName,
      hasAuthor: input.author !== undefined,
      hasUserKey: userKey !== null,
      hasPostId: postId !== undefined,
    });
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  const store = new DevvitRedisStore(redis);
  try {
    await recordPostSubmission(store, userKey, postId, nowMs);

    if (!username) {
      logWarn('trigger.post_submit.post_score_lookup_skipped', {
        subredditName,
        userKey,
        postId,
        reason: 'missing_username',
      });
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    const config = await new ConfigRepository(store).getConfig();
    const summary = await refreshPostScoreSummary({
      store,
      client: reddit,
      userKey,
      username,
      subredditName,
      windowDays: config.postScoreWindowDays,
      nowMs,
    });

    logInfo('trigger.post_submit.post_score_refreshed', {
      subredditName,
      userKey,
      postId,
      postScorePostCount: summary.postScorePostCount,
      postScoreWindowDays: summary.postScoreWindowDays,
    });
  } catch (error) {
    logWarn('trigger.post_submit.post_score_refresh_failed', {
      subredditName,
      userKey,
      postId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
