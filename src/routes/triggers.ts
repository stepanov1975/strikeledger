import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import { logInfo } from '../core/logging';

export const triggers = new Hono();

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
