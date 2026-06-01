import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import {
  ACTION_LABELS,
  EMPTY_SIDE_EFFECTS,
  SCHEMA_VERSION,
  type LedgerEntry,
} from './domain';
import {
  createDuplicateKey,
  createModeratorRetryKey,
  getDuplicateClaimKey,
} from './idempotency';
import {
  LedgerRepository,
  type FormNonceRecord,
} from './ledgerRepository';
import {
  FakeRedisStore,
  RedisTransactionConflictError,
} from './redisStore';
import { MS_PER_DAY } from './scoring';

const nowMs = Date.UTC(2026, 0, 1);

const createRepo = () => {
  const store = new FakeRedisStore();
  store.nowMs = nowMs;
  return { store, repo: new LedgerRepository(store) };
};

class ConflictRedisStore extends FakeRedisStore {
  override async runTransaction<T>(
    _watchedKeys: readonly string[],
    _operation: () => Promise<T>
  ): Promise<T> {
    throw new RedisTransactionConflictError();
  }
}

const buildEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => {
  const submittedAtMs = overrides.createdAtMs ?? nowMs;
  const targetId = overrides.targetId ?? 't3_target';
  const action = overrides.action ?? 'warn';
  const ruleId = overrides.ruleId ?? 'rule-general';
  const moderatorUsername = overrides.moderatorUsername ?? 'mod-a';

  return {
    schemaVersion: SCHEMA_VERSION,
    entryId: overrides.entryId ?? 'entry-1',
    subredditName: overrides.subredditName ?? 'testsub',
    username: overrides.username ?? 'target-user',
    userKey: overrides.userKey ?? 'id:t2_user',
    targetId,
    targetKind: overrides.targetKind ?? 'post',
    targetPermalink: overrides.targetPermalink ?? '/r/testsub/comments/target',
    action,
    ruleId,
    ruleLabel: overrides.ruleLabel ?? 'Community rule violation',
    publicCommentOverrideUsed: overrides.publicCommentOverrideUsed ?? false,
    originalPoints: overrides.originalPoints ?? 1,
    moderatorUsername,
    createdAtMs: submittedAtMs,
    status: overrides.status ?? 'pending',
    idempotencyKey:
      overrides.idempotencyKey ??
      createModeratorRetryKey({
        targetId,
        action,
        ruleId,
        moderatorUsername,
        submittedAtMs,
      }),
    duplicateKey:
      overrides.duplicateKey ?? createDuplicateKey({ targetId, action, ruleId }),
    moderatorRetryKey:
      overrides.moderatorRetryKey ??
      createModeratorRetryKey({
        targetId,
        action,
        ruleId,
        moderatorUsername,
        submittedAtMs,
      }),
    idempotencyInputs: overrides.idempotencyInputs ?? {
      targetId,
      action,
      ruleId,
      moderatorUsername,
      submittedAtMs,
    },
    formNonce: overrides.formNonce ?? 'nonce-1',
    sideEffects: overrides.sideEffects ?? { ...EMPTY_SIDE_EFFECTS },
    ...(overrides.userId !== undefined ? { userId: overrides.userId } : {}),
    ...(overrides.reversedAtMs !== undefined
      ? { reversedAtMs: overrides.reversedAtMs }
      : {}),
  };
};

