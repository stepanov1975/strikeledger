import { describe, expect, it } from 'vitest';
import { normalizeLedgerCleanupOptions } from './ledgerCleanup';

describe('ledger cleanup options', () => {
  it('uses a larger bounded automatic cleanup batch', () => {
    expect(normalizeLedgerCleanupOptions()).toEqual({
      retentionDays: 365,
      maxEntries: 2000,
      maxRuntimeMs: 10_000,
    });
  });

  it('caps requested cleanup batches', () => {
    expect(
      normalizeLedgerCleanupOptions({
        retentionDays: 90,
        maxEntries: 999_999,
        maxRuntimeMs: 999_999,
      })
    ).toEqual({
      retentionDays: 90,
      maxEntries: 5000,
      maxRuntimeMs: 30_000,
    });
  });
});
