import { Hono } from 'hono';
import { reddit, redis } from '@devvit/web/server';
import { ConfigRepository } from '../core/configRepository';
import { DashboardRepository, type ViewContextRecord } from '../core/dashboard';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import {
  ACTION_LABELS,
  type LedgerEntry,
  type StrikeLedgerConfig,
} from '../core/domain';
import { LedgerRepository } from '../core/ledgerRepository';
import { calculateActivePoints, recalculateActiveTotal } from '../core/scoring';
import { executeReversalSideEffects } from '../core/sideEffects';
import { getModeratorAccess, type ModeratorAccess } from './permissions';

export const api = new Hono();

const HISTORY_PAGE_SIZE = 25;

const getRepositories = () => {
  const store = new DevvitRedisStore(redis);
  return {
    configRepository: new ConfigRepository(store),
    dashboardRepository: new DashboardRepository(store),
    ledgerRepository: new LedgerRepository(store),
  };
};

type ApiAccess = {
  subredditName: string;
  access: ModeratorAccess;
};

const getApiAccess = async (): Promise<ApiAccess | null> => {
  const subreddit = await reddit.getCurrentSubreddit();
  const access = await getModeratorAccess(subreddit.name);

  if (!access?.canRead) {
    return null;
  }

  return { subredditName: subreddit.name, access };
};

const parseOffset = (value: string | undefined): number => {
  if (value === undefined) {
    return 0;
  }

  const offset = Number(value);
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
};

const trimString = (value: unknown): string | null =>
  typeof value === 'string' ? value.trim() : null;

const getAuthorizedViewContext = async (
  token: string | undefined,
  subredditName: string,
  dashboardRepository: DashboardRepository
): Promise<ViewContextRecord | null> => {
  if (!token) {
    return null;
  }

  const record = await dashboardRepository.getViewContext(token);
  if (!record) {
    return null;
  }

  return record.subredditName.toLowerCase() === subredditName.toLowerCase()
    ? record
    : null;
};

const serializeEntry = (
  entry: LedgerEntry,
  nowMs: number,
  config: StrikeLedgerConfig
): Record<string, unknown> => ({
  entryId: entry.entryId,
  username: entry.username,
  targetId: entry.targetId,
  targetKind: entry.targetKind,
  targetPermalink: entry.targetPermalink,
  action: entry.action,
  actionLabel: ACTION_LABELS[entry.action],
  ruleId: entry.ruleId,
  ruleLabel: entry.ruleLabel,
  originalPoints: entry.originalPoints,
  activePoints: calculateActivePoints(entry, config, nowMs),
  moderatorUsername: entry.moderatorUsername,
  createdAtMs: entry.createdAtMs,
  status: entry.status,
  sideEffects: entry.sideEffects,
  publicCommentId: entry.publicCommentId,
  modNoteId: entry.modNoteId,
  userNoticeId: entry.userNoticeId,
  reversedAtMs: entry.reversedAtMs,
  reversedBy: entry.reversedBy,
  reversalReason: entry.reversalReason,
});

api.get('/bootstrap', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { dashboardRepository } = getRepositories();
  const bootstrap = await dashboardRepository.consumeDashboardBootstrap(
    apiAccess.subredditName,
    apiAccess.access.username
  );
  const view = bootstrap?.view ?? 'settings';

  return c.json({
    view,
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    ...(bootstrap?.contextToken !== undefined
      ? { contextToken: bootstrap.contextToken }
      : {}),
  });
});

api.get('/history', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { configRepository, dashboardRepository, ledgerRepository } =
    getRepositories();
  const config = await configRepository.getConfig();
  const context = await getAuthorizedViewContext(
    c.req.query('contextToken'),
    apiAccess.subredditName,
    dashboardRepository
  );
  if (!context) {
    return c.json({ error: 'invalid_context' }, 404);
  }

  const nowMs = Date.now();
  const offset = parseOffset(c.req.query('offset'));
  const entries = await ledgerRepository.getUserLedgerPage(
    context.userKey,
    offset,
    HISTORY_PAGE_SIZE
  );
  const activeTotal = await ledgerRepository.recalculateActiveTotal(
    context.userKey,
    config,
    nowMs
  );

  return c.json({
    context,
    activeTotal,
    entries: entries.map((entry) => serializeEntry(entry, nowMs, config)),
    nextOffset:
      entries.length === HISTORY_PAGE_SIZE ? offset + HISTORY_PAGE_SIZE : null,
  });
});

