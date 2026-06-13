import { Hono } from 'hono';
import { reddit, redis, settings } from '@devvit/web/server';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { ConfigRepository } from '../core/configRepository';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import { runLedgerCleanup } from '../core/ledgerCleanup';
import { LedgerRepository } from '../core/ledgerRepository';
import { logInfo } from '../core/logging';

export const schedulerRoutes = new Hono();

schedulerRoutes.post('/ledger-cleanup', async (c) => {
  const task = await c.req.json<Partial<TaskRequest>>().catch(() => null);
  if (task?.name !== 'ledgerCleanup') {
    return c.json<TaskResponse>({}, 400);
  }

  const subreddit = await reddit.getCurrentSubreddit();
  const store = new DevvitRedisStore(redis);
  const result = await runLedgerCleanup({
    subredditName: subreddit.name,
    configRepository: new ConfigRepository(store, settings),
    ledgerRepository: new LedgerRepository(store),
    nowMs: Date.now(),
  });

  logInfo('scheduler.cleanup.ok', {
    subredditName: subreddit.name,
    retentionDays: result.retentionDays,
    maxEntries: result.maxEntries,
    scanned: result.scanned,
    deleted: result.deleted,
  });

  return c.json<TaskResponse>({}, 200);
});
