export type CompactEntryInput = {
  createdAtMs: number;
  ruleLabel: string;
  actionLabel: string;
  activePoints: number;
  originalPoints: number;
  status: string;
  targetPermalink: string;
  moderatorUsername: string;
  sideEffectSummary: string;
};

export type CompactEntryRow = {
  createdAtMs: number;
  ruleLabel: string;
  meta: string;
  pointsLabel: string;
  targetPermalink: string;
  moderatorLabel: string;
  sideEffectSummary: string;
};

const titleCase = (value: string): string =>
  value.length === 0 ? value : value.slice(0, 1).toUpperCase() + value.slice(1);

export const buildCompactEntryRow = (
  entry: CompactEntryInput
): CompactEntryRow => ({
  createdAtMs: entry.createdAtMs,
  ruleLabel: entry.ruleLabel,
  meta: `${entry.actionLabel} · ${titleCase(entry.status)}`,
  pointsLabel: `${entry.activePoints}/${entry.originalPoints}`,
  targetPermalink: entry.targetPermalink,
  moderatorLabel: `u/${entry.moderatorUsername}`,
  sideEffectSummary: entry.sideEffectSummary,
});
