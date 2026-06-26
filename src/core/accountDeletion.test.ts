import { describe, expect, it, vi } from 'vitest';
import { EMPTY_SIDE_EFFECTS, SCHEMA_VERSION, type LedgerEntry } from './domain';
import { LedgerRepository } from './ledgerRepository';
import { FakeRedisStore } from './redisStore';
import {
  normalizeAccountDeletionOptions,
  runAccountDeletionCheck,
} from './accountDeletion';

const nowMs = Date.UTC(2026, 0, 1);

const buildEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: SCHEMA_VERSION,
  entryId: overrides.entryId ?? 'entry-1',
  subredditName: overrides.subredditName ?? 'testsub',
  userId: overrides.userId ?? 't2_user',
  username: overrides.username ?? 'target-user',
  userKey: overrides.userKey ?? 'id:t2_user',
  targetId: overrides.targetId ?? 't3_target',
  targetKind: overrides.targetKind ?? 'post',
  targetPermalink: overrides.targetPermalink ?? '/r/testsub/comments/target',
  action: overrides.action ?? 'warn',
  ruleId: overrides.ruleId ?? 'rule-general',
  ruleLabel: overrides.ruleLabel ?? 'Community rule violation',
  publicCommentOverrideUsed: overrides.publicCommentOverrideUsed ?? false,
  originalPoints: overrides.originalPoints ?? 1,
  moderatorUsername: overrides.moderatorUsername ?? 'mod-a',
  createdAtMs: overrides.createdAtMs ?? nowMs,
  status: overrides.status ?? 'succeeded',
  duplicateKey: overrides.duplicateKey ?? 'duplicate',
  moderatorRetryKey: overrides.moderatorRetryKey ?? 'retry',
  idempotencyInputs: overrides.idempotencyInputs ?? {},
  formNonce: overrides.formNonce ?? 'nonce-1',
  sideEffects: overrides.sideEffects ?? { ...EMPTY_SIDE_EFFECTS },
});

