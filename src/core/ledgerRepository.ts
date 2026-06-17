import type {
  LedgerEntry,
  SideEffects,
  StrikeLedgerConfig,
  TargetKind,
} from './domain';
import { SCHEMA_VERSION as CURRENT_SCHEMA_VERSION } from './domain';
import {
  RETRY_WINDOW_MS,
  getDuplicateClaimKey,
  getRetryClaimKey,
} from './idempotency';
import { logError } from './logging';
import {
  isRedisTransactionConflictError,
  type RedisStore,
} from './redisStore';
import {
  MS_PER_DAY,
  calculateActivePoints,
  getDecayIntervalMs,
  recalculateActiveTotal as calculateActiveTotalFromEntries,
} from './scoring';
import { getUserKey } from './identity';

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
        | 'nonce_consumed_without_entry'
        | 'transaction_conflict';
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
  userKeys?: string[];
  cacheUserKey?: string;
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

export type CleanupLedgerRequest = {
  subredditName: string;
  config: StrikeLedgerConfig;
  nowMs: number;
  retentionDays: number;
  maxEntries: number;
};

export type CleanupLedgerResult = {
  scanned: number;
  deleted: number;
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
const userLedgerVersionKey = (userKey: string): string =>
  `user:${userKey}:ledger_version`;
const ledgerEntriesKey = (subredditName: string): string =>
  `ledger:${subredditName.trim().toLowerCase()}:entries`;
const cleanupCursorKey = (subredditName: string): string =>
  `ledger:${subredditName.trim().toLowerCase()}:cleanup_cursor`;
const ACTIVE_TOTAL_PAGE_SIZE = 100;
const ACTIVE_TOTAL_RECALC_ATTEMPTS = 3;
const ACTIVE_TOTAL_CACHE_TTL_MS = 366 * MS_PER_DAY;
const MAX_ENTRY_ORIGINAL_POINTS = 100;

const uniqueUserKeys = (userKeys: string[]): string[] =>
  Array.from(new Set(userKeys.map((userKey) => userKey.trim()).filter(Boolean)));

const getLedgerEntryUserKeys = (entry: LedgerEntry): string[] => {
  const fallbackUserKey = getUserKey({ username: entry.username });
  return uniqueUserKeys([
    entry.userKey,
    ...(fallbackUserKey ? [fallbackUserKey] : []),
  ]);
};

const parseLedgerVersion = (raw: string | null): number => {
  const version = Number(raw);
  return Number.isInteger(version) && version >= 0 ? version : 0;
};

const ledgerVersionsEqual = (
  left: Map<string, number>,
  right: Map<string, number>
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [key, version] of left) {
    if (right.get(key) !== version) {
      return false;
    }
  }

  return true;
};

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

const getCleanupRetentionTimestampMs = (entry: LedgerEntry): number =>
  entry.status === 'reversed' && entry.reversedAtMs !== undefined
    ? entry.reversedAtMs
    : entry.createdAtMs;

const mergeCheckpointSideEffects = (
  current: LedgerEntry,
  checkpoint: LedgerEntry
): SideEffects => {
  if (checkpoint.status === 'reversed') {
    return {
      ...current.sideEffects,
      reversalModNote: checkpoint.sideEffects.reversalModNote,
      reversalUserNotice: checkpoint.sideEffects.reversalUserNotice,
    };
  }

  if (current.status === 'reversed') {
    return {
      ...checkpoint.sideEffects,
      reversalModNote: current.sideEffects.reversalModNote,
      reversalUserNotice: current.sideEffects.reversalUserNotice,
    };
  }

  return checkpoint.sideEffects;
};

const getActiveEntryCutoffMs = (
  config: StrikeLedgerConfig,
  nowMs: number
): number | null => {
  if (config.decayAmount <= 0) {
    return null;
  }

  const maxActiveIntervals = Math.ceil(
    MAX_ENTRY_ORIGINAL_POINTS / config.decayAmount
  );
  return nowMs - maxActiveIntervals * getDecayIntervalMs(config);
};

