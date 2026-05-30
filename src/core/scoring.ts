import type { LedgerEntry, StrikeLedgerConfig } from './domain';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ActivePointInput = Pick<
  LedgerEntry,
  'createdAtMs' | 'originalPoints' | 'status'
> & {
  reversedAtMs?: number;
};

export const getDecayIntervalMs = (config: StrikeLedgerConfig): number =>
  config.decayIntervalDays * MS_PER_DAY;

export const calculateActivePoints = (
  entry: ActivePointInput,
  config: StrikeLedgerConfig,
  nowMs: number
): number => {
  if (entry.status === 'reversed' || entry.reversedAtMs !== undefined) {
    return 0;
  }

  const ageMs = Math.max(0, nowMs - entry.createdAtMs);
  const decaySteps = Math.floor(ageMs / getDecayIntervalMs(config));
  const decayedPoints = config.decayAmount * decaySteps;

  return Math.max(0, entry.originalPoints - decayedPoints);
};

export const recalculateActiveTotal = (
  entries: ActivePointInput[],
  config: StrikeLedgerConfig,
  nowMs: number
): number =>
  entries.reduce(
    (total, entry) => total + calculateActivePoints(entry, config, nowMs),
    0
  );
