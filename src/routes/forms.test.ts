import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SIDE_EFFECTS,
  SCHEMA_VERSION,
  type LedgerEntry,
} from '../core/domain';

const buildEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: SCHEMA_VERSION,
  entryId: 'entry-1',
  subredditName: 'testsub',
  username: 'target-user',
  userKey: 'id:t2_user',
  targetId: 't3_target',
  targetKind: 'post',
  targetPermalink: '/r/testsub/comments/target',
  action: 'warn_remove',
  ruleId: 'rule-general',
  ruleLabel: 'Community rule violation',
  publicCommentOverrideUsed: false,
  originalPoints: 3,
  moderatorUsername: 'mod-a',
  createdAtMs: Date.UTC(2026, 0, 1),
  status: 'succeeded',
  idempotencyKey: 'retry',
  duplicateKey: 'duplicate',
  moderatorRetryKey: 'retry',
  idempotencyInputs: {},
  formNonce: 'nonce-1',
  sideEffects: { ...EMPTY_SIDE_EFFECTS },
  ...overrides,
});

describe('forms helpers', () => {
  it('identifies failed side effects in partial success toasts', async () => {
    vi.resetModules();
    vi.doMock('@devvit/web/server', () => ({ reddit: {}, redis: {} }));
    const { formatCreatedToast } = await import('./forms');

    const toast = formatCreatedToast(
      buildEntry({
        status: 'partial',
        sideEffects: {
          ...EMPTY_SIDE_EFFECTS,
          publicComment: 'failed',
          remove: 'failed',
          publicCommentOptions: {
            sticky: 'failed',
            lock: 'succeeded',
          },
        },
      }),
      4
    );

    expect(toast).toContain('public comment');
    expect(toast).toContain('remove target');
    expect(toast).toContain('sticky warning comment');
    expect(toast).not.toContain('one or more Reddit side effects');
  });
});
