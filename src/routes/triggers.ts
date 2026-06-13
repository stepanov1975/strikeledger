import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
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

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  logInfo('trigger.app_install', {
    subredditName: input.subreddit?.name,
  });

  return c.json<TriggerResponse>(successResponse, 200);
});

for (const [, route] of placeholderTriggerRoutes) {
  triggers.post(route, (c) => {
    return c.json<TriggerResponse>(successResponse, 200);
  });
}
