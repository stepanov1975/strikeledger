import { Hono } from 'hono';
import { reddit, redis, settings } from '@devvit/web/server';
import { ConfigRepository } from '../core/configRepository';
import { DashboardRepository, type ViewContextRecord } from '../core/dashboard';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import {
  ACTION_LABELS,
  type LedgerEntry,
  type StrikeLedgerConfig,
} from '../core/domain';
import { getUserKey } from '../core/identity';
import { runLedgerCleanup } from '../core/ledgerCleanup';
import { LedgerRepository } from '../core/ledgerRepository';
import { logInfo, logWarn, type LogDetails } from '../core/logging';
import { calculateActivePoints } from '../core/scoring';
import { executeReversalSideEffects } from '../core/sideEffects';
import { getModeratorAccess, type ModeratorAccess } from './permissions';

export const api = new Hono();

const HISTORY_PAGE_SIZE = 25;
const MAX_HISTORY_OFFSET = 500;
const INLINE_PROFILE_SUMMARY_ENTRY_LIMIT = 25;
const SELF_HISTORY_LIMIT = 25;

const getRepositories = () => {
  const store = new DevvitRedisStore(redis);
  return {
    store,
    configRepository: new ConfigRepository(store, settings),
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
  userKey?: string;
  targetId?: string;
  targetKind?: ViewContextRecord['targetKind'];
  authorName?: string;
};

type AuthorizedUserViewContextResult =
  | { status: 'ok'; context: UserViewContext | null }
  | { status: 'denied' };

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

const parseHistoryOffset = (value: string | undefined): number | null => {
  if (value === undefined) {
    return 0;
  }

  const offset = Number(value);
  return Number.isInteger(offset) && offset >= 0 && offset <= MAX_HISTORY_OFFSET
    ? offset
    : null;
};

const trimString = (value: unknown): string | null =>
  typeof value === 'string' ? value.trim() : null;

const isEntryForSubredditName = (
  entry: LedgerEntry,
  subredditName: string
): boolean =>
  entry.subredditName.toLowerCase() === subredditName.trim().toLowerCase();

const parseUserIdInput = (rawUserKey: string | null): string | null => {
  if (rawUserKey?.startsWith('id:')) {
    const userId = rawUserKey.slice(3).trim();
    return getUserKey({ userId }) ? userId : null;
  }

  return null;
};

const trimUsernamePrefix = (username: string): string =>
  username.trim().replace(/^u\//i, '');

const trimRulePrefix = (label: string): string =>
  label
    .trim()
    .replace(/^(?:rule\s*)?\d+(?!\.\d)\s*[-:.)]?\s*/i, '')
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

const getUserLookupContext = async (
  subredditName: string,
  rawUserKey: string | null,
  username: string | null
): Promise<UserViewContext | null> => {
  const rawAuthorName = username;
  const authorName = rawAuthorName ? trimUsernamePrefix(rawAuthorName) : null;
  const userId = parseUserIdInput(rawUserKey);

  if (userId) {
    const user = await reddit.getUserById(userId as `t2_${string}`);
    const resolvedUserKey = user?.id ? getUserKey({ userId: user.id }) : null;
    if (!resolvedUserKey) {
      return null;
    }
    const resolvedAuthorName = user?.username ?? authorName;

    return {
      subredditName,
      userKey: resolvedUserKey,
      ...(resolvedAuthorName ? { authorName: resolvedAuthorName } : {}),
    };
  }

  if (!authorName) {
    return null;
  }

  const user = await reddit.getUserByUsername(authorName);
  const resolvedUserKey = user?.id ? getUserKey({ userId: user.id }) : null;
  if (!resolvedUserKey) {
    return null;
  }

  return {
    subredditName,
    userKey: resolvedUserKey,
    authorName: user?.username ?? authorName,
  };
};

const getContextUserKeys = (context: UserViewContext): string[] => {
  if (!context.userKey) {
    return [];
  }

  return [context.userKey];
};

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const getEntryUserKeys = (entry: LedgerEntry): string[] => {
  return uniqueStrings([entry.userKey]);
};

const getReversalUserScope = (
  entry: LedgerEntry,
  context: UserViewContext | null
): { userKeys: string[]; cacheUserKey: string } => {
  const entryKeys = getEntryUserKeys(entry);
  if (!context?.userKey) {
    return { userKeys: entryKeys, cacheUserKey: entry.userKey };
  }

  const contextKeys = getContextUserKeys(context);
  const contextMatchesEntry = entryKeys.some((key) =>
    contextKeys.includes(key)
  );
  if (!contextMatchesEntry) {
    return { userKeys: entryKeys, cacheUserKey: entry.userKey };
  }

  return {
    userKeys: uniqueStrings([...entryKeys, ...contextKeys]),
    cacheUserKey: context.userKey,
  };
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
  access: ModeratorAccess,
  rawUserKey: string | null = null,
  username: string | null = null
): Promise<AuthorizedUserViewContextResult> => {
  const tokenContext = await getAuthorizedViewContext(
    token,
    subredditName,
    dashboardRepository
  );
  if (tokenContext) {
    return { status: 'ok', context: tokenContext };
  }

  if ((rawUserKey || username) && !access.canManage) {
    return { status: 'denied' };
  }

  const lookupContext = await getUserLookupContext(
    subredditName,
    rawUserKey,
    username
  );
  if (!lookupContext) {
    return { status: 'ok', context: null };
  }

  return { status: 'ok', context: lookupContext };
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
  targetDeletedAtMs: entry.targetDeletedAtMs,
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
  reversalNote: entry.reversalNote,
});