api.get('/profile', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { configRepository, dashboardRepository, ledgerRepository } =
    getRepositories();
  const config = await configRepository.getConfig();
  const context = await getAuthorizedViewContext(
    c.req.query('contextToken'),
    apiAccess.subredditName,
    dashboardRepository
  );
  if (!context) {
    return c.json({ error: 'invalid_context' }, 404);
  }

  const nowMs = Date.now();
  const entries = await ledgerRepository.getUserLedger(context.userKey);
  const activeTotal = recalculateActiveTotal(entries, config, nowMs);
  const activeOriginalPoints = entries
    .filter((entry) => entry.status !== 'reversed')
    .reduce((total, entry) => total + entry.originalPoints, 0);
  const lifetimeOriginalPoints = entries.reduce(
    (total, entry) => total + entry.originalPoints,
    0
  );
  const removalsByRule = entries
    .filter((entry) => entry.action === 'warn_remove')
    .reduce<Record<string, number>>((counts, entry) => {
      counts[entry.ruleLabel] = (counts[entry.ruleLabel] ?? 0) + 1;
      return counts;
    }, {});

  return c.json({
    context,
    summary: {
      activeTotal,
      lifetimeOriginalPoints,
      decayedPoints: Math.max(0, activeOriginalPoints - activeTotal),
      reversedEntries: entries.filter((entry) => entry.status === 'reversed')
        .length,
      removalsByRule,
    },
    recentEntries: entries
      .slice(0, HISTORY_PAGE_SIZE)
      .map((entry) => serializeEntry(entry, nowMs, config)),
  });
});

api.get('/settings', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { configRepository } = getRepositories();
  const config = await configRepository.getConfig();

  return c.json({
    subredditName: apiAccess.subredditName,
    canManage: apiAccess.access.canManage,
    config,
  });
});

api.post('/settings', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  if (!apiAccess.access.canManage) {
    return c.json({ error: 'all_permission_required' }, 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const expectedRevision = Number(payload.revision);
  const nextConfig = payload.config;
  if (
    !Number.isInteger(expectedRevision) ||
    !nextConfig ||
    typeof nextConfig !== 'object' ||
    Array.isArray(nextConfig)
  ) {
    return c.json({ error: 'invalid_settings_payload' }, 400);
  }

  const { configRepository } = getRepositories();
  const result = await configRepository.saveConfig({
    expectedRevision,
    nextConfig: nextConfig as StrikeLedgerConfig,
    moderatorUsername: apiAccess.access.username,
    timestampMs: Date.now(),
  });

  if (result.status === 'conflict') {
    return c.json(result, 409);
  }

  if (result.status === 'invalid') {
    return c.json(result, 400);
  }

  return c.json(result);
});

api.post('/recalculate-user-total', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  if (!apiAccess.access.canManage) {
    return c.json({ error: 'all_permission_required' }, 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const { configRepository, dashboardRepository, ledgerRepository } =
    getRepositories();
  const context = await getAuthorizedViewContext(
    trimString(payload.contextToken) ?? undefined,
    apiAccess.subredditName,
    dashboardRepository
  );
  const rawUserKey = trimString(payload.userKey);
  const username = trimString(payload.username);
  const userKey =
    context?.userKey ??
    (rawUserKey?.startsWith('id:') || rawUserKey?.startsWith('name:')
      ? rawUserKey
      : username
        ? `name:${username.toLowerCase()}`
        : null);

  if (!userKey) {
    return c.json({ error: 'missing_user' }, 400);
  }

  const activeTotal = await ledgerRepository.recalculateActiveTotal(
    userKey,
    await configRepository.getConfig(),
    Date.now()
  );

  return c.json({ userKey, activeTotal });
});

api.post('/reverse', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const entryId = trimString(payload.entryId);
  const reversalReason = trimString(payload.reversalReason);
  const reversalNote = trimString(payload.reversalNote);
  const { configRepository, ledgerRepository } = getRepositories();
  const config = await configRepository.getConfig();
  const addNativeModNote =
    typeof payload.addNativeModNote === 'boolean'
      ? payload.addNativeModNote
      : config.reversalNativeModNotesEnabled;

  if (!entryId || !reversalReason) {
    return c.json({ error: 'missing_required_fields' }, 400);
  }

  const existingEntry = await ledgerRepository.getLedgerEntry(entryId);
  if (
    !existingEntry ||
    existingEntry.subredditName.toLowerCase() !==
      apiAccess.subredditName.toLowerCase()
  ) {
    return c.json({ error: 'not_found' }, 404);
  }

  const nowMs = Date.now();
  const result = await ledgerRepository.reverseLedgerEntry({
    entryId,
    reversedAtMs: nowMs,
    reversedBy: apiAccess.access.username,
    reversalReason,
    ...(reversalNote ? { reversalNote } : {}),
    config,
    nowMs,
  });

  if (result.status === 'not_found') {
    return c.json({ error: 'not_found' }, 404);
  }

  if (result.status === 'already_reversed') {
    return c.json({
      status: 'already_reversed',
      activeTotal: result.activeTotal,
      entry: serializeEntry(result.entry, nowMs, config),
    });
  }

  const updatedEntry = await executeReversalSideEffects({
    entry: result.entry,
    activeTotal: result.activeTotal,
    reddit,
    config,
    addNativeModNote,
  });
  await ledgerRepository.updateLedgerEntry(updatedEntry);

  return c.json({
    status: 'reversed',
    activeTotal: result.activeTotal,
    entry: serializeEntry(updatedEntry, nowMs, config),
    sideEffects: updatedEntry.sideEffects,
  });
});
