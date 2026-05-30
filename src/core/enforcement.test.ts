import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_RULE } from './config';
import {
  buildInitialSideEffects,
  buildLedgerEntry,
  createFormNonceRecordTimes,
  findEnabledRule,
  normalizeSelectValue,
} from './enforcement';

describe('enforcement helpers', () => {
  it('normalizes Devvit select values', () => {
    expect(normalizeSelectValue(['rule-general'])).toBe('rule-general');
    expect(normalizeSelectValue('rule-general')).toBe('rule-general');
    expect(normalizeSelectValue([])).toBeNull();
    expect(normalizeSelectValue(' ')).toBeNull();
  });

  it('finds enabled rules only', () => {
    expect(findEnabledRule('rule-general')).toEqual(DEFAULT_RULE);
    expect(
      findEnabledRule('rule-disabled', {
        ...DEFAULT_CONFIG,
        rules: [{ id: 'rule-disabled', label: 'Disabled', enabled: false }],
      })
    ).toBeNull();
  });

  it('uses the 10 minute nonce window from the MVP', () => {
    expect(createFormNonceRecordTimes(1000)).toEqual({
      createdAtMs: 1000,
      expiresAtMs: 601000,
    });
  });

  it('marks relevant side effects pending for warn and remove', () => {
    expect(buildInitialSideEffects('warn_remove', DEFAULT_CONFIG)).toMatchObject({
      publicComment: 'pending',
      remove: 'pending',
      markNsfw: 'skipped',
      modNote: 'pending',
      userNotice: 'pending',
    });
  });

  it('builds a pending ledger entry from trusted target context', () => {
    const entry = buildLedgerEntry({
      entryId: 'entry-1',
      formNonce: 'nonce-1',
      action: 'warn',
      rule: DEFAULT_RULE,
      target: {
        targetId: 't3_target',
        targetKind: 'post',
        targetPermalink: '/r/test/comments/target',
        subredditName: 'test',
        author: {
          authorId: 't2_author',
          authorName: 'TargetUser',
          userKey: 'id:t2_author',
        },
      },
      moderatorUsername: 'mod-a',
      createdAtMs: 1000,
      publicCommentOverrideUsed: false,
    });

    expect(entry).toMatchObject({
      schemaVersion: 1,
      entryId: 'entry-1',
      subredditName: 'test',
      userId: 't2_author',
      username: 'TargetUser',
      userKey: 'id:t2_author',
      targetId: 't3_target',
      action: 'warn',
      ruleId: 'rule-general',
      originalPoints: 1,
      status: 'pending',
      formNonce: 'nonce-1',
    });
    expect(entry.duplicateKey).toHaveLength(64);
    expect(entry.moderatorRetryKey).toHaveLength(64);
  });
});
