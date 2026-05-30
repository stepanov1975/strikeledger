import { Hono } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { reddit, redis } from '@devvit/web/server';
import type { Comment, Post } from '@devvit/web/server';
import type { FormField } from '@devvit/shared-types/shared/form.js';
import type { T1, T3 } from '@devvit/shared-types/tid.js';
import { DEFAULT_CONFIG } from '../core/config';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import { ACTION_LABELS, type StrikeAction, type TargetKind } from '../core/domain';
import {
  createFormNonceRecordTimes,
  getEnabledRules,
  type TargetAuthorSnapshot,
} from '../core/enforcement';
import { getUserKey } from '../core/identity';
import { LedgerRepository, type FormNonceRecord } from '../core/ledgerRepository';

export const menu = new Hono();

const getRepository = () => new LedgerRepository(new DevvitRedisStore(redis));

const buildRuleOptions = () =>
  getEnabledRules(DEFAULT_CONFIG).map((rule) => ({
    label: rule.label,
    value: rule.id,
  }));

const buildEnforcementFields = (
  formNonce: string,
  action: StrikeAction
): FormField[] => [
  {
    name: 'ruleId',
    label: 'Rule',
    type: 'select',
    options: buildRuleOptions(),
    required: true,
    defaultValue: [DEFAULT_CONFIG.rules[0]?.id ?? 'rule-general'],
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
    label: 'StrikeLedger internal nonce',
    type: 'string',
    required: true,
    defaultValue: formNonce,
  },
];

const buildEnforcementForm = (formNonce: string, action: StrikeAction) => ({
  title: `StrikeLedger: ${ACTION_LABELS[action]}`,
  acceptLabel: ACTION_LABELS[action],
  cancelLabel: 'Cancel',
  fields: buildEnforcementFields(formNonce, action),
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
    ...(author.authorId !== undefined ? { authorId: author.authorId } : {}),
    ...(author.authorName !== undefined ? { authorName: author.authorName } : {}),
    action,
    moderatorUsername,
    ...times,
  };
};

const ensureModeratorCanEnforce = async (subredditName: string) => {
  const user = await reddit.getCurrentUser();
  if (!user) {
    return null;
  }

  const permissions = await user.getModPermissionsForSubreddit(subredditName);
  const canEnforce =
    permissions.includes('all') || permissions.includes('posts');

  if (!canEnforce) {
    return null;
  }

  return user.username;
};

const openEnforcementForm = async (
  request: MenuItemRequest,
  action: StrikeAction,
  targetKind: TargetKind
): Promise<UiResponse> => {
  const nowMs = Date.now();
  const target =
    targetKind === 'post'
      ? await reddit.getPostById(request.targetId as T3)
      : await reddit.getCommentById(request.targetId as T1);
  const moderatorUsername = await ensureModeratorCanEnforce(target.subredditName);

  if (!moderatorUsername) {
    return {
      showToast: 'StrikeLedger requires posts or all moderator permission.',
    };
  }

  const nonceRecord = buildNonceRecord(
    target,
    targetKind,
    action,
    moderatorUsername,
    nowMs
  );
  if (!nonceRecord) {
    return { showToast: 'StrikeLedger cannot warn content without an author.' };
  }

  await getRepository().saveFormNonce(nonceRecord);

  return {
    showForm: {
      name: 'strikeledgerEnforcement',
      form: buildEnforcementForm(nonceRecord.nonce, action),
    },
  };
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

menu.post('/history', (c) =>
  c.json<UiResponse>({ showToast: 'StrikeLedger history UI is not wired yet.' })
);

menu.post('/profile', (c) =>
  c.json<UiResponse>({ showToast: 'StrikeLedger profile UI is not wired yet.' })
);

menu.post('/settings', (c) =>
  c.json<UiResponse>({ showToast: 'StrikeLedger settings UI is not wired yet.' })
);
