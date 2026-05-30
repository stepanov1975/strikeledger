import type {
  LedgerEntry,
  StrikeLedgerConfig,
  TargetKind,
} from './domain';
import {
  RETRY_WINDOW_MS,
  getDuplicateClaimKey,
  getRetryClaimKey,
} from './idempotency';
import type { RedisStore } from './redisStore';
import { recalculateActiveTotal as calculateActiveTotalFromEntries } from './scoring';

export type FormNonceRecord = {
  nonce: string;
  targetId: string;
  targetKind: TargetKind;
  subredditName: string;
  authorId?: string;
  authorName?: string;
  action: LedgerEntry['action'];
  moderatorUsername: string;
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs?: number;
  entryId?: string;
};

export type CreateLedgerEntryRequest = {
  entry: LedgerEntry;
  formNonce: string;
  submittedAtMs: number;
  nowMs: number;
  config: StrikeLedgerConfig;
};

export type CreateLedgerEntryResult =
  | {
      status: 'created' | 'idempotent';
      entry: LedgerEntry;
      activeTotal: number;
    }
  | {
      status: 'duplicate';
      existingEntry: LedgerEntry;
    }
  | {
      status: 'blocked';
      reason:
        | 'nonce_missing'
        | 'nonce_expired'
        | 'nonce_context_mismatch'
        | 'nonce_consumed_without_entry';
    };

export type ReverseLedgerEntryRequest = {
  entryId: string;
  reversedAtMs: number;
  reversedBy: string;
  reversalReason: string;
  reversalNote?: string;
  config: StrikeLedgerConfig;
  nowMs: number;
};

export type ReverseLedgerEntryResult =
  | {
      status: 'reversed' | 'already_reversed';
      entry: LedgerEntry;
      activeTotal: number;
    }
  | { status: 'not_found' };

const parseJson = <T>(raw: string | null): T | null =>
  raw === null ? null : (JSON.parse(raw) as T);

const ledgerEntryKey = (entryId: string): string => `ledger_entry:${entryId}`;
const formNonceKey = (nonce: string): string => `form_nonce:${nonce}`;
const userLedgerKey = (userKey: string): string => `user:${userKey}:ledger`;
const targetEntriesKey = (targetId: string): string => `target:${targetId}:entries`;
const activeTotalKey = (userKey: string): string => `user:${userKey}:active_total`;

export class LedgerRepository {
  constructor(private readonly store: RedisStore) {}

  async saveFormNonce(record: FormNonceRecord): Promise<void> {
    await this.store.set(formNonceKey(record.nonce), JSON.stringify(record), {
      expiresAtMs: record.expiresAtMs,
    });
  }

  async getLedgerEntry(entryId: string): Promise<LedgerEntry | null> {
    return parseJson<LedgerEntry>(await this.store.get(ledgerEntryKey(entryId)));
  }

  async getUserLedger(userKey: string): Promise<LedgerEntry[]> {
    const entryIds = await this.store.zRange(userLedgerKey(userKey), 0, -1, {
      reverse: true,
    });
    const entries = await Promise.all(
      entryIds.map((entryId) => this.getLedgerEntry(entryId))
    );

    return entries.filter((entry): entry is LedgerEntry => entry !== null);
  }

  async getCachedActiveTotal(userKey: string): Promise<number | null> {
    const rawTotal = await this.store.get(activeTotalKey(userKey));
    return rawTotal === null ? null : Number(rawTotal);
  }

  async createLedgerEntry(
    request: CreateLedgerEntryRequest
  ): Promise<CreateLedgerEntryResult> {
    return this.store.runTransaction(async () => {
      const nonce = await this.getValidNonce(request);
      if (nonce.status === 'blocked') {
        return nonce;
      }

      if (nonce.status === 'consumed') {
        const entry = await this.getLedgerEntry(nonce.entryId);
        if (!entry) {
          return { status: 'blocked', reason: 'nonce_consumed_without_entry' };
        }

        return {
          status: 'idempotent',
          entry,
          activeTotal: await this.recalculateActiveTotal(
            entry.userKey,
            request.config,
            request.nowMs
          ),
        };
      }

      const retryEntry = await this.getRetryEntry(request);
      if (retryEntry) {
        return {
          status: 'idempotent',
          entry: retryEntry,
          activeTotal: await this.recalculateActiveTotal(
            retryEntry.userKey,
            request.config,
            request.nowMs
          ),
        };
      }

      const duplicateEntry = await this.getDuplicateEntry(request.entry);
      if (duplicateEntry && duplicateEntry.status !== 'reversed') {
        return { status: 'duplicate', existingEntry: duplicateEntry };
      }

      await this.writePendingEntry(request, nonce.record);
      const activeTotal = await this.recalculateActiveTotal(
        request.entry.userKey,
        request.config,
        request.nowMs
      );

      return { status: 'created', entry: request.entry, activeTotal };
    });
  }

