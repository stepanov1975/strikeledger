import { Hono } from 'hono';
import { reddit, redis } from '@devvit/web/server';
import { DEFAULT_CONFIG } from '../core/config';
import { DashboardRepository, type ViewContextRecord } from '../core/dashboard';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import { ACTION_LABELS, type LedgerEntry } from '../core/domain';
import { LedgerRepository } from '../core/ledgerRepository';
import { calculateActivePoints, recalculateActiveTotal } from '../core/scoring';
import { getModeratorAccess, type ModeratorAccess } from './permissions';

export const api = new Hono();

const HISTORY_PAGE_SIZE = 25;

const getRepositories = () => {
  const store = new DevvitRedisStore(redis);
  return {
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
  nowMs: number
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
  activePoints: calculateActivePoints(entry, DEFAULT_CONFIG, nowMs),
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

  const { dashboardRepository, ledgerRepository } = getRepositories();
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
    DEFAULT_CONFIG,
    nowMs
  );

  return c.json({
    context,
    activeTotal,
    entries: entries.map((entry) => serializeEntry(entry, nowMs)),
    nextOffset:
      entries.length === HISTORY_PAGE_SIZE ? offset + HISTORY_PAGE_SIZE : null,
  });
});

api.get('/profile', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { dashboardRepository, ledgerRepository } = getRepositories();
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
  const activeTotal = recalculateActiveTotal(entries, DEFAULT_CONFIG, nowMs);
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
      .map((entry) => serializeEntry(entry, nowMs)),
  });
});

api.get('/settings', async (c) => {
  const apiAccess = await getApiAccess();
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  return c.json({
    subredditName: apiAccess.subredditName,
    canManage: apiAccess.access.canManage,
    config: DEFAULT_CONFIG,
  });
});
