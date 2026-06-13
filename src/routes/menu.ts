import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { reddit, redis, settings } from '@devvit/web/server';
import type { Comment, Post } from '@devvit/web/server';
import type { FormField } from '@devvit/shared-types/shared/form.js';
import type { T1, T3 } from '@devvit/shared-types/tid.js';
import { DEFAULT_CONFIG, getRulePoints } from '../core/config';
import { ConfigRepository } from '../core/configRepository';
import {
  DashboardRepository,
  createExpiringTimes,
  type DashboardView,
} from '../core/dashboard';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import {
  ACTION_LABELS,
  type StrikeAction,
  type StrikeLedgerConfig,
  type TargetKind,
} from '../core/domain';
import {
  createFormNonceRecordTimes,
  getEnabledRules,
  type TargetAuthorSnapshot,
} from '../core/enforcement';
import { getUserKey } from '../core/identity';
import {
  LedgerRepository,
  type FormNonceRecord,
} from '../core/ledgerRepository';
import { logError, logInfo, logWarn } from '../core/logging';
import { getModeratorAccess, type ModeratorAccess } from './permissions';

export const menu = new Hono();

const getRepository = () => new LedgerRepository(new DevvitRedisStore(redis));
const getDashboardRepository = () =>
  new DashboardRepository(new DevvitRedisStore(redis));
const getConfigRepository = () =>
  new ConfigRepository(new DevvitRedisStore(redis), settings);

type DashboardPost = Pick<Post, 'id' | 'permalink' | 'subredditName' | 'url'>;

type DashboardPostResolution =
  | { post: DashboardPost }
  | { response: UiResponse };

const dashboardNavigateTarget = (
  post: DashboardPost
): NonNullable<UiResponse['navigateTo']> => ({
  url: post.url,
  permalink: post.permalink,
});

const getStoredDashboardPost = async (
  subredditName: string
): Promise<DashboardPost | null> => {
  const dashboardRepository = getDashboardRepository();
  const record = await dashboardRepository.getDashboardPost(subredditName);
  if (!record) {
    return null;
  }

  try {
    const post = await reddit.getPostById(record.postId as T3);
    if (post.subredditName.toLowerCase() !== subredditName.toLowerCase()) {
      await dashboardRepository.clearDashboardPost();
      return null;
    }

    return post;
  } catch (error) {
    logError(
      'dashboard.post_unreadable',
      {
        subredditName,
        postId: record.postId,
      },
      error
    );
    await dashboardRepository.clearDashboardPost();
    return null;
  }
};