const seedEntry = async (
  store: FakeRedisStore,
  entry: LedgerEntry
): Promise<void> => {
  await store.set(`ledger_entry:${entry.entryId}`, JSON.stringify(entry));
  await store.zAdd(`user:${entry.userKey}:ledger`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
  await store.zAdd(`target:${entry.targetId}:entries`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
  const postIds = [
    ...(entry.targetPostId ? [entry.targetPostId] : []),
    ...(entry.targetKind === 'post' ? [entry.targetId] : []),
  ];
  for (const postId of Array.from(new Set(postIds))) {
    await store.zAdd(`post:${postId}:entries`, {
      member: entry.entryId,
      score: entry.createdAtMs,
    });
  }
  await store.zAdd(`ledger:${entry.subredditName}:entries`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
  await store.zAdd('users:tracked', {
    member: entry.userId,
    score: entry.createdAtMs,
  });
};

describe('account deletion checker', () => {
  it('normalizes the account deletion runtime budget', () => {
    expect(
      normalizeAccountDeletionOptions({
        maxRuntimeMs: 999_999,
      })
    ).toMatchObject({
      maxRuntimeMs: 30_000,
    });
  });

  it('deletes all ledger records for missing users', async () => {
    const store = new FakeRedisStore();
    const repo = new LedgerRepository(store);
    const entry = buildEntry();
    await seedEntry(store, entry);
    await store.set('form_nonce:nonce-1', JSON.stringify({ nonce: 'nonce-1' }));
    const reddit = {
      getUserById: vi.fn(async () => undefined),
    };

    await expect(
      runAccountDeletionCheck({
        ledgerRepository: repo,
        reddit,
        nowMs: nowMs + 2 * 24 * 60 * 60 * 1000,
        payload: {
          checkIntervalHours: 24,
          maxUsers: 5,
          maxEntriesPerUser: 10,
        },
      })
    ).resolves.toEqual({
      checked: 1,
      existingUsers: 0,
      deletedUsers: 1,
      deletedEntries: 1,
      failedChecks: 0,
      remainingEntries: 0,
      checkIntervalHours: 24,
      maxUsers: 5,
      maxEntriesPerUser: 10,
      maxEntriesPerRun: 1_000,
      maxRuntimeMs: 10_000,
    });

    expect(reddit.getUserById).toHaveBeenCalledWith('t2_user');
    await expect(repo.getLedgerEntry(entry.entryId)).resolves.toBeNull();
    await expect(
      store.zRange('post:t3_target:entries', 0, -1)
    ).resolves.toEqual([]);
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([]);
    await expect(store.get('form_nonce:nonce-1')).resolves.toBeNull();
  });

  it('refreshes tracked users that still resolve', async () => {
    const store = new FakeRedisStore();
    const repo = new LedgerRepository(store);
    const entry = buildEntry();
    await seedEntry(store, entry);
    const reddit = {
      getUserById: vi.fn(async () => ({ id: 't2_user' })),
    };

    await expect(
      runAccountDeletionCheck({
        ledgerRepository: repo,
        reddit,
        nowMs: nowMs + 2 * 24 * 60 * 60 * 1000,
        payload: {
          checkIntervalHours: 24,
          maxUsers: 5,
          maxEntriesPerUser: 10,
        },
      })
    ).resolves.toMatchObject({
      checked: 1,
      existingUsers: 1,
      deletedUsers: 0,
      deletedEntries: 0,
      failedChecks: 0,
      remainingEntries: 0,
    });

    await expect(
      store.zRange('users:tracked', 0, nowMs, { by: 'score' })
    ).resolves.toEqual([]);
    await expect(repo.getLedgerEntry(entry.entryId)).resolves.toEqual(entry);
  });

  it('removes expired transient-only indexes for users that still resolve', async () => {
    const store = new FakeRedisStore();
    const repo = new LedgerRepository(store);
    const reddit = {
      getUserById: vi.fn(async () => ({ id: 't2_user' })),
    };
    await repo.saveFormNonce({
      nonce: 'expired-nonce',
      targetId: 't3_target',
      targetKind: 'post',
      subredditName: 'testsub',
      userKey: 'id:t2_user',
      authorId: 't2_user',
      authorName: 'target-user',
      action: 'warn',
      moderatorUsername: 'mod-a',
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 10 * 60 * 1000,
    });
    store.nowMs = nowMs + 2 * 24 * 60 * 60 * 1000;

    await expect(
      runAccountDeletionCheck({
        ledgerRepository: repo,
        reddit,
        nowMs: store.nowMs,
        payload: {
          checkIntervalHours: 24,
          maxUsers: 5,
          maxEntriesPerUser: 10,
        },
      })
    ).resolves.toMatchObject({
      checked: 1,
      existingUsers: 1,
      deletedUsers: 0,
      deletedEntries: 0,
      failedChecks: 0,
      remainingEntries: 0,
    });

    await expect(store.get('form_nonce:expired-nonce')).resolves.toBeNull();
    await expect(
      store.zRange('user:id:t2_user:form_nonces', 0, -1)
    ).resolves.toEqual([]);
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([]);
  });

  it('retries existing-user transient cleanup promptly when a bounded run leaves work', async () => {
    const store = new FakeRedisStore();
    const repo = new LedgerRepository(store);
    const reddit = {
      getUserById: vi.fn(async () => ({ id: 't2_user' })),
    };
    for (const nonce of ['expired-nonce-1', 'expired-nonce-2']) {
      await repo.saveFormNonce({
        nonce,
        targetId: 't3_target',
        targetKind: 'post',
        subredditName: 'testsub',
        userKey: 'id:t2_user',
        authorId: 't2_user',
        authorName: 'target-user',
        action: 'warn',
        moderatorUsername: 'mod-a',
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 10 * 60 * 1000,
      });
    }
    const firstRunMs = nowMs + 2 * 24 * 60 * 60 * 1000;
    store.nowMs = firstRunMs;

    await runAccountDeletionCheck({
      ledgerRepository: repo,
      reddit,
      nowMs: firstRunMs,
      payload: {
        checkIntervalHours: 24,
        maxUsers: 5,
        maxEntriesPerUser: 1,
      },
    });

    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([
      't2_user',
    ]);
    await expect(store.zScore('users:tracked', 't2_user')).resolves.toBe(
      firstRunMs - 24 * 60 * 60 * 1000 + 1
    );

    store.nowMs = firstRunMs + 1;
    await runAccountDeletionCheck({
      ledgerRepository: repo,
      reddit,
      nowMs: firstRunMs + 1,
      payload: {
        checkIntervalHours: 24,
        maxUsers: 5,
        maxEntriesPerUser: 1,
      },
    });

    await expect(
      store.zRange('user:id:t2_user:form_nonces', 0, -1)
    ).resolves.toEqual([]);
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([]);
  });

  it('caps deleted ledger entries per scheduler run', async () => {
    const store = new FakeRedisStore();
    const repo = new LedgerRepository(store);
    const first = buildEntry({
      entryId: 'entry-1',
      userId: 't2_first',
      userKey: 'id:t2_first',
      targetId: 't3_first',
      formNonce: 'nonce-1',
    });
    const second = buildEntry({
      entryId: 'entry-2',
      userId: 't2_second',
      userKey: 'id:t2_second',
      targetId: 't3_second',
      formNonce: 'nonce-2',
      createdAtMs: nowMs + 1,
    });
    await seedEntry(store, first);
    await seedEntry(store, second);
    const reddit = {
      getUserById: vi.fn(async () => undefined),
    };

    await expect(
      runAccountDeletionCheck({
        ledgerRepository: repo,
        reddit,
        nowMs: nowMs + 2 * 24 * 60 * 60 * 1000,
        payload: {
          checkIntervalHours: 24,
          maxUsers: 5,
          maxEntriesPerUser: 10,
          maxEntriesPerRun: 1,
        },
      })
    ).resolves.toMatchObject({
      checked: 1,
      deletedUsers: 1,
      deletedEntries: 1,
      failedChecks: 0,
      remainingEntries: 0,
      maxEntriesPerRun: 1,
    });

    expect(reddit.getUserById).toHaveBeenCalledTimes(1);
    await expect(repo.getLedgerEntry(first.entryId)).resolves.toBeNull();
    await expect(repo.getLedgerEntry(second.entryId)).resolves.toEqual(second);
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([
      't2_second',
    ]);
  });

  it('stops account deletion checks when the runtime budget is exhausted', async () => {
    const store = new FakeRedisStore();
    const repo = new LedgerRepository(store);
    const first = buildEntry({
      entryId: 'entry-1',
      userId: 't2_first',
      userKey: 'id:t2_first',
      targetId: 't3_first',
      formNonce: 'nonce-1',
    });
    const second = buildEntry({
      entryId: 'entry-2',
      userId: 't2_second',
      userKey: 'id:t2_second',
      targetId: 't3_second',
      formNonce: 'nonce-2',
      createdAtMs: nowMs + 1,
    });
    await seedEntry(store, first);
    await seedEntry(store, second);
    const reddit = {
      getUserById: vi.fn(async () => undefined),
    };
    const clock = [0, 0, 1_001, 1_001];
    const getNowMs = () => clock.shift() ?? 1_001;

    await expect(
      runAccountDeletionCheck({
        ledgerRepository: repo,
        reddit,
        getNowMs,
        nowMs: nowMs + 2 * 24 * 60 * 60 * 1000,
        payload: {
          checkIntervalHours: 24,
          maxUsers: 5,
          maxEntriesPerUser: 10,
          maxEntriesPerRun: 10,
          maxRuntimeMs: 1_000,
        },
      })
    ).resolves.toMatchObject({
      checked: 1,
      deletedUsers: 1,
      deletedEntries: 1,
      failedChecks: 0,
      remainingEntries: 0,
      stoppedEarly: true,
    });

    expect(reddit.getUserById).toHaveBeenCalledTimes(1);
    await expect(repo.getLedgerEntry(first.entryId)).resolves.toBeNull();
    await expect(repo.getLedgerEntry(second.entryId)).resolves.toEqual(second);
  });

  it('continues after a per-user lookup failure', async () => {
    const store = new FakeRedisStore();
    const repo = new LedgerRepository(store);
    const failedLookup = buildEntry({
      entryId: 'entry-failed-lookup',
      userId: 't2_failed_lookup',
      userKey: 'id:t2_failed_lookup',
      targetId: 't3_failed_lookup',
      formNonce: 'nonce-failed-lookup',
    });
    const deleted = buildEntry({
      entryId: 'entry-deleted',
      userId: 't2_deleted',
      userKey: 'id:t2_deleted',
      targetId: 't3_deleted',
      formNonce: 'nonce-deleted',
      createdAtMs: nowMs + 1,
    });
    await seedEntry(store, failedLookup);
    await seedEntry(store, deleted);
    const runNowMs = nowMs + 2 * 24 * 60 * 60 * 1000;
    const reddit = {
      getUserById: vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary reddit failure'))
        .mockResolvedValueOnce(undefined),
    };

    await expect(
      runAccountDeletionCheck({
        ledgerRepository: repo,
        reddit,
        nowMs: runNowMs,
        payload: {
          checkIntervalHours: 24,
          maxUsers: 5,
          maxEntriesPerUser: 10,
        },
      })
    ).resolves.toMatchObject({
      checked: 2,
      deletedUsers: 1,
      deletedEntries: 1,
      failedChecks: 1,
      remainingEntries: 0,
    });

    await expect(repo.getLedgerEntry(failedLookup.entryId)).resolves.toEqual(
      failedLookup
    );
    await expect(repo.getLedgerEntry(deleted.entryId)).resolves.toBeNull();
    await expect(
      store.zRange('users:tracked', 0, runNowMs - 1, { by: 'score' })
    ).resolves.toEqual(['t2_failed_lookup']);
  });

  it('moves failed lookups behind other due users without marking them checked', async () => {
    const store = new FakeRedisStore();
    const repo = new LedgerRepository(store);
    const failedLookup = buildEntry({
      entryId: 'entry-failed-lookup',
      userId: 't2_failed_lookup',
      userKey: 'id:t2_failed_lookup',
      targetId: 't3_failed_lookup',
      formNonce: 'nonce-failed-lookup',
    });
    const laterDue = buildEntry({
      entryId: 'entry-later-due',
      userId: 't2_later_due',
      userKey: 'id:t2_later_due',
      targetId: 't3_later_due',
      formNonce: 'nonce-later-due',
      createdAtMs: nowMs + 1,
    });
    await seedEntry(store, failedLookup);
    await seedEntry(store, laterDue);
    const runNowMs = nowMs + 2 * 24 * 60 * 60 * 1000;
    const checkIntervalMs = 24 * 60 * 60 * 1000;
    const reddit = {
      getUserById: vi.fn().mockRejectedValueOnce(new Error('reddit timeout')),
    };

    await expect(
      runAccountDeletionCheck({
        ledgerRepository: repo,
        reddit,
        nowMs: runNowMs,
        payload: {
          checkIntervalHours: 24,
          maxUsers: 1,
          maxEntriesPerUser: 10,
        },
      })
    ).resolves.toMatchObject({
      checked: 1,
      deletedUsers: 0,
      failedChecks: 1,
    });

    await expect(
      repo.getTrackedUserIdsForAccountCheck(runNowMs, 5, checkIntervalMs)
    ).resolves.toEqual(['t2_later_due']);
    await expect(
      repo.getTrackedUserIdsForAccountCheck(runNowMs + 1, 5, checkIntervalMs)
    ).resolves.toEqual(['t2_later_due', 't2_failed_lookup']);
  });
});