const buildNonce = (overrides: Partial<FormNonceRecord> = {}): FormNonceRecord => ({
  nonce: overrides.nonce ?? 'nonce-1',
  targetId: overrides.targetId ?? 't3_target',
  targetKind: overrides.targetKind ?? 'post',
  subredditName: overrides.subredditName ?? 'testsub',
  ...(overrides.userKey !== undefined ? { userKey: overrides.userKey } : {}),
  authorId: overrides.authorId ?? 't2_user',
  authorName: overrides.authorName ?? 'target-user',
  action: overrides.action ?? 'warn',
  moderatorUsername: overrides.moderatorUsername ?? 'mod-a',
  createdAtMs: overrides.createdAtMs ?? nowMs,
  expiresAtMs: overrides.expiresAtMs ?? nowMs + 10 * 60 * 1000,
  ...(overrides.consumedAtMs !== undefined
    ? { consumedAtMs: overrides.consumedAtMs }
    : {}),
  ...(overrides.entryId !== undefined ? { entryId: overrides.entryId } : {}),
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
};

describe('LedgerRepository', () => {
  it('creates a pending ledger entry, consumes nonce, indexes, and caches total', async () => {
    const { repo, store } = createRepo();
    const entry = buildEntry();
    await repo.saveFormNonce(buildNonce());

    const result = await repo.createLedgerEntry({
      entry,
      formNonce: entry.formNonce,
      submittedAtMs: nowMs,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    expect(result).toEqual({ status: 'created', entry, activeTotal: 1 });
    expect(store.transactionWatchKeys[0]).toEqual(
      expect.arrayContaining([
        'form_nonce:nonce-1',
        'ledger_entry:entry-1',
        'user:id:t2_user:ledger',
        'target:t3_target:entries',
      ])
    );
    await expect(repo.getLedgerEntry(entry.entryId)).resolves.toEqual(entry);
    await expect(repo.getUserLedger(entry.userKey)).resolves.toEqual([entry]);
    await expect(repo.getCachedActiveTotal(entry.userKey)).resolves.toBe(1);
  });

  it('blocks creation cleanly after repeated transaction conflicts', async () => {
    const repo = new LedgerRepository(new ConflictRedisStore());
    const entry = buildEntry();

    await expect(
      repo.createLedgerEntry({
        entry,
        formNonce: entry.formNonce,
        submittedAtMs: nowMs,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toEqual({
      status: 'blocked',
      reason: 'transaction_conflict',
    });
  });

  it('scopes create and reversal active totals to the entry subreddit', async () => {
    const { repo, store } = createRepo();
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-other-sub',
        subredditName: 'othersub',
        targetId: 't3_other',
        originalPoints: 99,
      })
    );

    const entry = buildEntry({
      entryId: 'entry-current-sub',
      originalPoints: 3,
    });
    await repo.saveFormNonce(buildNonce());

    await expect(
      repo.createLedgerEntry({
        entry,
        formNonce: entry.formNonce,
        submittedAtMs: nowMs,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toMatchObject({ status: 'created', activeTotal: 3 });
    await expect(repo.getCachedActiveTotal(entry.userKey)).resolves.toBe(3);

    await expect(
      repo.reverseLedgerEntry({
        entryId: entry.entryId,
        reversedAtMs: nowMs + 1000,
        reversedBy: 'mod-b',
        reversalReason: 'issued in error',
        config: DEFAULT_CONFIG,
        nowMs,
      })
    ).resolves.toMatchObject({ status: 'reversed', activeTotal: 0 });
    await expect(repo.getCachedActiveTotal(entry.userKey)).resolves.toBe(0);
  });

  it('returns the existing entry when a consumed nonce is replayed', async () => {
    const { repo } = createRepo();
    const entry = buildEntry();
    await repo.saveFormNonce(buildNonce());

    await repo.createLedgerEntry({
      entry,
      formNonce: entry.formNonce,
      submittedAtMs: nowMs,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    await expect(
      repo.createLedgerEntry({
        entry: buildEntry({ entryId: 'entry-ignored' }),
        formNonce: entry.formNonce,
        submittedAtMs: nowMs,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toEqual({ status: 'idempotent', entry, activeTotal: 1 });
  });

  it('returns the existing entry for the same moderator retry window', async () => {
    const { repo } = createRepo();
    const firstEntry = buildEntry();
    await repo.saveFormNonce(buildNonce());
    await repo.createLedgerEntry({
      entry: firstEntry,
      formNonce: firstEntry.formNonce,
      submittedAtMs: nowMs,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    const retryEntry = buildEntry({
      entryId: 'entry-2',
      formNonce: 'nonce-2',
    });
    await repo.saveFormNonce(buildNonce({ nonce: 'nonce-2' }));

    await expect(
      repo.createLedgerEntry({
        entry: retryEntry,
        formNonce: retryEntry.formNonce,
        submittedAtMs: nowMs + 60_000,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toEqual({
      status: 'idempotent',
      entry: firstEntry,
      activeTotal: 1,
    });
  });

  it('blocks duplicate target/action/rule submissions from another moderator', async () => {
    const { repo } = createRepo();
    const firstEntry = buildEntry();
    await repo.saveFormNonce(buildNonce());
    await repo.createLedgerEntry({
      entry: firstEntry,
      formNonce: firstEntry.formNonce,
      submittedAtMs: nowMs,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    const duplicateAttempt = buildEntry({
      entryId: 'entry-2',
      formNonce: 'nonce-2',
      moderatorUsername: 'mod-b',
    });
    await repo.saveFormNonce(
      buildNonce({ nonce: 'nonce-2', moderatorUsername: 'mod-b' })
    );

    await expect(
      repo.createLedgerEntry({
        entry: duplicateAttempt,
        formNonce: duplicateAttempt.formNonce,
        submittedAtMs: nowMs,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toEqual({
      status: 'duplicate',
      existingEntry: firstEntry,
    });
  });

  it('reverses entries, updates totals, and clears the duplicate claim', async () => {
    const { repo, store } = createRepo();
    const firstEntry = buildEntry({ originalPoints: 3 });
    await repo.saveFormNonce(buildNonce());
    await repo.createLedgerEntry({
      entry: firstEntry,
      formNonce: firstEntry.formNonce,
      submittedAtMs: nowMs,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    const reversed = await repo.reverseLedgerEntry({
      entryId: firstEntry.entryId,
      reversedAtMs: nowMs + 1000,
      reversedBy: 'mod-b',
      reversalReason: 'issued in error',
      config: DEFAULT_CONFIG,
      nowMs,
    });

    expect(reversed.status).toBe('reversed');
    expect(store.transactionWatchKeys.at(-1)).toEqual(
      expect.arrayContaining([
        'ledger_entry:entry-1',
        getDuplicateClaimKey({
          targetId: firstEntry.targetId,
          action: firstEntry.action,
          ruleId: firstEntry.ruleId,
        }),
      ])
    );
    await expect(repo.getCachedActiveTotal(firstEntry.userKey)).resolves.toBe(0);
    await expect(
      store.get(
        getDuplicateClaimKey({
          targetId: firstEntry.targetId,
          action: firstEntry.action,
          ruleId: firstEntry.ruleId,
        })
      )
    ).resolves.toBeNull();

    const secondEntry = buildEntry({ entryId: 'entry-2', formNonce: 'nonce-2' });
    await repo.saveFormNonce(buildNonce({ nonce: 'nonce-2' }));

    await expect(
      repo.createLedgerEntry({
        entry: secondEntry,
        formNonce: secondEntry.formNonce,
        submittedAtMs: nowMs + 11 * 60 * 1000,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toMatchObject({ status: 'created', activeTotal: 1 });
  });

  it('allows the same moderator to reissue immediately after reversal', async () => {
    const { repo } = createRepo();
    const firstEntry = buildEntry({ originalPoints: 3 });
    await repo.saveFormNonce(buildNonce());
    await repo.createLedgerEntry({
      entry: firstEntry,
      formNonce: firstEntry.formNonce,
      submittedAtMs: nowMs,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    await repo.reverseLedgerEntry({
      entryId: firstEntry.entryId,
      reversedAtMs: nowMs + 1000,
      reversedBy: 'mod-a',
      reversalReason: 'issued in error',
      config: DEFAULT_CONFIG,
      nowMs,
    });

    const secondEntry = buildEntry({
      entryId: 'entry-2',
      formNonce: 'nonce-2',
      createdAtMs: nowMs + 60_000,
    });
    await repo.saveFormNonce(
      buildNonce({
        nonce: 'nonce-2',
        createdAtMs: nowMs + 60_000,
      })
    );

    await expect(
      repo.createLedgerEntry({
        entry: secondEntry,
        formNonce: secondEntry.formNonce,
        submittedAtMs: nowMs + 60_000,
        nowMs: nowMs + 60_000,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toMatchObject({
      status: 'created',
      entry: expect.objectContaining({ entryId: 'entry-2' }),
      activeTotal: 1,
    });
  });

  it('blocks expired and mismatched nonces before ledger creation', async () => {
    const { repo, store } = createRepo();
    const entry = buildEntry();
    store.nowMs = nowMs - 2;
    await repo.saveFormNonce(buildNonce({ expiresAtMs: nowMs - 1 }));
    store.nowMs = nowMs - 2;

    await expect(
      repo.createLedgerEntry({
        entry,
        formNonce: entry.formNonce,
        submittedAtMs: nowMs,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toEqual({ status: 'blocked', reason: 'nonce_expired' });

    store.nowMs = nowMs;
    await repo.saveFormNonce(
      buildNonce({ nonce: 'nonce-2', subredditName: 'othersub' })
    );
    const mismatchedEntry = buildEntry({ entryId: 'entry-2', formNonce: 'nonce-2' });

    await expect(
      repo.createLedgerEntry({
        entry: mismatchedEntry,
        formNonce: mismatchedEntry.formNonce,
        submittedAtMs: nowMs,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toEqual({
      status: 'blocked',
      reason: 'nonce_context_mismatch',
    });
  });

  it('recalculates active totals with decay from indexed entries', async () => {
    const { repo } = createRepo();
    const oldEntry = buildEntry({
      entryId: 'entry-old',
      formNonce: 'nonce-old',
      originalPoints: 3,
      createdAtMs: nowMs - 60 * MS_PER_DAY,
    });
    await repo.saveFormNonce(
      buildNonce({
        nonce: 'nonce-old',
        createdAtMs: oldEntry.createdAtMs,
        expiresAtMs: nowMs + 10 * 60 * 1000,
      })
    );
    await repo.createLedgerEntry({
      entry: oldEntry,
      formNonce: oldEntry.formNonce,
      submittedAtMs: nowMs - 60 * MS_PER_DAY,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    const newEntry = buildEntry({
      entryId: 'entry-new',
      targetId: 't3_other',
      formNonce: 'nonce-new',
      originalPoints: 1,
    });
    await repo.saveFormNonce(
      buildNonce({ nonce: 'nonce-new', targetId: 't3_other' })
    );

    await expect(
      repo.createLedgerEntry({
        entry: newEntry,
        formNonce: newEntry.formNonce,
        submittedAtMs: nowMs,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toMatchObject({ status: 'created', activeTotal: 2 });
  });

  it('reads a page of user ledger entries from newest to oldest', async () => {
    const { repo } = createRepo();

    for (const index of [1, 2, 3]) {
      const entry = buildEntry({
        entryId: `entry-${index}`,
        targetId: `t3_target_${index}`,
        formNonce: `nonce-${index}`,
        createdAtMs: nowMs + index,
      });
      await repo.saveFormNonce(
        buildNonce({
          nonce: entry.formNonce,
          targetId: entry.targetId,
          createdAtMs: entry.createdAtMs,
        })
      );
      await repo.createLedgerEntry({
        entry,
        formNonce: entry.formNonce,
        submittedAtMs: entry.createdAtMs,
        nowMs: entry.createdAtMs,
        config: DEFAULT_CONFIG,
      });
    }

    await expect(repo.getUserLedgerPage('id:t2_user', 1, 1)).resolves.toEqual([
      expect.objectContaining({ entryId: 'entry-2' }),
    ]);
  });

  it('reads and recalculates across primary and fallback user keys', async () => {
    const { repo, store } = createRepo();
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-fallback',
        userKey: 'name:someuser',
        username: 'SomeUser',
        originalPoints: 3,
        createdAtMs: nowMs,
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-id',
        userKey: 'id:t2_user',
        userId: 't2_user',
        originalPoints: 1,
        createdAtMs: nowMs + 1,
      })
    );

    await expect(
      repo.getUserLedgerPageForKeys(['id:t2_user', 'name:someuser'], 0, 2)
    ).resolves.toEqual([
      expect.objectContaining({ entryId: 'entry-id' }),
      expect.objectContaining({ entryId: 'entry-fallback' }),
    ]);
    await expect(
      repo.recalculateActiveTotalForKeys(
        ['id:t2_user', 'name:someuser'],
        'id:t2_user',
        DEFAULT_CONFIG,
        nowMs
      )
    ).resolves.toBe(4);
    await expect(repo.getCachedActiveTotal('id:t2_user')).resolves.toBe(4);
  });

  it('migrates username fallback entries into the user ID ledger', async () => {
    const { repo, store } = createRepo();
    const fallbackEntry = buildEntry({
      entryId: 'entry-fallback',
      userKey: 'name:someuser',
      username: 'SomeUser',
    });
    await seedEntry(store, fallbackEntry);

    await expect(
      repo.migrateUsernameLedgerToUserId({
        username: 'u/SomeUser',
        userId: 't2_user',
      })
    ).resolves.toEqual({
      fromUserKey: 'name:someuser',
      toUserKey: 'id:t2_user',
      migratedCount: 1,
    });
    await expect(repo.getUserLedger('name:someuser')).resolves.toEqual([]);
    await expect(repo.getUserLedger('id:t2_user')).resolves.toEqual([
      expect.objectContaining({
        entryId: 'entry-fallback',
        username: 'SomeUser',
        userKey: 'id:t2_user',
        userId: 't2_user',
        migratedFromUsername: 'someuser',
      }),
    ]);
  });

  it('rejects ledger entries from future schema versions', async () => {
    const { repo, store } = createRepo();
    const entry = buildEntry();
    await store.set(
      `ledger_entry:${entry.entryId}`,
      JSON.stringify({ ...entry, schemaVersion: 2 })
    );

    await expect(repo.getLedgerEntry(entry.entryId)).rejects.toThrow(
      'Unsupported StrikeLedger schema version 2.'
    );
  });

  it('keeps action labels available for side-effect rendering callers', () => {
    expect(ACTION_LABELS.warn_remove).toBe('Warn and remove');
  });
});
