import { Hono } from 'hono';
import { redis } from '@devvit/web/server';
import type {
  OnAppInstallRequest,
  OnCommentDeleteRequest,
  OnPostDeleteRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import { LedgerRepository } from '../core/ledgerRepository';
import { logInfo } from '../core/logging';

export const triggers = new Hono();

const placeholderTriggerRoutes = [
  ['onPostSubmit', '/on-post-submit'],
  ['onPostCreate', '/on-post-create'],
  ['onPostUpdate', '/on-post-update'],
  ['onPostFlairUpdate', '/on-post-flair-update'],
  ['onPostNsfwUpdate', '/on-post-nsfw-update'],
  ['onPostSpoilerUpdate', '/on-post-spoiler-update'],
  ['onModAction', '/on-mod-action'],
] as const;

const successResponse: TriggerResponse = { status: 'success' };

const parseDeletedAtMs = (value: string | undefined): number => {
  if (!value) {
    return Date.now();
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const getLedgerRepository = (): LedgerRepository =>
  new LedgerRepository(new DevvitRedisStore(redis));

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  logInfo('trigger.app_install', {
    subredditName: input.subreddit?.name,
  });

  return c.json<TriggerResponse>(successResponse, 200);
});

triggers.post('/on-post-delete', async (c) => {
  const input = await c.req.json<OnPostDeleteRequest>();
  const result = await getLedgerRepository().markTargetDeleted({
    targetId: input.postId,
    targetKind: 'post',
    ...(input.subreddit?.name ? { subredditName: input.subreddit.name } : {}),
    deletedAtMs: parseDeletedAtMs(input.deletedAt),
  });
  logInfo('trigger.post_delete.scrubbed', {
    subredditName: input.subreddit?.name,
    targetId: input.postId,
    scanned: result.scanned,
    updated: result.updated,
  });

  return c.json<TriggerResponse>(successResponse, 200);
});

triggers.post('/on-comment-delete', async (c) => {
  const input = await c.req.json<OnCommentDeleteRequest>();
  const result = await getLedgerRepository().markTargetDeleted({
    targetId: input.commentId,
    targetKind: 'comment',
    ...(input.subreddit?.name ? { subredditName: input.subreddit.name } : {}),
    deletedAtMs: parseDeletedAtMs(input.deletedAt),
  });
  logInfo('trigger.comment_delete.scrubbed', {
    subredditName: input.subreddit?.name,
    targetId: input.commentId,
    scanned: result.scanned,
    updated: result.updated,
  });

  return c.json<TriggerResponse>(successResponse, 200);
});

for (const [, route] of placeholderTriggerRoutes) {
  triggers.post(route, (c) => {
    return c.json<TriggerResponse>(successResponse, 200);
  });
}
