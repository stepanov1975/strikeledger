import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createDuplicateKey,
  createModeratorRetryKey,
  getDuplicateClaimKey,
  getRetryBucket,
  getRetryClaimKey,
} from './idempotency';

describe('idempotency helpers', () => {
  it('canonicalizes object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: 'x' } })).toBe(
      '{"a":{"c":"x","d":true},"b":1}'
    );
  });

  it('builds stable duplicate hashes independent of property order', () => {
    expect(
      createDuplicateKey({
        targetId: 't3_post',
        action: 'warn',
        ruleId: 'rule-general',
      })
    ).toBe(
      createDuplicateKey({
        ruleId: 'rule-general',
        action: 'warn',
        targetId: 't3_post',
      })
    );
  });

  it('buckets moderator retries into 10 minute windows', () => {
    expect(getRetryBucket(0)).toBe(0);
    expect(getRetryBucket(599_999)).toBe(0);
    expect(getRetryBucket(600_000)).toBe(1);
  });

  it('changes moderator retry hashes across retry buckets', () => {
    const input = {
      targetId: 't1_comment',
      action: 'warn_remove' as const,
      ruleId: 'rule-general',
      moderatorUsername: 'mod-a',
    };

    expect(
      createModeratorRetryKey({ ...input, submittedAtMs: 599_999 })
    ).not.toBe(createModeratorRetryKey({ ...input, submittedAtMs: 600_000 }));
  });

  it('builds MVP Redis claim keys', () => {
    const input = {
      targetId: 't3_post',
      action: 'warn' as const,
      ruleId: 'rule-general',
    };

    expect(getDuplicateClaimKey(input)).toBe(
      'duplicate:t3_post:warn:rule-general'
    );
    expect(
      getRetryClaimKey({
        ...input,
        moderatorUsername: 'mod-a',
        submittedAtMs: 600_000,
      })
    ).toBe('retry:t3_post:warn:rule-general:mod-a:1');
  });
});
