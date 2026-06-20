import { describe, expect, it } from 'vitest';
import { buildCompactEntryRow } from './compactEntryRows';

describe('buildCompactEntryRow', () => {
  it('formats moderator ledger entries for compact history and profile cards', () => {
    expect(
      buildCompactEntryRow({
        createdAtMs: 1_735_689_600_000,
        ruleLabel: 'Rule 1 - Spam',
        actionLabel: 'Warn and remove',
        activePoints: 2,
        originalPoints: 3,
        status: 'partial',
        targetPermalink: '/r/test/comments/abc/example',
        moderatorUsername: 'mod-a',
        sideEffectSummary: 'remove: failed',
      })
    ).toEqual({
      createdAtMs: 1_735_689_600_000,
      ruleLabel: 'Rule 1 - Spam',
      meta: 'Warn and remove · Partial',
      pointsLabel: '2/3',
      targetPermalink: '/r/test/comments/abc/example',
      targetDeleted: false,
      moderatorLabel: 'u/mod-a',
      sideEffectSummary: 'remove: failed',
    });
  });

  it('marks deleted target entries for text-only rendering', () => {
    expect(
      buildCompactEntryRow({
        createdAtMs: 1_735_689_600_000,
        ruleLabel: 'Rule 1 - Spam',
        actionLabel: 'Warn',
        activePoints: 1,
        originalPoints: 1,
        status: 'succeeded',
        targetPermalink: '',
        targetDeletedAtMs: 1_735_689_700_000,
        moderatorUsername: 'mod-a',
        sideEffectSummary: 'OK',
      }).targetDeleted
    ).toBe(true);
  });
});
