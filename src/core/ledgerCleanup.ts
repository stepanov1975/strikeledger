import type { ConfigRepository } from './configRepository';
import type { LedgerRepository } from './ledgerRepository';

export const DEFAULT_LEDGER_CLEANUP_RETENTION_DAYS = 365;
export const DEFAULT_LEDGER_CLEANUP_BATCH_SIZE = 500;
export const MAX_LEDGER_CLEANUP_BATCH_SIZE = 500;

export type LedgerCleanupOptions = {
  retentionDays: number;
  maxEntries: number;
};

export type LedgerCleanupRunResult = LedgerCleanupOptions & {
  scanned: number;
  deleted: number;
};

export const normalizeLedgerCleanupOptions = (
  payload: Record<string, unknown> = {}
): LedgerCleanupOptions => {
  const requestedRetentionDays = Number(payload.retentionDays);
  const retentionDays =
    Number.isInteger(requestedRetentionDays) && requestedRetentionDays > 0
      ? requestedRetentionDays
      : DEFAULT_LEDGER_CLEANUP_RETENTION_DAYS;
  const requestedMaxEntries = Number(payload.maxEntries);
  const maxEntries =
    Number.isInteger(requestedMaxEntries) && requestedMaxEntries > 0
      ? Math.min(requestedMaxEntries, MAX_LEDGER_CLEANUP_BATCH_SIZE)
      : DEFAULT_LEDGER_CLEANUP_BATCH_SIZE;

  return { retentionDays, maxEntries };
};

export const runLedgerCleanup = async (input: {
  subredditName: string;
  configRepository: ConfigRepository;
  ledgerRepository: LedgerRepository;
  nowMs: number;
  payload?: Record<string, unknown>;
}): Promise<LedgerCleanupRunResult> => {
  const options = normalizeLedgerCleanupOptions(input.payload);
  const result = await input.ledgerRepository.cleanupLedger({
    subredditName: input.subredditName,
    config: await input.configRepository.getConfig(),
    nowMs: input.nowMs,
    retentionDays: options.retentionDays,
    maxEntries: options.maxEntries,
  });

  return { ...result, ...options };
};
