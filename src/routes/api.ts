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
import { getUserKey } from '../core/identity';
import { LedgerRepository } from '../core/ledgerRepository';
import { logInfo, logWarn, type LogDetails } from '../core/logging';
import { getCachedOrLivePostScoreSummary } from '../core/postScore';
import { calculateActivePoints } from '../core/scoring';
import { executeReversalSideEffects } from '../core/sideEffects';
import { getModeratorAccess, type ModeratorAccess } from './permissions';

export const api = new Hono();

const HISTORY_PAGE_SIZE = 25;

const getRepositories = () => {
  const store = new DevvitRedisStore(redis);
  return {
    store,
    configRepository: new ConfigRepository(store),
    dashboardRepository: new DashboardRepository(store),
    ledgerRepository: new LedgerRepository(store),
  };
};

type ApiAccess = {
  subredditName: string;
  access: ModeratorAccess;
};

type UserViewContext = {
  subredditName: string;
  userKey: string;
  targetId?: string;
  targetKind?: ViewContextRecord['targetKind'];
  authorName?: string;
};

type RedditRuleImport = {
  id: string;
  label: string;
  redditShortName: string;
  description: string;
  kind: string;
  violationReason: string;
  priority: number;
  enabled: true;
};

const getApiAccess = async (route: string): Promise<ApiAccess | null> => {
  const subreddit = await reddit.getCurrentSubreddit();
  const access = await getModeratorAccess(subreddit.name);

  if (!access?.canRead) {
    logWarn('api.access.denied', {
      route,
      subredditName: subreddit.name,
      moderatorUsername: access?.username,
    });
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

const parseUserKeyInput = (
  rawUserKey: string | null,
  username: string | null
): string | null => {
  if (rawUserKey?.startsWith('id:')) {
    const userId = rawUserKey.slice(3).trim();
    return userId ? `id:${userId}` : null;
  }

  if (rawUserKey?.startsWith('name:')) {
    return getUserKey({ username: rawUserKey.slice(5) });
  }

  return username ? getUserKey({ username }) : null;
};

const trimUsernamePrefix = (username: string): string =>
  username.trim().replace(/^u\//i, '');

const trimRulePrefix = (label: string): string =>
  label
    .trim()
    .replace(/^(?:rule\s*)?\d+(?:\.\d+)*\s*[-:.)]?\s*/i, '')
    .trim();

const buildImportedRuleLabel = (shortName: string, index: number): string => {
  const name = trimRulePrefix(shortName);
  const ruleNumber = index + 1;

  return name ? `Rule ${ruleNumber} - ${name}` : `Rule ${ruleNumber}`;
};

const serializeRedditRuleImport = (
  rule: {
    shortName: string;
    description: string;
    kind: string;
    violationReason: string;
    priority: number;
  },
  index: number
): RedditRuleImport => ({
  id: `rule-${index + 1}`,
  label: buildImportedRuleLabel(rule.shortName, index),
  redditShortName: rule.shortName,
  description: rule.description,
  kind: rule.kind,
  violationReason: rule.violationReason,
  priority: rule.priority,
  enabled: true,
});

const resolveProfileUsername = (
  context: UserViewContext,
  entries: LedgerEntry[]
): string | null => {
  const username =
    context.authorName ?? entries.find((entry) => entry.username.trim())
      ?.username;

  return username ? trimUsernamePrefix(username) : null;
};

const getUserLookupContext = (
  subredditName: string,
  rawUserKey: string | null,
  username: string | null
): UserViewContext | null => {
  const userKey = parseUserKeyInput(rawUserKey, username);
  if (!userKey) {
    return null;
  }

  const rawAuthorName =
    username ?? (rawUserKey?.startsWith('name:') ? rawUserKey.slice(5) : null);
  const authorName = rawAuthorName ? trimUsernamePrefix(rawAuthorName) : null;

  return {
    subredditName,
    userKey,
    ...(authorName ? { authorName } : {}),
  };
};

const getContextUserKeys = (context: UserViewContext): string[] => {
  const userKeys = [context.userKey];
  if (context.userKey.startsWith('id:') && context.authorName) {
    const fallbackUserKey = getUserKey({ username: context.authorName });
    if (fallbackUserKey && !userKeys.includes(fallbackUserKey)) {
      userKeys.push(fallbackUserKey);
    }
  }

  return userKeys;
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

const getAuthorizedUserViewContext = async (
  token: string | undefined,
  subredditName: string,
  dashboardRepository: DashboardRepository,
  rawUserKey: string | null,
  username: string | null
): Promise<UserViewContext | null> => {
  if (token) {
    return getAuthorizedViewContext(token, subredditName, dashboardRepository);
  }

  return getUserLookupContext(subredditName, rawUserKey, username);
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

const buildReversalLogDetails = (
  entry: LedgerEntry,
  activeTotal: number
): LogDetails => ({
  entryId: entry.entryId,
  subredditName: entry.subredditName,
  moderatorUsername: entry.reversedBy,
  username: entry.username,
  userKey: entry.userKey,
  targetId: entry.targetId,
  targetKind: entry.targetKind,
  action: entry.action,
  ruleId: entry.ruleId,
  status: entry.status,
  activeTotal,
  reversalModNote: entry.sideEffects.reversalModNote,
  reversalUserNotice: entry.sideEffects.reversalUserNotice,
});

api.get('/bootstrap', async (c) => {
  const apiAccess = await getApiAccess('bootstrap');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { dashboardRepository } = getRepositories();
  const bootstrap = await dashboardRepository.consumeDashboardBootstrap(
    apiAccess.subredditName,
    apiAccess.access.username
  );
  const view = bootstrap?.view ?? 'settings';
  logInfo('api.bootstrap.ok', {
    view,
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    hasContextToken: bootstrap?.contextToken !== undefined,
  });

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
  const apiAccess = await getApiAccess('history');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { configRepository, dashboardRepository, ledgerRepository } =
    getRepositories();
  const config = await configRepository.getConfig();
  const context = await getAuthorizedUserViewContext(
    c.req.query('contextToken'),
    apiAccess.subredditName,
    dashboardRepository,
    trimString(c.req.query('userKey')),
    trimString(c.req.query('username'))
  );
  if (!context) {
    logWarn('api.history.invalid_context', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      hasContextToken: c.req.query('contextToken') !== undefined,
      hasUserLookup:
        c.req.query('userKey') !== undefined ||
        c.req.query('username') !== undefined,
    });
    return c.json({ error: 'invalid_context' }, 404);
  }

  const nowMs = Date.now();
  const offset = parseOffset(c.req.query('offset'));
  const userKeys = getContextUserKeys(context);
  const entries = await ledgerRepository.getUserLedgerPageForKeys(
    userKeys,
    offset,
    HISTORY_PAGE_SIZE
  );
  const activeTotal = await ledgerRepository.recalculateActiveTotalForKeys(
    userKeys,
    context.userKey,
    config,
    nowMs
  );
  logInfo('api.history.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    userKey: context.userKey,
    fallbackUserKeyCount: userKeys.length - 1,
    targetId: context.targetId,
    targetKind: context.targetKind,
    offset,
    entryCount: entries.length,
    activeTotal,
  });

  return c.json({
    context,
    activeTotal,
    entries: entries.map((entry) => serializeEntry(entry, nowMs, config)),
    nextOffset:
      entries.length === HISTORY_PAGE_SIZE ? offset + HISTORY_PAGE_SIZE : null,
  });
});

api.get('/profile', async (c) => {
  const apiAccess = await getApiAccess('profile');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { store, configRepository, dashboardRepository, ledgerRepository } =
    getRepositories();
  const config = await configRepository.getConfig();
  const context = await getAuthorizedUserViewContext(
    c.req.query('contextToken'),
    apiAccess.subredditName,
    dashboardRepository,
    trimString(c.req.query('userKey')),
    trimString(c.req.query('username'))
  );
  if (!context) {
    logWarn('api.profile.invalid_context', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      hasContextToken: c.req.query('contextToken') !== undefined,
      hasUserLookup:
        c.req.query('userKey') !== undefined ||
        c.req.query('username') !== undefined,
    });
    return c.json({ error: 'invalid_context' }, 404);
  }

  const nowMs = Date.now();
  const userKeys = getContextUserKeys(context);
  const entries = await ledgerRepository.getUserLedgerForKeys(userKeys);
  const activeTotal = await ledgerRepository.recalculateActiveTotalForKeys(
    userKeys,
    context.userKey,
    config,
    nowMs
  );
  const postScoreSummary = await getCachedOrLivePostScoreSummary({
    store,
    client: reddit,
    userKey: context.userKey,
    username: resolveProfileUsername(context, entries),
    subredditName: apiAccess.subredditName,
    windowDays: config.postScoreWindowDays,
    nowMs,
    onLookupFailure: (error) =>
      logWarn('api.profile.post_score_lookup_failed', {
        subredditName: apiAccess.subredditName,
        userKey: context.userKey,
        message: error instanceof Error ? error.message : String(error),
      }),
  });
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
  logInfo('api.profile.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    userKey: context.userKey,
    fallbackUserKeyCount: userKeys.length - 1,
    targetId: context.targetId,
    targetKind: context.targetKind,
    entryCount: entries.length,
    activeTotal,
    postScorePostCount: postScoreSummary.postScorePostCount,
    postScoreWindowDays: postScoreSummary.postScoreWindowDays,
    reversedEntries: entries.filter((entry) => entry.status === 'reversed')
      .length,
  });

  return c.json({
    context,
    summary: {
      activeTotal,
      lifetimeOriginalPoints,
      decayedPoints: Math.max(0, activeOriginalPoints - activeTotal),
      reversedEntries: entries.filter((entry) => entry.status === 'reversed')
        .length,
      removalsByRule,
      ...postScoreSummary,
    },
    recentEntries: entries
      .slice(0, HISTORY_PAGE_SIZE)
      .map((entry) => serializeEntry(entry, nowMs, config)),
  });
});

