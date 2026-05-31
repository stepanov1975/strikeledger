import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { reddit, redis } from '@devvit/web/server';
import { ConfigRepository } from '../core/configRepository';
import { DevvitRedisStore } from '../core/devvitRedisStore';
import { LedgerRepository } from '../core/ledgerRepository';
import {
  handleEnforcementSubmit,
  type EnforcementFormValues,
} from './enforcementSubmit';

export {
  failedSideEffectLabels,
  formatCreatedToast,
} from './enforcementSubmit';

export const forms = new Hono();

const getRepository = () => new LedgerRepository(new DevvitRedisStore(redis));
const getConfigRepository = () =>
  new ConfigRepository(new DevvitRedisStore(redis));

forms.post('/enforcement-submit', async (c) => {
  const values = await c.req.json<EnforcementFormValues>();
  return c.json<UiResponse>(
    await handleEnforcementSubmit(values, {
      repository: getRepository(),
      configRepository: getConfigRepository(),
      reddit,
    }),
    200
  );
});
