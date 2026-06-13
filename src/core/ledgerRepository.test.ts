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
  getRetryClaimKey,
} from './idempotency';
import {
  LedgerRepository,
  type FormNonceRecord,
} from './ledgerRepository';
import {
  FakeRedisStore,
  RedisTransactionConflictError,
  type ZRangeOptions,
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

class RecordingRedisStore extends FakeRedisStore {
  readonly zRangeCalls: Array<{
    key: string;
    start: number;
    stop: number;
    options?: ZRangeOptions;
  }> = [];

  override async zRange(
    key: string,
    start: number,
    stop: number,
    options?: ZRangeOptions
  ): Promise<string[]> {
    this.zRangeCalls.push({
      key,
      start,
      stop,
      ...(options !== undefined ? { options } : {}),
    });
    return super.zRange(key, start, stop, options);
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
    ...(overrides.publicCommentId !== undefined
      ? { publicCommentId: overrides.publicCommentId }
      : {}),
    ...(overrides.reversedAtMs !== undefined
      ? { reversedAtMs: overrides.reversedAtMs }
      : {}),
    ...(overrides.reversedBy !== undefined
      ? { reversedBy: overrides.reversedBy }
      : {}),
    ...(overrides.reversalReason !== undefined
      ? { reversalReason: overrides.reversalReason }
      : {}),
    ...(overrides.reversalNote !== undefined
      ? { reversalNote: overrides.reversalNote }
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
  await store.zAdd(`target:${entry.targetId}:entries`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
  await store.zAdd(`ledger:${entry.subredditName.toLowerCase()}:entries`, {
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
    expect(store.transactionWatchKeys[0]).toEqual([
      'form_nonce:nonce-1',
      getDuplicateClaimKey({
        targetId: entry.targetId,
        action: entry.action,
        ruleId: entry.ruleId,
      }),
      getRetryClaimKey({
        targetId: entry.targetId,
        action: entry.action,
        ruleId: entry.ruleId,
        moderatorUsername: entry.moderatorUsername,
        submittedAtMs: nowMs,
      }),
      'ledger_entry:entry-1',
    ]);
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

  it('includes fallback username entries in create and reversal totals for ID-key users', async () => {
    const { repo, store } = createRepo();
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-fallback',
        targetId: 't3_legacy',
        userKey: 'name:target-user',
        username: 'Target-User',
        originalPoints: 3,
      })
    );

    const entry = buildEntry({
      entryId: 'entry-current',
      targetId: 't3_current',
      formNonce: 'nonce-current',
      userId: 't2_user',
      username: 'Target-User',
      originalPoints: 2,
    });
    await repo.saveFormNonce(
      buildNonce({
        nonce: 'nonce-current',
        targetId: 't3_current',
        authorId: 't2_user',
        authorName: 'Target-User',
      })
    );

    await expect(
      repo.createLedgerEntry({
        entry,
        formNonce: entry.formNonce,
        submittedAtMs: nowMs,
        nowMs,
        config: DEFAULT_CONFIG,
      })
    ).resolves.toMatchObject({ status: 'created', activeTotal: 5 });
    await expect(repo.getCachedActiveTotal('id:t2_user')).resolves.toBe(5);

    await expect(
      repo.reverseLedgerEntry({
        entryId: entry.entryId,
        reversedAtMs: nowMs + 1000,
        reversedBy: 'mod-b',
        reversalReason: 'issued in error',
        config: DEFAULT_CONFIG,
        nowMs,
      })
    ).resolves.toMatchObject({ status: 'reversed', activeTotal: 3 });
    await expect(repo.getCachedActiveTotal('id:t2_user')).resolves.toBe(3);
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

    await expect(repo.getFormNonce('nonce-2')).resolves.toMatchObject({
      nonce: 'nonce-2',
      consumedAtMs: nowMs,
      entryId: firstEntry.entryId,
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

  it('pages user ledger entries without reading full ledgers for each identifier', async () => {
    const store = new RecordingRedisStore();
    const repo = new LedgerRepository(store);
    const baseMs = nowMs;

    for (let index = 0; index < 40; index += 1) {
      await seedEntry(
        store,
        buildEntry({
          entryId: `id-${index}`,
          userKey: 'id:t2_user',
          targetId: `t3_id_${index}`,
          createdAtMs: baseMs + index,
        })
      );
      await seedEntry(
        store,
        buildEntry({
          entryId: `name-${index}`,
          userKey: 'name:someuser',
          targetId: `t3_name_${index}`,
          createdAtMs: baseMs + 1000 + index,
        })
      );
    }

    const result = await repo.getUserLedgerPageForKeys(
      ['id:t2_user', 'name:someuser'],
      10,
      5
    );

    expect(result).toHaveLength(5);
    expect(store.zRangeCalls.some((call) => call.stop === -1)).toBe(false);
  });

  it('preserves reversal metadata when a late side-effect checkpoint updates an entry', async () => {
    const { repo, store } = createRepo();
    const reversedEntry = buildEntry({
      status: 'reversed',
      sideEffects: {
        ...EMPTY_SIDE_EFFECTS,
        publicComment: 'failed',
        reversalModNote: 'succeeded',
        reversalUserNotice: 'succeeded',
      },
      reversalReason: 'mistake',
      reversalNote: 'Handled by another moderator.',
      reversedBy: 'mod-b',
      reversedAtMs: nowMs + 1000,
    });
    await seedEntry(store, reversedEntry);

    await repo.updateLedgerEntrySideEffects(
      buildEntry({
        status: 'succeeded',
        sideEffects: { ...EMPTY_SIDE_EFFECTS, publicComment: 'succeeded' },
        publicCommentId: 't1_comment',
      })
    );

    const stored = await repo.getLedgerEntry('entry-1');

    expect(stored?.status).toBe('reversed');
    expect(stored?.reversalReason).toBe('mistake');
    expect(stored?.reversalNote).toBe('Handled by another moderator.');
    expect(stored?.sideEffects.publicComment).toBe('succeeded');
    expect(stored?.sideEffects.reversalModNote).toBe('succeeded');
    expect(stored?.sideEffects.reversalUserNotice).toBe('succeeded');
    expect(stored?.publicCommentId).toBe('t1_comment');
  });

  it('cleans up old inactive ledger entries from all indexes', async () => {
    const { repo, store } = createRepo();
    const old = nowMs - 400 * MS_PER_DAY;
    const recent = nowMs - 10 * MS_PER_DAY;
    const oldInactive = buildEntry({ entryId: 'old-inactive', createdAtMs: old });
    const oldReversed = buildEntry({
      entryId: 'old-reversed',
      status: 'reversed',
      createdAtMs: old,
    });
    const recentActive = buildEntry({
      entryId: 'recent-active',
      createdAtMs: recent,
    });
    await seedEntry(store, oldInactive);
    await seedEntry(store, oldReversed);
    await seedEntry(store, recentActive);

    const result = await repo.cleanupLedger({
      config: DEFAULT_CONFIG,
      maxEntries: 10,
      nowMs,
      retentionDays: 365,
      subredditName: 'testsub',
    });

    expect(result.deleted).toBe(2);
    expect(await repo.getLedgerEntry('old-inactive')).toBeNull();
    expect(await repo.getLedgerEntry('old-reversed')).toBeNull();
    expect(await repo.getLedgerEntry('recent-active')).not.toBeNull();
    await expect(store.zRange('user:id:t2_user:ledger', 0, -1)).resolves.toEqual([
      'recent-active',
    ]);
    await expect(store.zRange('target:t3_target:entries', 0, -1)).resolves.toEqual([
      'recent-active',
    ]);
    await expect(
      store.zRange('ledger:testsub:entries', 0, -1)
    ).resolves.toEqual(['recent-active']);
  });

  it('advances cleanup past old active entries', async () => {
    const { repo, store } = createRepo();
    const old = nowMs - 400 * MS_PER_DAY;
    await seedEntry(
      store,
      buildEntry({
        entryId: 'old-active',
        targetId: 't3_old_active',
        createdAtMs: old,
        originalPoints: 100,
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'old-inactive',
        targetId: 't3_old_inactive',
        createdAtMs: old + 1,
      })
    );

    const firstRun = await repo.cleanupLedger({
      config: DEFAULT_CONFIG,
      maxEntries: 1,
      nowMs,
      retentionDays: 365,
      subredditName: 'testsub',
    });
    const secondRun = await repo.cleanupLedger({
      config: DEFAULT_CONFIG,
      maxEntries: 1,
      nowMs,
      retentionDays: 365,
      subredditName: 'testsub',
    });

    expect(firstRun).toEqual({ scanned: 1, deleted: 0 });
    expect(secondRun).toEqual({ scanned: 1, deleted: 1 });
    expect(await repo.getLedgerEntry('old-active')).not.toBeNull();
    expect(await repo.getLedgerEntry('old-inactive')).toBeNull();
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

  it('recalculates active totals without full ledger scans when decay bounds old entries', async () => {
    const store = new RecordingRedisStore();
    const repo = new LedgerRepository(store);
    const fastDecayConfig = {
      ...DEFAULT_CONFIG,
      decayAmount: 100,
    };
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-old',
        originalPoints: 100,
        createdAtMs: nowMs - 60 * MS_PER_DAY,
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-recent',
        targetId: 't3_recent',
        originalPoints: 3,
        createdAtMs: nowMs - 10 * MS_PER_DAY,
      })
    );

    await expect(
      repo.recalculateActiveTotalForKeys(
        ['id:t2_user'],
        'id:t2_user',
        fastDecayConfig,
        nowMs,
        'testsub'
      )
    ).resolves.toBe(3);
    expect(store.zRangeCalls.some((call) => call.stop === -1)).toBe(false);
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