api.get('/settings', async (c) => {
  const apiAccess = await getApiAccess('settings');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  const { configRepository } = getRepositories();
  const config = await configRepository.getConfig();
  logInfo('api.settings.read.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    canManage: apiAccess.access.canManage,
    revision: config.revision,
  });

  return c.json({
    subredditName: apiAccess.subredditName,
    canManage: apiAccess.access.canManage,
    config,
  });
});

api.get('/settings/reddit-rules', async (c) => {
  const apiAccess = await getApiAccess('settings.reddit_rules');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  if (!apiAccess.access.canManage) {
    logWarn('api.settings.reddit_rules.denied', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
    return c.json({ error: 'all_permission_required' }, 403);
  }

  const rules = await reddit.getRules(apiAccess.subredditName);
  const importedRules = [...rules]
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }

      return left.shortName.localeCompare(right.shortName);
    })
    .map(serializeRedditRuleImport);

  logInfo('api.settings.reddit_rules.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    ruleCount: importedRules.length,
  });

  return c.json({
    subredditName: apiAccess.subredditName,
    rules: importedRules,
  });
});

api.post('/settings', async (c) => {
  const apiAccess = await getApiAccess('settings.save');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  if (!apiAccess.access.canManage) {
    logWarn('api.settings.save.denied', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
    return c.json({ error: 'all_permission_required' }, 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    logWarn('api.settings.save.invalid_json', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
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
    logWarn('api.settings.save.invalid_payload', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      hasConfig: nextConfig !== undefined,
    });
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
    logWarn('api.settings.save.conflict', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      expectedRevision,
      currentRevision: result.currentRevision,
    });
    return c.json(result, 409);
  }

  if (result.status === 'invalid') {
    logWarn('api.settings.save.invalid_config', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      expectedRevision,
      issueCount: result.issues.length,
    });
    return c.json(result, 400);
  }
  logInfo('api.settings.save.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    revision: result.config.revision,
  });

  return c.json(result);
});