  async reverseLedgerEntry(
    request: ReverseLedgerEntryRequest
  ): Promise<ReverseLedgerEntryResult> {
    return this.store.runTransaction(async () => {
      const entry = await this.getLedgerEntry(request.entryId);
      if (!entry) {
        return { status: 'not_found' };
      }

      if (entry.status === 'reversed') {
        return {
          status: 'already_reversed',
          entry,
          activeTotal: await this.recalculateActiveTotal(
            entry.userKey,
            request.config,
            request.nowMs
          ),
        };
      }

      const reversedEntry: LedgerEntry = {
        ...entry,
        status: 'reversed',
        reversedAtMs: request.reversedAtMs,
        reversedBy: request.reversedBy,
        reversalReason: request.reversalReason,
        ...(request.reversalNote !== undefined
          ? { reversalNote: request.reversalNote }
          : {}),
      };

      await this.store.set(
        ledgerEntryKey(reversedEntry.entryId),
        JSON.stringify(reversedEntry)
      );
      await this.deleteDuplicateClaimIfCurrent(reversedEntry);
      const activeTotal = await this.recalculateActiveTotal(
        reversedEntry.userKey,
        request.config,
        request.nowMs
      );

      return { status: 'reversed', entry: reversedEntry, activeTotal };
    });
  }

  async recalculateActiveTotal(
    userKey: string,
    config: StrikeLedgerConfig,
    nowMs: number
  ): Promise<number> {
    const entries = await this.getUserLedger(userKey);
    const activeTotal = calculateActiveTotalFromEntries(entries, config, nowMs);
    await this.store.set(activeTotalKey(userKey), String(activeTotal));
    return activeTotal;
  }

  private async getValidNonce(
    request: CreateLedgerEntryRequest
  ): Promise<
    | { status: 'ready'; record: FormNonceRecord }
    | { status: 'consumed'; entryId: string }
    | Extract<CreateLedgerEntryResult, { status: 'blocked' }>
  > {
    const record = parseJson<FormNonceRecord>(
      await this.store.get(formNonceKey(request.formNonce))
    );
    if (!record) {
      return { status: 'blocked', reason: 'nonce_missing' };
    }

    if (record.expiresAtMs <= request.nowMs) {
      return { status: 'blocked', reason: 'nonce_expired' };
    }

    if (
      record.moderatorUsername !== request.entry.moderatorUsername ||
      record.subredditName !== request.entry.subredditName ||
      record.targetId !== request.entry.targetId ||
      record.targetKind !== request.entry.targetKind ||
      record.action !== request.entry.action
    ) {
      return { status: 'blocked', reason: 'nonce_context_mismatch' };
    }

    if (record.consumedAtMs !== undefined) {
      if (record.entryId) {
        return { status: 'consumed', entryId: record.entryId };
      }

      return { status: 'blocked', reason: 'nonce_consumed_without_entry' };
    }

    return { status: 'ready', record };
  }

  private async getRetryEntry(
    request: CreateLedgerEntryRequest
  ): Promise<LedgerEntry | null> {
    const entryId = await this.store.get(
      getRetryClaimKey({
        targetId: request.entry.targetId,
        action: request.entry.action,
        ruleId: request.entry.ruleId,
        moderatorUsername: request.entry.moderatorUsername,
        submittedAtMs: request.submittedAtMs,
      })
    );

    return entryId ? this.getLedgerEntry(entryId) : null;
  }

  private async getDuplicateEntry(
    entry: LedgerEntry
  ): Promise<LedgerEntry | null> {
    const entryId = await this.store.get(
      getDuplicateClaimKey({
        targetId: entry.targetId,
        action: entry.action,
        ruleId: entry.ruleId,
      })
    );

    return entryId ? this.getLedgerEntry(entryId) : null;
  }

  private async writePendingEntry(
    request: CreateLedgerEntryRequest,
    nonce: FormNonceRecord
  ): Promise<void> {
    await this.store.set(
      ledgerEntryKey(request.entry.entryId),
      JSON.stringify(request.entry)
    );
    await this.store.zAdd(userLedgerKey(request.entry.userKey), {
      member: request.entry.entryId,
      score: request.entry.createdAtMs,
    });
    await this.store.zAdd(targetEntriesKey(request.entry.targetId), {
      member: request.entry.entryId,
      score: request.entry.createdAtMs,
    });
    await this.store.set(
      formNonceKey(nonce.nonce),
      JSON.stringify({
        ...nonce,
        consumedAtMs: request.nowMs,
        entryId: request.entry.entryId,
      } satisfies FormNonceRecord),
      { expiresAtMs: nonce.expiresAtMs }
    );
    await this.store.set(
      getDuplicateClaimKey({
        targetId: request.entry.targetId,
        action: request.entry.action,
        ruleId: request.entry.ruleId,
      }),
      request.entry.entryId
    );
    await this.store.set(
      getRetryClaimKey({
        targetId: request.entry.targetId,
        action: request.entry.action,
        ruleId: request.entry.ruleId,
        moderatorUsername: request.entry.moderatorUsername,
        submittedAtMs: request.submittedAtMs,
      }),
      request.entry.entryId,
      { expiresAtMs: request.nowMs + RETRY_WINDOW_MS }
    );
  }

  private async deleteDuplicateClaimIfCurrent(
    entry: LedgerEntry
  ): Promise<void> {
    const duplicateClaimKey = getDuplicateClaimKey({
      targetId: entry.targetId,
      action: entry.action,
      ruleId: entry.ruleId,
    });
    const claimedEntryId = await this.store.get(duplicateClaimKey);

    if (claimedEntryId === entry.entryId) {
      await this.store.del(duplicateClaimKey);
    }
  }
}
