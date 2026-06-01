import type { LedgerEntry, StrikeLedgerConfig, TargetKind } from './domain';
import { SCHEMA_VERSION as CURRENT_SCHEMA_VERSION } from './domain';
import {
  RETRY_WINDOW_MS,
  getDuplicateClaimKey,
  getRetryClaimKey,
} from './idempotency';
import { getUserKey, normalizeUsername } from './identity';
import { logError } from './logging';
import type { RedisStore } from './redisStore';
import { recalculateActiveTotal as calculateActiveTotalFromEntries } from './scoring';

export type FormNonceRecord = {
  nonce: string;
  targetId: string;
  targetKind: TargetKind;
  subredditName: string;
  userKey?: string;
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

type CreateLedgerEntryTransactionResult =
  | {
      status: 'created';
      entry: LedgerEntry;
    }
  | {
      status: 'idempotent';
      entry: LedgerEntry;
    }
  | Extract<CreateLedgerEntryResult, { status: 'duplicate' | 'blocked' }>;

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

export type IdentityMigrationResult = {
  fromUserKey: string;
  toUserKey: string;
  migratedCount: number;
};

type ReverseLedgerEntryTransactionResult =
  | {
      status: 'reversed';
      entry: LedgerEntry;
    }
  | {
      status: 'already_reversed';
      entry: LedgerEntry;
    }
  | { status: 'not_found' };

const parseJson = <T>(raw: string | null): T | null =>
  raw === null ? null : (JSON.parse(raw) as T);

const parseLedgerEntry = (raw: string | null): LedgerEntry | null => {
  const entry = parseJson<LedgerEntry>(raw);
  if (!entry) {
    return null;
  }

  if (entry.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported StrikeLedger schema version ${entry.schemaVersion}.`
    );
  }

  return entry;
};

const ledgerEntryKey = (entryId: string): string => `ledger_entry:${entryId}`;
const formNonceKey = (nonce: string): string => `form_nonce:${nonce}`;
const userLedgerKey = (userKey: string): string => `user:${userKey}:ledger`;
const targetEntriesKey = (targetId: string): string =>
  `target:${targetId}:entries`;
const activeTotalKey = (userKey: string): string =>
  `user:${userKey}:active_total`;

const uniqueUserKeys = (userKeys: string[]): string[] =>
  Array.from(new Set(userKeys.map((userKey) => userKey.trim()).filter(Boolean)));

const isEntryForSubreddit = (
  entry: LedgerEntry,
  subredditName: string
): boolean =>
  entry.subredditName.toLowerCase() === subredditName.trim().toLowerCase();

const compareEntriesNewestFirst = (
  left: LedgerEntry,
  right: LedgerEntry
): number => {
  if (left.createdAtMs !== right.createdAtMs) {
    return right.createdAtMs - left.createdAtMs;
  }

  return right.entryId.localeCompare(left.entryId);
};

export class LedgerRepository {
  constructor(private readonly store: RedisStore) {}

  async saveFormNonce(record: FormNonceRecord): Promise<void> {
    await this.store.set(formNonceKey(record.nonce), JSON.stringify(record), {
      expiresAtMs: record.expiresAtMs,
    });
  }

  async getFormNonce(nonce: string): Promise<FormNonceRecord | null> {
    return parseJson<FormNonceRecord>(
      await this.store.get(formNonceKey(nonce))
    );
  }

  async getLedgerEntry(entryId: string): Promise<LedgerEntry | null> {
    return parseLedgerEntry(await this.store.get(ledgerEntryKey(entryId)));
  }

  async updateLedgerEntry(entry: LedgerEntry): Promise<void> {
    await this.store.set(ledgerEntryKey(entry.entryId), JSON.stringify(entry));
  }

  async getUserLedger(userKey: string): Promise<LedgerEntry[]> {
    return this.getUserLedgerPage(userKey, 0, -1);
  }

  async getUserLedgerForKeys(
    userKeys: string[],
    subredditName?: string
  ): Promise<LedgerEntry[]> {
    return this.getUserLedgerPageForKeys(userKeys, 0, -1, subredditName);
  }

  async getUserLedgerPage(
    userKey: string,
    offset: number,
    limit: number
  ): Promise<LedgerEntry[]> {
    if (limit === 0) {
      return [];
    }

    const stop = limit < 0 ? -1 : offset + limit - 1;
    const entryIds = await this.store.zRange(
      userLedgerKey(userKey),
      offset,
      stop,
      {
        reverse: true,
      }
    );
    const entries = await Promise.all(
      entryIds.map((entryId) => this.getLedgerEntry(entryId))
    );

    return entries.filter((entry): entry is LedgerEntry => entry !== null);
  }

  async getUserLedgerPageForKeys(
    userKeys: string[],
    offset: number,
    limit: number,
    subredditName?: string
  ): Promise<LedgerEntry[]> {
    if (limit === 0) {
      return [];
    }

    const uniqueKeys = uniqueUserKeys(userKeys);
    const entriesById = new Map<string, LedgerEntry>();
    for (const userKey of uniqueKeys) {
      for (const entry of await this.getUserLedger(userKey)) {
        entriesById.set(entry.entryId, entry);
      }
    }

    const entries = Array.from(entriesById.values()).sort(
      compareEntriesNewestFirst
    );
    const scopedEntries =
      subredditName === undefined
        ? entries
        : entries.filter((entry) => isEntryForSubreddit(entry, subredditName));
    return limit < 0
      ? scopedEntries.slice(offset)
      : scopedEntries.slice(offset, offset + limit);
  }

  async getCachedActiveTotal(userKey: string): Promise<number | null> {
    const rawTotal = await this.store.get(activeTotalKey(userKey));
    return rawTotal === null ? null : Number(rawTotal);
  }

  async createLedgerEntry(
    request: CreateLedgerEntryRequest
  ): Promise<CreateLedgerEntryResult> {
    const result = await this.store.runTransaction(
      this.getCreateWatchedKeys(request),
      async (): Promise<CreateLedgerEntryTransactionResult> => {
        const nonce = await this.getValidNonce(request);
        if (nonce.status === 'blocked') {
          return nonce;
        }

        if (nonce.status === 'consumed') {
          const entry = await this.getLedgerEntry(nonce.entryId);
          if (!entry) {
            return {
              status: 'blocked',
              reason: 'nonce_consumed_without_entry',
            };
          }

          return {
            status: 'idempotent',
            entry,
          };
        }

        const retryEntry = await this.getRetryEntry(request);
        if (retryEntry && retryEntry.status !== 'reversed') {
          return {
            status: 'idempotent',
            entry: retryEntry,
          };
        }

        const duplicateEntry = await this.getDuplicateEntry(request.entry);
        if (duplicateEntry && duplicateEntry.status !== 'reversed') {
          return { status: 'duplicate', existingEntry: duplicateEntry };
        }

        await this.writePendingEntry(request, nonce.record);

        return { status: 'created', entry: request.entry };
      }
    );

    if (result.status === 'created' || result.status === 'idempotent') {
      return {
        ...result,
        activeTotal: await this.recalculateActiveTotal(
          result.entry.userKey,
          request.config,
          request.nowMs,
          result.entry.subredditName
        ),
      };
    }

    return result;
  }

  async reverseLedgerEntry(
    request: ReverseLedgerEntryRequest
  ): Promise<ReverseLedgerEntryResult> {
    const currentEntry = await this.getLedgerEntry(request.entryId);
    const result = await this.store.runTransaction(
      this.getReverseWatchedKeys(request.entryId, currentEntry),
      async (): Promise<ReverseLedgerEntryTransactionResult> => {
        const entry = await this.getLedgerEntry(request.entryId);
        if (!entry) {
          return { status: 'not_found' };
        }

        if (entry.status === 'reversed') {
          return {
            status: 'already_reversed',
            entry,
          };
        }

        const duplicateClaimKey = getDuplicateClaimKey({
          targetId: entry.targetId,
          action: entry.action,
          ruleId: entry.ruleId,
        });
        const claimedEntryId = await this.store.get(duplicateClaimKey);
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
        if (claimedEntryId === reversedEntry.entryId) {
          await this.store.del(duplicateClaimKey);
        }

        return { status: 'reversed', entry: reversedEntry };
      }
    );

    if (result.status === 'reversed' || result.status === 'already_reversed') {
      return {
        ...result,
        activeTotal: await this.recalculateActiveTotal(
          result.entry.userKey,
          request.config,
          request.nowMs,
          result.entry.subredditName
        ),
      };
    }

    return result;
  }

  async recalculateActiveTotal(
    userKey: string,
    config: StrikeLedgerConfig,
    nowMs: number,
    subredditName?: string
  ): Promise<number> {
    const entries = await this.getUserLedger(userKey);
    const scopedEntries =
      subredditName === undefined
        ? entries
        : entries.filter((entry) => isEntryForSubreddit(entry, subredditName));
    return this.cacheActiveTotal(userKey, scopedEntries, config, nowMs);
  }

  async recalculateActiveTotalForKeys(
    userKeys: string[],
    cacheUserKey: string,
    config: StrikeLedgerConfig,
    nowMs: number,
    subredditName?: string
  ): Promise<number> {
    const entries = await this.getUserLedgerForKeys(userKeys, subredditName);
    return this.cacheActiveTotal(cacheUserKey, entries, config, nowMs);
  }

  async migrateUsernameLedgerToUserId(input: {
    username: string;
    userId: string;
  }): Promise<IdentityMigrationResult> {
    const fromUserKey = getUserKey({ username: input.username });
    const toUserKey = getUserKey({ userId: input.userId });
    if (!fromUserKey || !toUserKey || fromUserKey === toUserKey) {
      return {
        fromUserKey: fromUserKey ?? '',
        toUserKey: toUserKey ?? '',
        migratedCount: 0,
      };
    }

    const normalizedUsername = normalizeUsername(input.username);
    return this.store.runTransaction(
      [
        userLedgerKey(fromUserKey),
        userLedgerKey(toUserKey),
        activeTotalKey(fromUserKey),
      ],
      async (): Promise<IdentityMigrationResult> => {
        const entries = await this.getUserLedger(fromUserKey);
        for (const entry of entries) {
          const migratedEntry: LedgerEntry = {
            ...entry,
            userKey: toUserKey,
            userId: input.userId.trim(),
            migratedFromUsername:
              entry.migratedFromUsername ?? normalizedUsername,
          };
          await this.store.set(
            ledgerEntryKey(migratedEntry.entryId),
            JSON.stringify(migratedEntry)
          );
          await this.store.zAdd(userLedgerKey(toUserKey), {
            member: migratedEntry.entryId,
            score: migratedEntry.createdAtMs,
          });
        }

        await this.store.del(userLedgerKey(fromUserKey), activeTotalKey(fromUserKey));
        return {
          fromUserKey,
          toUserKey,
          migratedCount: entries.length,
        };
      }
    );
  }

  private async cacheActiveTotal(
    userKey: string,
    entries: LedgerEntry[],
    config: StrikeLedgerConfig,
    nowMs: number
  ): Promise<number> {
    const activeTotal = calculateActiveTotalFromEntries(entries, config, nowMs);
    try {
      await this.store.set(activeTotalKey(userKey), String(activeTotal));
    } catch (error) {
      logError(
        'ledger.active_total_cache_failed',
        {
          userKey,
          activeTotal,
        },
        error
      );
    }
    return activeTotal;
  }

  private getCreateWatchedKeys(request: CreateLedgerEntryRequest): string[] {
    return [
      formNonceKey(request.formNonce),
      getDuplicateClaimKey({
        targetId: request.entry.targetId,
        action: request.entry.action,
        ruleId: request.entry.ruleId,
      }),
      getRetryClaimKey({
        targetId: request.entry.targetId,
        action: request.entry.action,
        ruleId: request.entry.ruleId,
        moderatorUsername: request.entry.moderatorUsername,
        submittedAtMs: request.submittedAtMs,
      }),
      ledgerEntryKey(request.entry.entryId),
      userLedgerKey(request.entry.userKey),
      targetEntriesKey(request.entry.targetId),
    ];
  }

  private getReverseWatchedKeys(
    entryId: string,
    currentEntry: LedgerEntry | null
  ): string[] {
    if (!currentEntry) {
      return [ledgerEntryKey(entryId)];
    }

    return [
      ledgerEntryKey(entryId),
      getDuplicateClaimKey({
        targetId: currentEntry.targetId,
        action: currentEntry.action,
        ruleId: currentEntry.ruleId,
      }),
    ];
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
}