api.post('/recalculate-user-total', async (c) => {
  const apiAccess = await getApiAccess('recalculate-user-total');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  if (!apiAccess.access.canManage) {
    logWarn('api.recalculate.denied', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
    return c.json({ error: 'all_permission_required' }, 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    logWarn('api.recalculate.invalid_json', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
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
  const lookupContext =
    context ??
    getUserLookupContext(apiAccess.subredditName, rawUserKey, username);
  const userKey = lookupContext?.userKey;
  const userKeys = lookupContext ? getContextUserKeys(lookupContext) : [];

  if (!userKey) {
    logWarn('api.recalculate.missing_user', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      hasContext: context !== null,
      hasRawUserKey: Boolean(rawUserKey),
      hasUsername: Boolean(username),
    });
    return c.json({ error: 'missing_user' }, 400);
  }

  const activeTotal = await ledgerRepository.recalculateActiveTotalForKeys(
    userKeys,
    userKey,
    await configRepository.getConfig(),
    Date.now()
  );
  logInfo('api.recalculate.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    userKey,
    activeTotal,
  });

  return c.json({ userKey, activeTotal });
});

api.post('/reverse', async (c) => {
  const apiAccess = await getApiAccess('reverse');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  if (!apiAccess.access.canEnforce) {
    logWarn('api.reverse.denied', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
    return c.json({ error: 'posts_permission_required' }, 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    logWarn('api.reverse.invalid_json', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
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
    logWarn('api.reverse.missing_fields', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      hasEntryId: Boolean(entryId),
      hasReversalReason: Boolean(reversalReason),
    });
    return c.json({ error: 'missing_required_fields' }, 400);
  }

  const existingEntry = await ledgerRepository.getLedgerEntry(entryId);
  if (
    !existingEntry ||
    existingEntry.subredditName.toLowerCase() !==
      apiAccess.subredditName.toLowerCase()
  ) {
    logWarn('api.reverse.not_found', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      entryId,
    });
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
    logWarn('api.reverse.not_found', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      entryId,
    });
    return c.json({ error: 'not_found' }, 404);
  }

  if (result.status === 'already_reversed') {
    logInfo(
      'api.reverse.already_reversed',
      buildReversalLogDetails(result.entry, result.activeTotal)
    );
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
  logInfo(
    'api.reverse.ok',
    buildReversalLogDetails(updatedEntry, result.activeTotal)
  );

  return c.json({
    status: 'reversed',
    activeTotal: result.activeTotal,
    entry: serializeEntry(updatedEntry, nowMs, config),
    sideEffects: updatedEntry.sideEffects,
  });
});
