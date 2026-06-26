import { Hono } from 'hono';
import { reddit, redis, settings } from '@devvit/web/server';
import type { TaskRequest, TaskResponse } from '@devvit/web/server';
import { ConfigRepository } from '../core/configRepository';
import { runAccountDeletionCheck } from '../core/accountDeletion';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import { runLedgerCleanup } from '../core/ledgerCleanup';
import { LedgerRepository } from '../core/ledgerRepository';
import { logInfo } from '../core/logging';

export const schedulerRoutes = new Hono();

const boundedInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
};

schedulerRoutes.post('/ledger-cleanup', async (c) => {
  const task = await c.req.json<Partial<TaskRequest>>().catch(() => null);
  if (task?.name !== 'ledgerCleanup') {
    return c.json<TaskResponse>({}, 400);
  }
  const payload =
    task.data && typeof task.data === 'object'
      ? (task.data as Record<string, unknown>)
      : {};

  const subreddit = await reddit.getCurrentSubreddit();
  const store = new DevvitRedisStore(redis);
  const result = await runLedgerCleanup({
    subredditName: subreddit.name,
    configRepository: new ConfigRepository(store, settings),
    ledgerRepository: new LedgerRepository(store),
    nowMs: Date.now(),
    payload,
  });

  logInfo('scheduler.cleanup.ok', {
    subredditName: subreddit.name,
    retentionDays: result.retentionDays,
    maxEntries: result.maxEntries,
    maxRuntimeMs: result.maxRuntimeMs,
    scanned: result.scanned,
    deleted: result.deleted,
    stoppedEarly: Boolean(result.stoppedEarly),
  });

  return c.json<TaskResponse>({}, 200);
});

schedulerRoutes.post('/target-delete-scrub', async (c) => {
  const task = await c.req.json<Partial<TaskRequest>>().catch(() => null);
  if (task?.name !== 'targetDeleteScrub') {
    return c.json<TaskResponse>({}, 400);
  }
  const payload =
    task.data && typeof task.data === 'object'
      ? (task.data as Record<string, unknown>)
      : {};
  const maxTargets = boundedInteger(payload.maxTargets, 25, 1, 100);
  const maxEntriesPerTarget = boundedInteger(
    payload.maxEntriesPerTarget,
    200,
    1,
    1_000
  );
  const maxRuntimeMs = boundedInteger(payload.maxRuntimeMs, 10_000, 1, 30_000);

  const result = await new LedgerRepository(
    new DevvitRedisStore(redis)
  ).continueTargetDeletedScrub({
    nowMs: Date.now(),
    maxTargets,
    maxEntriesPerTarget,
    maxRuntimeMs,
  });

  logInfo('scheduler.target_delete_scrub.ok', {
    maxTargets,
    maxEntriesPerTarget,
    maxRuntimeMs,
    targets: result.targets,
    scanned: result.scanned,
    updated: result.updated,
    remainingTargets: result.remainingTargets,
    stoppedEarly: Boolean(result.stoppedEarly),
  });

  return c.json<TaskResponse>({}, 200);
});

schedulerRoutes.post('/account-deletion-check', async (c) => {
  const task = await c.req.json<Partial<TaskRequest>>().catch(() => null);
  if (task?.name !== 'accountDeletionCheck') {
    return c.json<TaskResponse>({}, 400);
  }
  const payload =
    task.data && typeof task.data === 'object'
      ? (task.data as Record<string, unknown>)
      : {};

  const store = new DevvitRedisStore(redis);
  const result = await runAccountDeletionCheck({
    ledgerRepository: new LedgerRepository(store),
    reddit: {
      getUserById: (userId) => reddit.getUserById(userId as `t2_${string}`),
    },
    nowMs: Date.now(),
    payload,
  });

  logInfo('scheduler.account_deletion.ok', {
    checkIntervalHours: result.checkIntervalHours,
    maxUsers: result.maxUsers,
    maxEntriesPerUser: result.maxEntriesPerUser,
    maxEntriesPerRun: result.maxEntriesPerRun,
    maxRuntimeMs: result.maxRuntimeMs,
    checked: result.checked,
    existingUsers: result.existingUsers,
    deletedUsers: result.deletedUsers,
    deletedEntries: result.deletedEntries,
    failedChecks: result.failedChecks,
    remainingEntries: result.remainingEntries,
    stoppedEarly: Boolean(result.stoppedEarly),
  });

  return c.json<TaskResponse>({}, 200);
});