const serializeSelfSummaryEntry = (
  entry: LedgerEntry,
  nowMs: number,
  config: StrikeLedgerConfig
): Record<string, unknown> => ({
  createdAtMs: entry.createdAtMs,
  ruleLabel: entry.ruleLabel,
  activePoints: calculateActivePoints(entry, config, nowMs),
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

const buildProfileSummary = (
  entries: LedgerEntry[],
  activeTotal: number,
  config: StrikeLedgerConfig,
  nowMs: number,
  hasMoreEntries: boolean,
  summaryEntryLimit: number
) => {
  const activeOriginalPoints = entries
    .filter((entry) => entry.status !== 'reversed')
    .reduce((total, entry) => total + entry.originalPoints, 0);
  const activePointsInSummary = entries.reduce(
    (total, entry) => total + calculateActivePoints(entry, config, nowMs),
    0
  );
  const originalPoints = entries.reduce(
    (total, entry) => total + entry.originalPoints,
    0
  );
  const reversedEntries = entries.filter(
    (entry) => entry.status === 'reversed'
  ).length;
  const removalsByRule = entries
    .filter((entry) => entry.action === 'warn_remove')
    .reduce<Record<string, number>>((counts, entry) => {
      counts[entry.ruleLabel] = (counts[entry.ruleLabel] ?? 0) + 1;
      return counts;
    }, {});

  return {
    activeTotal,
    originalPoints,
    decayedPoints: Math.max(0, activeOriginalPoints - activePointsInSummary),
    reversedEntries,
    removalsByRule,
    hasMoreEntries,
    summaryEntryLimit,
  };
};

api.get('/bootstrap', async (c) => {
  const subreddit = await reddit.getCurrentSubreddit();
  const access = await getModeratorAccess(subreddit.name);
  if (!access?.canRead) {
    logInfo('api.bootstrap.limited', {
      subredditName: subreddit.name,
      username: access?.username,
    });
    return c.json({
      view: 'limited',
      subredditName: subreddit.name,
      currentUsername: access?.username ?? null,
      hasPendingBootstrap: false,
    });
  }

  const { dashboardRepository } = getRepositories();
  const bootstrap = await dashboardRepository.consumeDashboardBootstrap(
    subreddit.name,
    access.username
  );
  const view = bootstrap?.view ?? 'settings';
  logInfo('api.bootstrap.ok', {
    view,
    subredditName: subreddit.name,
    moderatorUsername: access.username,
    hasContextToken: bootstrap?.contextToken !== undefined,
  });

  return c.json({
    view,
    subredditName: subreddit.name,
    currentUsername: access.username,
    moderatorUsername: access.username,
    hasPendingBootstrap: bootstrap !== null,
    ...(bootstrap?.contextToken !== undefined
      ? { contextToken: bootstrap.contextToken }
      : {}),
  });
});

api.get('/inline-profile-preview', async (c) => {
  const subreddit = await reddit.getCurrentSubreddit();
  const access = await getModeratorAccess(subreddit.name);
  const unavailable = {
    status: 'unavailable',
    subredditName: subreddit.name,
    currentUsername: access?.username ?? null,
    ...(access?.canRead ? { moderatorUsername: access.username } : {}),
  };

  if (!access?.canRead) {
    return c.json(unavailable);
  }

  const { configRepository, dashboardRepository, ledgerRepository } =
    getRepositories();
  const bootstrap = await dashboardRepository.getDashboardBootstrap(
    subreddit.name,
    access.username
  );
  if (bootstrap?.view === 'history' && bootstrap.contextToken) {
    return c.json({
      status: 'history',
      contextToken: bootstrap.contextToken,
      subredditName: subreddit.name,
      currentUsername: access.username,
      moderatorUsername: access.username,
    });
  }

  if (bootstrap?.view !== 'profile' || !bootstrap.contextToken) {
    return c.json(unavailable);
  }

  const context = await getAuthorizedViewContext(
    bootstrap.contextToken,
    subreddit.name,
    dashboardRepository
  );
  if (!context?.userKey) {
    return c.json(unavailable);
  }

  const profileContext = { ...context, userKey: context.userKey };
  const config = await configRepository.getConfig();
  const activeTotal = await ledgerRepository.getCachedActiveTotal(
    profileContext.userKey
  );
  if (activeTotal === null) {
    return c.json(unavailable);
  }

  const nowMs = Date.now();
  const userKeys = getContextUserKeys(profileContext);
  const rawPreviewEntries = await ledgerRepository.getUserLedgerPageForKeys(
    userKeys,
    0,
    INLINE_PROFILE_SUMMARY_ENTRY_LIMIT + 1
  );
  const profileEntries = rawPreviewEntries.filter((entry) =>
    isEntryForSubredditName(entry, subreddit.name)
  );
  const hasMoreEntries =
    rawPreviewEntries.length > INLINE_PROFILE_SUMMARY_ENTRY_LIMIT;
  const entries = profileEntries.slice(0, INLINE_PROFILE_SUMMARY_ENTRY_LIMIT);
  const summary = buildProfileSummary(
    entries,
    activeTotal,
    config,
    nowMs,
    hasMoreEntries,
    INLINE_PROFILE_SUMMARY_ENTRY_LIMIT
  );
  logInfo('api.inline_profile_preview.ok', {
    subredditName: subreddit.name,
    moderatorUsername: access.username,
    userKey: profileContext.userKey,
    targetId: profileContext.targetId,
    targetKind: profileContext.targetKind,
    activeTotal: summary.activeTotal,
  });

  return c.json({
    status: 'available',
    contextToken: bootstrap.contextToken,
    context: profileContext,
    summary,
  });
});

api.get('/self-summary', async (c) => {
  const subreddit = await reddit.getCurrentSubreddit();
  const user = await reddit.getCurrentUser();
  if (!user) {
    return c.json({ error: 'login_required' }, 401);
  }

  const primaryUserKey = getUserKey({
    userId: user.id,
  });
  const userKeys = uniqueStrings([
    ...(primaryUserKey ? [primaryUserKey] : []),
  ]);
  if (!primaryUserKey || userKeys.length === 0) {
    return c.json({ error: 'unsupported_user' }, 400);
  }

  const { configRepository, ledgerRepository } = getRepositories();
  const config = await configRepository.getConfig();
  const nowMs = Date.now();
  const activeTotal = await ledgerRepository.recalculateActiveTotalForKeys(
    userKeys,
    primaryUserKey,
    config,
    nowMs,
    subreddit.name
  );
  const entries = await ledgerRepository.getUserLedgerPageForKeys(
    userKeys,
    0,
    SELF_HISTORY_LIMIT,
    subreddit.name
  );

  logInfo('api.self_summary.ok', {
    subredditName: subreddit.name,
    username: user.username,
    entryCount: entries.length,
    activeTotal,
  });

  return c.json({
    subredditName: subreddit.name,
    username: user.username,
    activeTotal,
    entries: entries.map((entry) =>
      serializeSelfSummaryEntry(entry, nowMs, config)
    ),
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
  const contextResult = await getAuthorizedUserViewContext(
    c.req.query('contextToken'),
    apiAccess.subredditName,
    dashboardRepository,
    apiAccess.access,
    trimString(c.req.query('userKey')),
    trimString(c.req.query('username'))
  );
  if (contextResult.status === 'denied') {
    logWarn('api.history.user_lookup.denied', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
    return c.json({ error: 'all_permission_required' }, 403);
  }

  const context = contextResult.context;
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
  const offset = parseHistoryOffset(c.req.query('offset'));
  if (offset === null) {
    logWarn('api.history.invalid_offset', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      offset: c.req.query('offset'),
    });
    return c.json({ error: 'invalid_offset' }, 400);
  }

  const userKeys = getContextUserKeys(context);
  const entries =
    userKeys.length > 0
      ? await ledgerRepository.getUserLedgerPageForKeys(
          userKeys,
          offset,
          HISTORY_PAGE_SIZE,
          apiAccess.subredditName
        )
      : context.targetId
        ? await ledgerRepository.getTargetLedgerPage(
            context.targetId,
            offset,
            HISTORY_PAGE_SIZE,
            apiAccess.subredditName
          )
        : [];
  const activeTotal =
    userKeys.length > 0 && context.userKey
      ? await ledgerRepository.recalculateActiveTotalForKeys(
          userKeys,
          context.userKey,
          config,
          nowMs,
          apiAccess.subredditName
        )
      : 0;
  logInfo('api.history.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    userKey: context.userKey,
    targetId: context.targetId,
    targetKind: context.targetKind,
    offset,
    entryCount: entries.length,
    activeTotal,
  });

  const nextOffset = offset + HISTORY_PAGE_SIZE;
  return c.json({
    context,
    activeTotal,
    canAddReversalModNote:
      config.nativeModNotesEnabled && config.reversalNativeModNotesEnabled,
    entries: entries.map((entry) => serializeEntry(entry, nowMs, config)),
    nextOffset:
      entries.length === HISTORY_PAGE_SIZE && nextOffset <= MAX_HISTORY_OFFSET
        ? nextOffset
        : null,
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

api.get('/settings/audit', async (c) => {
  const apiAccess = await getApiAccess('settings.audit');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  if (!apiAccess.access.canManage) {
    logWarn('api.settings.audit.denied', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
    return c.json({ error: 'all_permission_required' }, 403);
  }

  const { configRepository } = getRepositories();
  const records = await configRepository.getSettingsAudit();
  logInfo('api.settings.audit.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    recordCount: records.length,
  });

  return c.json({ records });
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

  const configRevision = (nextConfig as { revision?: unknown }).revision;
  if (
    typeof configRevision !== 'number' ||
    !Number.isInteger(configRevision) ||
    configRevision !== expectedRevision
  ) {
    logWarn('api.settings.save.revision_mismatch', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
      expectedRevision,
      hasConfigRevision: configRevision !== undefined,
    });
    return c.json(
      {
        status: 'invalid',
        issues: [
          {
            path: 'revision',
            message: 'Config revision must match request revision.',
          },
        ],
      },
      400
    );
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
    (await getUserLookupContext(apiAccess.subredditName, rawUserKey, username));
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
    Date.now(),
    apiAccess.subredditName
  );
  logInfo('api.recalculate.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    userKey,
    activeTotal,
  });

  return c.json({ userKey, activeTotal });
});

api.post('/cleanup-ledger', async (c) => {
  const apiAccess = await getApiAccess('cleanup-ledger');
  if (!apiAccess) {
    return c.json({ error: 'moderator_required' }, 403);
  }

  if (!apiAccess.access.canManage) {
    logWarn('api.cleanup.denied', {
      subredditName: apiAccess.subredditName,
      moderatorUsername: apiAccess.access.username,
    });
    return c.json({ error: 'all_permission_required' }, 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    payload = {};
  }

  const { configRepository, ledgerRepository } = getRepositories();
  const result = await runLedgerCleanup({
    subredditName: apiAccess.subredditName,
    configRepository,
    ledgerRepository,
    nowMs: Date.now(),
    payload,
  });
  logInfo('api.cleanup.ok', {
    subredditName: apiAccess.subredditName,
    moderatorUsername: apiAccess.access.username,
    retentionDays: result.retentionDays,
    maxEntries: result.maxEntries,
    scanned: result.scanned,
    deleted: result.deleted,
  });

  return c.json(result);
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
  const wantsNativeModNote = payload.addNativeModNote !== false;
  const { configRepository, dashboardRepository, ledgerRepository } =
    getRepositories();
  const config = await configRepository.getConfig();
  const addNativeModNote =
    config.nativeModNotesEnabled &&
    config.reversalNativeModNotesEnabled &&
    wantsNativeModNote;

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
  const reversalContext = await getAuthorizedViewContext(
    trimString(payload.contextToken) ?? undefined,
    apiAccess.subredditName,
    dashboardRepository
  );
  const reversalUserScope = getReversalUserScope(existingEntry, reversalContext);
  const result = await ledgerRepository.reverseLedgerEntry({
    entryId,
    reversedAtMs: nowMs,
    reversedBy: apiAccess.access.username,
    reversalReason,
    ...(reversalNote ? { reversalNote } : {}),
    userKeys: reversalUserScope.userKeys,
    cacheUserKey: reversalUserScope.cacheUserKey,
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
    persistEntry: async (checkpointEntry) => {
      await ledgerRepository.updateLedgerEntrySideEffects(checkpointEntry);
    },
  });
  await ledgerRepository.updateLedgerEntrySideEffects(updatedEntry);
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
