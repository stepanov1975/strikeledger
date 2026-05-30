import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import type { ActivePointInput } from './scoring';
import {
  MS_PER_DAY,
  calculateActivePoints,
  recalculateActiveTotal,
} from './scoring';

const nowMs = Date.UTC(2026, 0, 1);

const entry = (
  originalPoints: number,
  ageDays: number,
  status: ActivePointInput['status'] = 'succeeded'
): ActivePointInput => ({
  originalPoints,
  createdAtMs: nowMs - ageDays * MS_PER_DAY,
  status,
});

describe('scoring', () => {
  it.each([
    [1, 0, 1],
    [1, 29, 1],
    [1, 30, 0],
    [3, 0, 3],
    [3, 30, 2],
    [3, 60, 1],
    [3, 90, 0],
  ])(
    'calculates active points for %i original points at %i days old',
    (originalPoints, ageDays, expectedActivePoints) => {
      expect(
        calculateActivePoints(
          entry(originalPoints, ageDays),
          DEFAULT_CONFIG,
          nowMs
        )
      ).toBe(expectedActivePoints);
    }
  );

  it('clamps future timestamps to full active points', () => {
    expect(
      calculateActivePoints(
        {
          originalPoints: 3,
          createdAtMs: nowMs + MS_PER_DAY,
          status: 'succeeded',
        },
        DEFAULT_CONFIG,
        nowMs
      )
    ).toBe(3);
  });

  it('returns zero active points for reversed entries', () => {
    expect(calculateActivePoints(entry(3, 0, 'reversed'), DEFAULT_CONFIG, nowMs))
      .toBe(0);
  });

  it('recalculates active totals from non-reversed entries', () => {
    expect(
      recalculateActiveTotal(
        [entry(3, 0), entry(3, 60), entry(3, 0, 'reversed')],
        DEFAULT_CONFIG,
        nowMs
      )
    ).toBe(4);
  });
});
