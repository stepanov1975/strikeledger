import type { LedgerRepository } from './ledgerRepository';

export const DEFAULT_ACCOUNT_DELETION_CHECK_INTERVAL_HOURS = 24;
export const DEFAULT_ACCOUNT_DELETION_MAX_USERS = 50;
export const DEFAULT_ACCOUNT_DELETION_MAX_ENTRIES_PER_USER = 200;
export const DEFAULT_ACCOUNT_DELETION_MAX_ENTRIES_PER_RUN = 1_000;
export const DEFAULT_ACCOUNT_DELETION_MAX_RUNTIME_MS = 10_000;

const MAX_ACCOUNT_DELETION_CHECK_INTERVAL_HOURS = 24 * 30;
const MAX_ACCOUNT_DELETION_MAX_USERS = 200;
const MAX_ACCOUNT_DELETION_MAX_ENTRIES_PER_USER = 1_000;
const MAX_ACCOUNT_DELETION_MAX_ENTRIES_PER_RUN = 2_000;
const MAX_ACCOUNT_DELETION_MAX_RUNTIME_MS = 30_000;

export type AccountDeletionOptions = {
  checkIntervalHours: number;
  maxUsers: number;
  maxEntriesPerUser: number;
  maxEntriesPerRun: number;
  maxRuntimeMs: number;
};

export type AccountDeletionRunResult = AccountDeletionOptions & {
  checked: number;
  existingUsers: number;
  deletedUsers: number;
  deletedEntries: number;
  failedChecks: number;
  remainingEntries: number;
  stoppedEarly?: true;
};

export type AccountDeletionRedditClient = {
  getUserById(userId: string): Promise<unknown | null | undefined>;
};

export type RunAccountDeletionCheckRequest = {
  ledgerRepository: LedgerRepository;
  reddit: AccountDeletionRedditClient;
  nowMs: number;
  payload?: Partial<AccountDeletionOptions>;
  getNowMs?: () => number;
};

const boundedInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
};

export const normalizeAccountDeletionOptions = (
  payload: Partial<AccountDeletionOptions> = {}
): AccountDeletionOptions => ({
  checkIntervalHours: boundedInteger(
    payload.checkIntervalHours,
    DEFAULT_ACCOUNT_DELETION_CHECK_INTERVAL_HOURS,
    1,
    MAX_ACCOUNT_DELETION_CHECK_INTERVAL_HOURS
  ),
  maxUsers: boundedInteger(
    payload.maxUsers,
    DEFAULT_ACCOUNT_DELETION_MAX_USERS,
    1,
    MAX_ACCOUNT_DELETION_MAX_USERS
  ),
  maxEntriesPerUser: boundedInteger(
    payload.maxEntriesPerUser,
    DEFAULT_ACCOUNT_DELETION_MAX_ENTRIES_PER_USER,
    1,
    MAX_ACCOUNT_DELETION_MAX_ENTRIES_PER_USER
  ),
  maxEntriesPerRun: boundedInteger(
    payload.maxEntriesPerRun,
    DEFAULT_ACCOUNT_DELETION_MAX_ENTRIES_PER_RUN,
    1,
    MAX_ACCOUNT_DELETION_MAX_ENTRIES_PER_RUN
  ),
  maxRuntimeMs: boundedInteger(
    payload.maxRuntimeMs,
    DEFAULT_ACCOUNT_DELETION_MAX_RUNTIME_MS,
    1,
    MAX_ACCOUNT_DELETION_MAX_RUNTIME_MS
  ),
});

export const runAccountDeletionCheck = async ({
  ledgerRepository,
  reddit,
  nowMs,
  payload,
  getNowMs = Date.now,
}: RunAccountDeletionCheckRequest): Promise<AccountDeletionRunResult> => {
  const options = normalizeAccountDeletionOptions(payload);
  const startedAtMs = getNowMs();
  const checkIntervalMs = options.checkIntervalHours * 60 * 60 * 1000;
  const userIds = await ledgerRepository.getTrackedUserIdsForAccountCheck(
    nowMs,
    options.maxUsers,
    checkIntervalMs
  );

  let checked = 0;
  let existingUsers = 0;
  let deletedUsers = 0;
  let deletedEntries = 0;
  let failedChecks = 0;
  let remainingEntries = 0;
  let remainingEntryBudget = options.maxEntriesPerRun;
  let stoppedEarly = false;

  for (const userId of userIds) {
    if (remainingEntryBudget <= 0) {
      break;
    }
    if (getNowMs() - startedAtMs >= options.maxRuntimeMs) {
      stoppedEarly = true;
      break;
    }

    checked += 1;
    let user: unknown | null | undefined;
    try {
      user = await reddit.getUserById(userId);
    } catch {
      failedChecks += 1;
      await ledgerRepository.markTrackedUserRetrySoon(
        userId,
        nowMs,
        checkIntervalMs
      );
      continue;
    }

    if (user) {
      existingUsers += 1;
      await ledgerRepository.markTrackedUserChecked(userId, nowMs);
      continue;
    }

    const deletionResult = await ledgerRepository.deleteUserLedgerByUserId(
      userId,
      Math.min(options.maxEntriesPerUser, remainingEntryBudget)
    );
    remainingEntryBudget -= deletionResult.scanned;
    deletedEntries += deletionResult.deleted;
    remainingEntries += deletionResult.remaining;
    if (deletionResult.remaining === 0) {
      deletedUsers += 1;
    }
  }

  return {
    ...options,
    checked,
    existingUsers,
    deletedUsers,
    deletedEntries,
    failedChecks,
    remainingEntries,
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
};