const parseCleanupCursor = (raw: string | null): number => {
  const cursor = Number(raw);
  return Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
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

  async updateLedgerEntrySideEffects(
    checkpoint: LedgerEntry
  ): Promise<LedgerEntry | null> {
    return this.store.runTransaction(
      [ledgerEntryKey(checkpoint.entryId)],
      async (): Promise<LedgerEntry | null> => {
        const current = await this.getLedgerEntry(checkpoint.entryId);
        if (!current) {
          return null;
        }

        const sideEffects = mergeCheckpointSideEffects(current, checkpoint);
        const updated: LedgerEntry = {
          ...current,
          status:
            current.status === 'reversed' ? current.status : checkpoint.status,
          sideEffects,
          ...(checkpoint.publicCommentId !== undefined
            ? { publicCommentId: checkpoint.publicCommentId }
            : {}),
          ...(checkpoint.publicCorrectionCommentId !== undefined
            ? { publicCorrectionCommentId: checkpoint.publicCorrectionCommentId }
            : {}),
          ...(checkpoint.modNoteId !== undefined
            ? { modNoteId: checkpoint.modNoteId }
            : {}),
          ...(checkpoint.userNoticeId !== undefined
            ? { userNoticeId: checkpoint.userNoticeId }
            : {}),
          ...(checkpoint.reversalModNoteId !== undefined
            ? { reversalModNoteId: checkpoint.reversalModNoteId }
            : {}),
          ...(checkpoint.reversalUserNoticeId !== undefined
            ? { reversalUserNoticeId: checkpoint.reversalUserNoticeId }
            : {}),
        };

        await this.store.set(
          ledgerEntryKey(updated.entryId),
          JSON.stringify(updated)
        );
        return updated;
      }
    );
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

  async getTargetLedgerPage(
    targetId: string,
    offset: number,
    limit: number,
    subredditName?: string
  ): Promise<LedgerEntry[]> {
    if (limit === 0) {
      return [];
    }

    const stop = limit < 0 ? -1 : offset + limit - 1;
    const entryIds = await this.store.zRange(
      targetEntriesKey(targetId),
      offset,
      stop,
      { reverse: true }
    );
    const entries = await Promise.all(
      entryIds.map((entryId) => this.getLedgerEntry(entryId))
    );
    const existingEntries = entries.filter(
      (entry): entry is LedgerEntry => entry !== null
    );

    return subredditName === undefined
      ? existingEntries
      : existingEntries.filter((entry) =>
          isEntryForSubreddit(entry, subredditName)
        );
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
    if (limit >= 0) {
      if (subredditName === undefined) {
        const perKeyLimit = Math.max(0, offset) + limit;
        for (const userKey of uniqueKeys) {
          for (const entry of await this.getUserLedgerPage(
            userKey,
            0,
            perKeyLimit
          )) {
            entriesById.set(entry.entryId, entry);
          }
        }

        const entries = Array.from(entriesById.values()).sort(
          compareEntriesNewestFirst
        );
        return entries.slice(offset, offset + limit);
      }

      const scopedSubredditName = subredditName;
      const perKeyScopedLimit = Math.max(0, offset) + limit;
      const pageSize = Math.max(25, perKeyScopedLimit);
      for (const userKey of uniqueKeys) {
        let readOffset = 0;
        let scopedEntryCount = 0;
        while (scopedEntryCount < perKeyScopedLimit) {
          const page = await this.getUserLedgerPage(
            userKey,
            readOffset,
            pageSize
          );
          if (page.length === 0) {
            break;
          }

          for (const entry of page) {
            if (isEntryForSubreddit(entry, scopedSubredditName)) {
              scopedEntryCount += 1;
              entriesById.set(entry.entryId, entry);
            }
          }

          if (page.length < pageSize) {
            break;
          }

          readOffset += pageSize;
        }
      }

      const entries = Array.from(entriesById.values()).sort(
        compareEntriesNewestFirst
      );
      return entries.slice(offset, offset + limit);
    }

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
    let result: CreateLedgerEntryTransactionResult;
    try {
      result = await this.store.runTransaction(
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
            await this.consumeNonce(
              nonce.record,
              retryEntry.entryId,
              request.nowMs
            );
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
    } catch (error) {
      if (isRedisTransactionConflictError(error)) {
        return { status: 'blocked', reason: 'transaction_conflict' };
      }

      throw error;
    }

    if (result.status === 'created' || result.status === 'idempotent') {
      return {
        ...result,
        activeTotal: await this.recalculateActiveTotalForKeys(
          getLedgerEntryUserKeys(result.entry),
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
        await this.bumpUserLedgerVersions([
          ...getLedgerEntryUserKeys(reversedEntry),
          ...(request.userKeys ?? []),
        ]);
        if (claimedEntryId === reversedEntry.entryId) {
          await this.store.del(duplicateClaimKey);
        }

        return { status: 'reversed', entry: reversedEntry };
      }
    );

    if (result.status === 'reversed' || result.status === 'already_reversed') {
      const userKeys = uniqueUserKeys([
        ...getLedgerEntryUserKeys(result.entry),
        ...(request.userKeys ?? []),
      ]);
      return {
        ...result,
        activeTotal: await this.recalculateActiveTotalForKeys(
          userKeys,
          request.cacheUserKey ?? result.entry.userKey,
          request.config,
          request.nowMs,
          result.entry.subredditName
        ),
      };
    }

    return result;
  }

  async cleanupLedger(
    request: CleanupLedgerRequest
  ): Promise<CleanupLedgerResult> {
    const maxEntries = Math.max(0, request.maxEntries);
    if (maxEntries === 0) {
      return { scanned: 0, deleted: 0 };
    }

    const cutoffMs = request.nowMs - request.retentionDays * 24 * 60 * 60 * 1000;
    const ledgerIndexKey = ledgerEntriesKey(request.subredditName);
    const cursorKey = cleanupCursorKey(request.subredditName);
    let cursor = parseCleanupCursor(await this.store.get(cursorKey));
    let entryIds = await this.store.zRange(
      ledgerIndexKey,
      cursor,
      cursor + maxEntries - 1
    );
    if (entryIds.length === 0 && cursor > 0) {
      cursor = 0;
      entryIds = await this.store.zRange(ledgerIndexKey, 0, maxEntries - 1);
    }

    let scanned = 0;
    let deleted = 0;
    let removedFromPage = 0;

    for (const entryId of entryIds) {
      scanned += 1;
      const entry = await this.getLedgerEntry(entryId);
      if (!entry) {
        await this.store.zRem(ledgerIndexKey, [entryId]);
        removedFromPage += 1;
        continue;
      }

      if (
        getCleanupRetentionTimestampMs(entry) > cutoffMs ||
        !isEntryForSubreddit(entry, request.subredditName)
      ) {
        continue;
      }

      const activePoints = calculateActivePoints(
        entry,
        request.config,
        request.nowMs
      );
      if (entry.status !== 'reversed' && activePoints > 0) {
        continue;
      }

      await this.deleteLedgerEntry(entry);
      deleted += 1;
      removedFromPage += 1;
    }

    const nextCursor =
      entryIds.length < maxEntries
        ? 0
        : Math.max(0, cursor + scanned - removedFromPage);
    await this.store.set(cursorKey, String(nextCursor));

    return { scanned, deleted };
  }

  async recalculateActiveTotal(
    userKey: string,
    config: StrikeLedgerConfig,
    nowMs: number,
    subredditName?: string
  ): Promise<number> {
    return this.recalculateActiveTotalForKeys(
      [userKey],
      userKey,
      config,
      nowMs,
      subredditName
    );
  }

  async recalculateActiveTotalForKeys(
    userKeys: string[],
    cacheUserKey: string,
    config: StrikeLedgerConfig,
    nowMs: number,
    subredditName?: string
  ): Promise<number> {
    const sourceUserKeys = uniqueUserKeys([...userKeys, cacheUserKey]);
    for (let attempt = 0; attempt < ACTIVE_TOTAL_RECALC_ATTEMPTS; attempt += 1) {
      const beforeVersions = await this.getUserLedgerVersions(sourceUserKeys);
      const entries = await this.getActiveTotalEntriesForKeys(
        sourceUserKeys,
        config,
        nowMs,
        subredditName
      );
      const afterVersions = await this.getUserLedgerVersions(sourceUserKeys);
      if (!ledgerVersionsEqual(beforeVersions, afterVersions)) {
        continue;
      }

      const activeTotal = calculateActiveTotalFromEntries(
        entries,
        config,
        nowMs
      );
      if (
        await this.cacheActiveTotalIfLedgerStable(
          cacheUserKey,
          activeTotal,
          sourceUserKeys,
          afterVersions,
          nowMs
        )
      ) {
        return activeTotal;
      }
    }

    const entries = await this.getActiveTotalEntriesForKeys(
      sourceUserKeys,
      config,
      nowMs,
      subredditName
    );
    const activeTotal = calculateActiveTotalFromEntries(entries, config, nowMs);
    logError('ledger.active_total_cache_stale', {
      userKey: cacheUserKey,
      activeTotal,
    });
    return activeTotal;
  }

  private async getActiveTotalEntriesForKeys(
    userKeys: string[],
    config: StrikeLedgerConfig,
    nowMs: number,
    subredditName?: string
  ): Promise<LedgerEntry[]> {
    const cutoffMs = getActiveEntryCutoffMs(config, nowMs);
    if (cutoffMs === null) {
      return this.getUserLedgerForKeys(userKeys, subredditName);
    }

    const entriesById = new Map<string, LedgerEntry>();
    for (const userKey of uniqueUserKeys(userKeys)) {
      let offset = 0;
      while (true) {
        const page = await this.getUserLedgerPage(
          userKey,
          offset,
          ACTIVE_TOTAL_PAGE_SIZE
        );
        if (page.length === 0) {
          break;
        }

        for (const entry of page) {
          if (entry.createdAtMs > cutoffMs) {
            entriesById.set(entry.entryId, entry);
          }
        }

        const oldestEntry = page.at(-1);
        if (
          page.length < ACTIVE_TOTAL_PAGE_SIZE ||
          !oldestEntry ||
          oldestEntry.createdAtMs <= cutoffMs
        ) {
          break;
        }

        offset += ACTIVE_TOTAL_PAGE_SIZE;
      }
    }

    const entries = Array.from(entriesById.values());
    return subredditName === undefined
      ? entries
      : entries.filter((entry) => isEntryForSubreddit(entry, subredditName));
  }

  private async getUserLedgerVersions(
    userKeys: string[]
  ): Promise<Map<string, number>> {
    const versions = new Map<string, number>();
    for (const userKey of uniqueUserKeys(userKeys)) {
      versions.set(
        userKey,
        parseLedgerVersion(await this.store.get(userLedgerVersionKey(userKey)))
      );
    }

    return versions;
  }

  private async bumpUserLedgerVersions(userKeys: string[]): Promise<void> {
    for (const userKey of uniqueUserKeys(userKeys)) {
      await this.store.incrBy(userLedgerVersionKey(userKey), 1);
    }
  }

  private async cacheActiveTotalIfLedgerStable(
    userKey: string,
    activeTotal: number,
    sourceUserKeys: string[],
    expectedVersions: Map<string, number>,
    nowMs: number
  ): Promise<boolean> {
    try {
      return await this.store.runTransaction(
        [
          activeTotalKey(userKey),
          ...uniqueUserKeys(sourceUserKeys).map(userLedgerVersionKey),
        ],
        async (): Promise<boolean> => {
          const currentVersions =
            await this.getUserLedgerVersions(sourceUserKeys);
          if (!ledgerVersionsEqual(currentVersions, expectedVersions)) {
            return false;
          }

          await this.store.set(activeTotalKey(userKey), String(activeTotal), {
            expiresAtMs: nowMs + ACTIVE_TOTAL_CACHE_TTL_MS,
          });
          return true;
        }
      );
    } catch (error) {
      logError(
        'ledger.active_total_cache_failed',
        {
          userKey,
          activeTotal,
        },
        error
      );
      return false;
    }
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
    const submittedAtCandidates = new Set([
      request.submittedAtMs,
      request.submittedAtMs - RETRY_WINDOW_MS,
    ]);

    for (const submittedAtMs of submittedAtCandidates) {
      const entryId = await this.store.get(
        getRetryClaimKey({
          targetId: request.entry.targetId,
          action: request.entry.action,
          ruleId: request.entry.ruleId,
          moderatorUsername: request.entry.moderatorUsername,
          submittedAtMs,
        })
      );
      if (entryId) {
        return this.getLedgerEntry(entryId);
      }
    }

    return null;
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

  private async consumeNonce(
    nonce: FormNonceRecord,
    entryId: string,
    consumedAtMs: number
  ): Promise<void> {
    await this.store.set(
      formNonceKey(nonce.nonce),
      JSON.stringify({
        ...nonce,
        consumedAtMs,
        entryId,
      } satisfies FormNonceRecord),
      { expiresAtMs: nonce.expiresAtMs }
    );
  }

  private async writePendingEntry(
    request: CreateLedgerEntryRequest,
    nonce: FormNonceRecord
  ): Promise<void> {
    await this.store.set(
      ledgerEntryKey(request.entry.entryId),
      JSON.stringify(request.entry)
    );
    const userKeys = getLedgerEntryUserKeys(request.entry);
    for (const userKey of userKeys) {
      await this.store.zAdd(userLedgerKey(userKey), {
        member: request.entry.entryId,
        score: request.entry.createdAtMs,
      });
    }
    await this.store.zAdd(targetEntriesKey(request.entry.targetId), {
      member: request.entry.entryId,
      score: request.entry.createdAtMs,
    });
    await this.store.zAdd(ledgerEntriesKey(request.entry.subredditName), {
      member: request.entry.entryId,
      score: request.entry.createdAtMs,
    });
    await this.consumeNonce(nonce, request.entry.entryId, request.nowMs);
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
    await this.bumpUserLedgerVersions(userKeys);
  }

  private async deleteLedgerEntry(entry: LedgerEntry): Promise<void> {
    const duplicateClaimKey = getDuplicateClaimKey({
      targetId: entry.targetId,
      action: entry.action,
      ruleId: entry.ruleId,
    });
    const entryKey = ledgerEntryKey(entry.entryId);
    const userKeys = getLedgerEntryUserKeys(entry);
    const targetKey = targetEntriesKey(entry.targetId);
    const subredditLedgerKey = ledgerEntriesKey(entry.subredditName);

    await this.store.runTransaction(
      [
        entryKey,
        duplicateClaimKey,
        ...userKeys.map(userLedgerKey),
        targetKey,
        subredditLedgerKey,
      ],
      async () => {
        const currentEntry = parseLedgerEntry(await this.store.get(entryKey));
        if (!currentEntry) {
          return;
        }

        const currentUserKeys = getLedgerEntryUserKeys(currentEntry);
        const lastUserKeys = new Set<string>();
        for (const userKey of currentUserKeys) {
          const members = await this.store.zRange(userLedgerKey(userKey), 0, 1);
          if (members.length === 1 && members[0] === currentEntry.entryId) {
            lastUserKeys.add(userKey);
          }
        }
        const targetMembers = await this.store.zRange(
          targetEntriesKey(currentEntry.targetId),
          0,
          1
        );
        const isLastTargetEntry =
          targetMembers.length === 1 && targetMembers[0] === currentEntry.entryId;
        const subredditMembers = await this.store.zRange(
          ledgerEntriesKey(currentEntry.subredditName),
          0,
          1
        );
        const isLastSubredditEntry =
          subredditMembers.length === 1 &&
          subredditMembers[0] === currentEntry.entryId;

        const claimedEntryId = await this.store.get(duplicateClaimKey);
        await this.store.del(entryKey);
        for (const userKey of currentUserKeys) {
          if (lastUserKeys.has(userKey)) {
            await this.store.del(
              userLedgerKey(userKey),
              activeTotalKey(userKey),
              userLedgerVersionKey(userKey)
            );
          } else {
            await this.store.zRem(userLedgerKey(userKey), [currentEntry.entryId]);
          }
        }
        if (isLastTargetEntry) {
          await this.store.del(targetEntriesKey(currentEntry.targetId));
        } else {
          await this.store.zRem(targetEntriesKey(currentEntry.targetId), [
            currentEntry.entryId,
          ]);
        }
        if (isLastSubredditEntry) {
          await this.store.del(ledgerEntriesKey(currentEntry.subredditName));
        } else {
          await this.store.zRem(ledgerEntriesKey(currentEntry.subredditName), [
            currentEntry.entryId,
          ]);
        }

        if (claimedEntryId === currentEntry.entryId) {
          await this.store.del(duplicateClaimKey);
        }
        await this.bumpUserLedgerVersions(
          currentUserKeys.filter((userKey) => !lastUserKeys.has(userKey))
        );
      }
    );
  }
}