const createDashboardPost = async (
  subredditName: string,
  nowMs: number
): Promise<DashboardPost> => {
  const post = await reddit.submitCustomPost({
    subredditName,
    title: 'StrikeLedger dashboard',
    entry: 'dashboard',
    textFallback: {
      text: 'StrikeLedger moderation dashboard.',
    },
  });

  await getDashboardRepository().saveDashboardPost({
    postId: post.id,
    subredditName,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  logInfo('dashboard.post_created', {
    subredditName,
    postId: post.id,
  });

  return post;
};

const resolveDashboardPost = async (
  subredditName: string,
  access: ModeratorAccess,
  allowCreate: boolean,
  nowMs: number
): Promise<DashboardPostResolution> => {
  const storedPost = await getStoredDashboardPost(subredditName);
  if (storedPost) {
    return { post: storedPost };
  }

  if (allowCreate && access.canManage) {
    return { post: await createDashboardPost(subredditName, nowMs) };
  }

  logWarn('dashboard.post_missing', {
    subredditName,
    moderatorUsername: access.username,
    allowCreate,
    canManage: access.canManage,
  });

  return {
    response: {
      showToast:
        'StrikeLedger dashboard has not been created. A moderator with all permission must open Admin first.',
    },
  };
};

const saveBootstrapAndNavigate = async (
  post: DashboardPost,
  subredditName: string,
  access: ModeratorAccess,
  view: DashboardView,
  nowMs: number,
  contextToken?: string
): Promise<UiResponse> => {
  const times = createExpiringTimes(nowMs);

  await getDashboardRepository().saveDashboardBootstrap({
    view,
    subredditName,
    moderatorUsername: access.username,
    ...(contextToken !== undefined ? { contextToken } : {}),
    ...times,
  });
  logInfo('dashboard.navigate', {
    view,
    subredditName,
    moderatorUsername: access.username,
    hasContextToken: contextToken !== undefined,
  });

  return { navigateTo: dashboardNavigateTarget(post) };
};

const buildRuleOptions = (config: StrikeLedgerConfig, action: StrikeAction) =>
  getEnabledRules(config).map((rule) => ({
    label: `${rule.label} (+${getRulePoints(config, rule, action)})`,
    value: rule.id,
  }));

export const buildEnforcementFields = (
  formNonce: string,
  action: StrikeAction,
  config: StrikeLedgerConfig
): FormField[] => [
  {
    name: 'ruleId',
    label: 'Rule',
    type: 'select',
    options: buildRuleOptions(config, action),
    required: true,
    defaultValue: [
      getEnabledRules(config)[0]?.id ??
        DEFAULT_CONFIG.rules[0]?.id ??
        'rule-general',
    ],
  },
  {
    name: 'moderatorNote',
    label: 'Moderator note',
    type: 'paragraph',
    required: false,
    helpText: 'Internal note stored with this ledger entry.',
  },
  {
    name: 'publicCommentOverride',
    label: 'Public comment override',
    type: 'paragraph',
    required: false,
    helpText: 'Leave blank to use the configured public template.',
  },
  {
    name: 'confirmation',
    label: 'Confirmation',
    type: 'string',
    defaultValue: `Action: ${ACTION_LABELS[action]}`,
    disabled: true,
  },
  {
    name: 'formNonce',
    label: 'Form token',
    type: 'select',
    required: true,
    options: [{ label: 'Current moderation action', value: formNonce }],
    defaultValue: [formNonce],
  },
];

const buildEnforcementForm = (
  formNonce: string,
  action: StrikeAction,
  config: StrikeLedgerConfig
) => ({
  title: `StrikeLedger: ${ACTION_LABELS[action]}`,
  acceptLabel: ACTION_LABELS[action],
  cancelLabel: 'Cancel',
  fields: buildEnforcementFields(formNonce, action, config),
});

const snapshotAuthor = (
  authorId: string | undefined,
  authorName: string | undefined
): TargetAuthorSnapshot | null => {
  const userKey = getUserKey({
    ...(authorId !== undefined ? { userId: authorId } : {}),
    ...(authorName !== undefined ? { username: authorName } : {}),
  });
  if (!userKey) {
    return null;
  }

  return {
    userKey,
    ...(authorId !== undefined ? { authorId } : {}),
    ...(authorName !== undefined ? { authorName } : {}),
  };
};

const buildNonceRecord = (
  target: Post | Comment,
  targetKind: TargetKind,
  action: StrikeAction,
  moderatorUsername: string,
  nowMs: number
): FormNonceRecord | null => {
  const author = snapshotAuthor(target.authorId, target.authorName);
  if (!author) {
    return null;
  }

  const nonce = crypto.randomUUID();
  const times = createFormNonceRecordTimes(nowMs);

  return {
    nonce,
    targetId: target.id,
    targetKind,
    subredditName: target.subredditName,
    userKey: author.userKey,
    ...(author.authorId !== undefined ? { authorId: author.authorId } : {}),
    ...(author.authorName !== undefined
      ? { authorName: author.authorName }
      : {}),
    action,
    moderatorUsername,
    ...times,
  };
};

const openEnforcementForm = async (
  request: MenuItemRequest,
  action: StrikeAction,
  targetKind: TargetKind
): Promise<UiResponse> => {
  const nowMs = Date.now();
  const config = await getConfigRepository().getConfig();
  const target =
    targetKind === 'post'
      ? await reddit.getPostById(request.targetId as T3)
      : await reddit.getCommentById(request.targetId as T1);
  const access = await getModeratorAccess(target.subredditName);

  if (!access?.canEnforce) {
    logWarn('menu.enforcement.denied', {
      action,
      targetKind,
      targetId: target.id,
      subredditName: target.subredditName,
      moderatorUsername: access?.username,
    });
    return {
      showToast: 'StrikeLedger requires posts or all moderator permission.',
    };
  }

  const nonceRecord = buildNonceRecord(
    target,
    targetKind,
    action,
    access.username,
    nowMs
  );
  if (!nonceRecord) {
    logWarn('menu.enforcement.no_author', {
      action,
      targetKind,
      targetId: target.id,
      subredditName: target.subredditName,
      moderatorUsername: access.username,
    });
    return { showToast: 'StrikeLedger cannot warn content without an author.' };
  }

  await getRepository().saveFormNonce(nonceRecord);
  logInfo('menu.enforcement.form_opened', {
    action,
    targetKind,
    targetId: target.id,
    subredditName: target.subredditName,
    moderatorUsername: access.username,
  });

  return {
    showForm: {
      name: 'strikeledgerEnforcement',
      form: buildEnforcementForm(nonceRecord.nonce, action, config),
    },
  };
};

const buildViewContext = (
  target: Post | Comment,
  targetKind: TargetKind,
  nowMs: number,
  allowTargetOnly: boolean
) => {
  const author = snapshotAuthor(target.authorId, target.authorName);
  if (!author && !allowTargetOnly) {
    return null;
  }

  return {
    token: crypto.randomUUID(),
    targetId: target.id,
    targetKind,
    subredditName: target.subredditName,
    ...(author ?? {}),
    ...createExpiringTimes(nowMs),
  };
};

const openTargetDashboardView = async (
  request: MenuItemRequest,
  targetKind: TargetKind,
  view: Extract<DashboardView, 'history' | 'profile'>
): Promise<UiResponse> => {
  const nowMs = Date.now();
  const target =
    targetKind === 'post'
      ? await reddit.getPostById(request.targetId as T3)
      : await reddit.getCommentById(request.targetId as T1);
  const access = await getModeratorAccess(target.subredditName);

  if (!access?.canRead) {
    logWarn('menu.dashboard.denied', {
      view,
      targetKind,
      targetId: target.id,
      subredditName: target.subredditName,
      moderatorUsername: access?.username,
    });
    return { showToast: 'StrikeLedger requires moderator permission.' };
  }

  const resolution = await resolveDashboardPost(
    target.subredditName,
    access,
    access.canManage,
    nowMs
  );
  if ('response' in resolution) {
    return resolution.response;
  }

  const viewContext = buildViewContext(
    target,
    targetKind,
    nowMs,
    view === 'history'
  );
  if (!viewContext) {
    logWarn('menu.dashboard.no_author', {
      view,
      targetKind,
      targetId: target.id,
      subredditName: target.subredditName,
      moderatorUsername: access.username,
    });
    return { showToast: 'StrikeLedger cannot open a profile without an author.' };
  }

  await getDashboardRepository().saveViewContext(viewContext);
  return saveBootstrapAndNavigate(
    resolution.post,
    target.subredditName,
    access,
    view,
    nowMs,
    viewContext.token
  );
};

const openSettingsDashboard = async (): Promise<UiResponse> => {
  const nowMs = Date.now();
  const subreddit = await reddit.getCurrentSubreddit();
  const access = await getModeratorAccess(subreddit.name);

  if (!access?.canRead) {
    logWarn('menu.settings.denied', {
      subredditName: subreddit.name,
      moderatorUsername: access?.username,
    });
    return { showToast: 'StrikeLedger requires moderator permission.' };
  }

  const resolution = await resolveDashboardPost(
    subreddit.name,
    access,
    true,
    nowMs
  );
  if ('response' in resolution) {
    return resolution.response;
  }

  return saveBootstrapAndNavigate(
    resolution.post,
    subreddit.name,
    access,
    'settings',
    nowMs
  );
};

menu.post('/warn-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(await openEnforcementForm(request, 'warn', 'post'));
});

menu.post('/warn-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    await openEnforcementForm(request, 'warn', 'comment')
  );
});

menu.post('/warn-remove-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    await openEnforcementForm(request, 'warn_remove', 'post')
  );
});

menu.post('/warn-remove-comment', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    await openEnforcementForm(request, 'warn_remove', 'comment')
  );
});

menu.post('/warn-nsfw-post', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  return c.json<UiResponse>(
    await openEnforcementForm(request, 'warn_nsfw', 'post')
  );
});

menu.post('/history', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const targetKind = request.location === 'comment' ? 'comment' : 'post';
  return c.json<UiResponse>(
    await openTargetDashboardView(request, targetKind, 'history')
  );
});

menu.post('/profile', async (c) => {
  const request = await c.req.json<MenuItemRequest>();
  const targetKind = request.location === 'comment' ? 'comment' : 'post';
  return c.json<UiResponse>(
    await openTargetDashboardView(request, targetKind, 'profile')
  );
});

menu.post('/settings', async (c) =>
  c.json<UiResponse>(await openSettingsDashboard())
);
