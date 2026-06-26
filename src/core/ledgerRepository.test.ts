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
import { DashboardRepository, type ViewContextRecord } from './dashboard';
import { LedgerRepository, type FormNonceRecord } from './ledgerRepository';
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

class MutatingLedgerRedisStore extends FakeRedisStore {
  mutation: (() => Promise<void>) | null = null;
  private mutated = false;

  override async zRange(
    key: string,
    start: number,
    stop: number,
    options?: ZRangeOptions
  ): Promise<string[]> {
    const result = await super.zRange(key, start, stop, options);
    if (!this.mutated && key === 'user:id:t2_user:ledger' && this.mutation) {
      this.mutated = true;
      await this.mutation();
    }

    return result;
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
    userId: overrides.userId ?? 't2_user',
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
      overrides.duplicateKey ??
      createDuplicateKey({ targetId, action, ruleId }),
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
    ...(overrides.targetPostId !== undefined
      ? { targetPostId: overrides.targetPostId }
      : {}),
    ...(overrides.targetDeletedAtMs !== undefined
      ? { targetDeletedAtMs: overrides.targetDeletedAtMs }
      : {}),
    ...(overrides.publicCommentId !== undefined
      ? { publicCommentId: overrides.publicCommentId }
      : {}),
    ...(overrides.publicCorrectionCommentId !== undefined
      ? { publicCorrectionCommentId: overrides.publicCorrectionCommentId }
      : {}),
    ...(overrides.modNoteId !== undefined
      ? { modNoteId: overrides.modNoteId }
      : {}),
    ...(overrides.userNoticeId !== undefined
      ? { userNoticeId: overrides.userNoticeId }
      : {}),
    ...(overrides.reversalModNoteId !== undefined
      ? { reversalModNoteId: overrides.reversalModNoteId }
      : {}),
    ...(overrides.reversalUserNoticeId !== undefined
      ? { reversalUserNoticeId: overrides.reversalUserNoticeId }
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

const buildNonce = (
  overrides: Partial<FormNonceRecord> = {}
): FormNonceRecord => ({
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

const buildViewContext = (
  overrides: Partial<ViewContextRecord> = {}
): ViewContextRecord => ({
  token: overrides.token ?? 'context-1',
  targetId: overrides.targetId ?? 't3_target',
  targetKind: overrides.targetKind ?? 'post',
  subredditName: overrides.subredditName ?? 'testsub',
  userKey: overrides.userKey ?? 'id:t2_user',
  createdAtMs: overrides.createdAtMs ?? nowMs,
  expiresAtMs: overrides.expiresAtMs ?? nowMs + 15 * 60 * 1000,
  authorId: overrides.authorId ?? 't2_user',
  authorName: overrides.authorName ?? 'target-user',
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
  await store.zAdd(`ledger:${entry.subredditName.toLowerCase()}:entries`, {
    member: entry.entryId,
    score: entry.createdAtMs,
  });
};

describe('LedgerRepository', () => {
  it('stores form nonce records and cleanup indexes in one transaction', async () => {
    const { repo, store } = createRepo();

    await repo.saveFormNonce(buildNonce({ nonce: 'open-nonce' }));

    expect(store.transactionWatchKeys).toContainEqual([
      'form_nonce:open-nonce',
      'user:id:t2_user:form_nonces',
      'users:tracked',
    ]);
    await expect(store.get('form_nonce:open-nonce')).resolves.not.toBeNull();
    await expect(
      store.zRange('user:id:t2_user:form_nonces', 0, -1)
    ).resolves.toEqual(['open-nonce']);
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([
      't2_user',
    ]);
  });

  it('creates a pending ledger entry, consumes nonce, indexes, and caches total', async () => {
    const { repo, store } = createRepo();
    const entry = buildEntry({ userId: 't2_user' });
    await repo.saveFormNonce(buildNonce());

    const result = await repo.createLedgerEntry({
      entry,
      formNonce: entry.formNonce,
      submittedAtMs: nowMs,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    expect(result).toEqual({ status: 'created', entry, activeTotal: 1 });
    expect(store.transactionWatchKeys).toContainEqual([
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
      getRetryClaimKey({
        targetId: entry.targetId,
        action: entry.action,
        ruleId: entry.ruleId,
        moderatorUsername: entry.moderatorUsername,
        submittedAtMs: nowMs - 10 * 60 * 1000,
      }),
      'ledger_entry:entry-1',
    ]);
    await expect(repo.getLedgerEntry(entry.entryId)).resolves.toEqual(entry);
    await expect(repo.getUserLedger(entry.userKey)).resolves.toEqual([entry]);
    await expect(
      repo.getTrackedUserIdsForAccountCheck(nowMs + 1, 10, 0)
    ).resolves.toEqual(['t2_user']);
    await expect(repo.getCachedActiveTotal(entry.userKey)).resolves.toBe(1);
  });

  it('deletes a deleted user ledger from every index', async () => {
    const { repo, store } = createRepo();
    const entry = buildEntry({
      userId: 't2_user',
      status: 'succeeded',
      publicCommentId: 't1_public_comment',
      modNoteId: 'mod-note-1',
      userNoticeId: 'modmail-1',
    });
    await seedEntry(store, entry);
    await store.zAdd('users:tracked', {
      member: 't2_user',
      score: entry.createdAtMs,
    });
    await store.set('user:id:t2_user:active_total', '1');
    await store.set('user:id:t2_user:ledger_version', '3');
    await store.set(
      getDuplicateClaimKey({
        targetId: entry.targetId,
        action: entry.action,
        ruleId: entry.ruleId,
      }),
      entry.entryId
    );
    await store.set(
      getRetryClaimKey({
        targetId: entry.targetId,
        action: entry.action,
        ruleId: entry.ruleId,
        moderatorUsername: entry.moderatorUsername,
        submittedAtMs: entry.createdAtMs,
      }),
      entry.entryId
    );
    await store.set('form_nonce:nonce-1', JSON.stringify(buildNonce()));

    await expect(
      store.zRange('post:t3_target:entries', 0, -1)
    ).resolves.toEqual([entry.entryId]);
    await expect(store.get('form_nonce:nonce-1')).resolves.not.toBeNull();
    await expect(repo.deleteUserLedgerByUserId('t2_user', 10)).resolves.toEqual(
      {
        scanned: 1,
        deleted: 1,
        remaining: 0,
      }
    );

    await expect(repo.getLedgerEntry(entry.entryId)).resolves.toBeNull();
    await expect(
      store.zRange('user:id:t2_user:ledger', 0, -1)
    ).resolves.toEqual([]);
    await expect(store.get('user:id:t2_user:active_total')).resolves.toBeNull();
    await expect(
      store.get('user:id:t2_user:ledger_version')
    ).resolves.toBeNull();
    await expect(
      store.zRange('target:t3_target:entries', 0, -1)
    ).resolves.toEqual([]);
    await expect(
      store.zRange('post:t3_target:entries', 0, -1)
    ).resolves.toEqual([]);
    await expect(
      store.zRange('ledger:testsub:entries', 0, -1)
    ).resolves.toEqual([]);
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([]);
    await expect(
      store.get(
        getDuplicateClaimKey({
          targetId: entry.targetId,
          action: entry.action,
          ruleId: entry.ruleId,
        })
      )
    ).resolves.toBeNull();
    await expect(
      store.get(
        getRetryClaimKey({
          targetId: entry.targetId,
          action: entry.action,
          ruleId: entry.ruleId,
          moderatorUsername: entry.moderatorUsername,
          submittedAtMs: entry.createdAtMs,
        })
      )
    ).resolves.toBeNull();
    await expect(store.get('form_nonce:nonce-1')).resolves.toBeNull();
  });

  it('deletes open author snapshots for a deleted user', async () => {
    const { repo, store } = createRepo();
    const dashboard = new DashboardRepository(store);

    await repo.saveFormNonce(buildNonce({ nonce: 'open-nonce' }));
    await dashboard.saveViewContext(
      buildViewContext({ token: 'open-context' })
    );
    await store.zAdd('users:tracked', {
      member: 't2_user',
      score: nowMs,
    });

    await expect(repo.deleteUserLedgerByUserId('t2_user', 10)).resolves.toEqual(
      {
        scanned: 2,
        deleted: 0,
        remaining: 0,
      }
    );

    await expect(store.get('form_nonce:open-nonce')).resolves.toBeNull();
    await expect(store.get('view_context:open-context')).resolves.toBeNull();
    await expect(
      store.zRange('user:id:t2_user:form_nonces', 0, -1)
    ).resolves.toEqual([]);
    await expect(
      store.zRange('user:id:t2_user:view_contexts', 0, -1)
    ).resolves.toEqual([]);
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([]);
  });

  it('keeps transient author snapshot deletion bounded', async () => {
    const { repo, store } = createRepo();
    const dashboard = new DashboardRepository(store);

    for (const index of [1, 2, 3]) {
      await repo.saveFormNonce(buildNonce({ nonce: `open-nonce-${index}` }));
      await dashboard.saveViewContext(
        buildViewContext({ token: `open-context-${index}` })
      );
    }
    await store.zAdd('users:tracked', {
      member: 't2_user',
      score: nowMs,
    });

    await expect(repo.deleteUserLedgerByUserId('t2_user', 2)).resolves.toEqual({
      scanned: 2,
      deleted: 0,
      remaining: 1,
    });

    await expect(store.get('form_nonce:open-nonce-1')).resolves.toBeNull();
    await expect(store.get('form_nonce:open-nonce-2')).resolves.toBeNull();
    await expect(store.get('form_nonce:open-nonce-3')).resolves.not.toBeNull();
    await expect(
      store.get('view_context:open-context-1')
    ).resolves.not.toBeNull();
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([
      't2_user',
    ]);

    await expect(repo.deleteUserLedgerByUserId('t2_user', 10)).resolves.toEqual(
      {
        scanned: 4,
        deleted: 0,
        remaining: 0,
      }
    );
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([]);
  });

  it('finalizes deleted-user metadata when transient cleanup exactly consumes the budget', async () => {
    const { repo, store } = createRepo();

    await repo.saveFormNonce(buildNonce({ nonce: 'open-nonce' }));
    await store.zAdd('users:tracked', {
      member: 't2_user',
      score: nowMs,
    });
    await store.set('user:id:t2_user:active_total', '1');
    await store.set('user:id:t2_user:ledger_version', '3');

    await expect(repo.deleteUserLedgerByUserId('t2_user', 1)).resolves.toEqual({
      scanned: 1,
      deleted: 0,
      remaining: 0,
    });

    await expect(store.get('form_nonce:open-nonce')).resolves.toBeNull();
    await expect(
      store.zRange('user:id:t2_user:form_nonces', 0, -1)
    ).resolves.toEqual([]);
    await expect(store.get('user:id:t2_user:active_total')).resolves.toBeNull();
    await expect(
      store.get('user:id:t2_user:ledger_version')
    ).resolves.toBeNull();
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([]);
  });

  it('deletes stale deleted-user metadata when only missing ledger entries remain', async () => {
    const { repo, store } = createRepo();
    await store.zAdd('user:id:t2_user:ledger', {
      member: 'missing-entry',
      score: nowMs,
    });
    await store.zAdd('users:tracked', {
      member: 't2_user',
      score: nowMs,
    });
    await store.set('user:id:t2_user:active_total', '1');
    await store.set('user:id:t2_user:ledger_version', '3');

    await expect(repo.deleteUserLedgerByUserId('t2_user', 10)).resolves.toEqual(
      {
        scanned: 1,
        deleted: 0,
        remaining: 0,
      }
    );

    await expect(
      store.zRange('user:id:t2_user:ledger', 0, -1)
    ).resolves.toEqual([]);
    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([]);
    await expect(store.get('user:id:t2_user:active_total')).resolves.toBeNull();
    await expect(
      store.get('user:id:t2_user:ledger_version')
    ).resolves.toBeNull();
  });

  it('keeps deleted-user cleanup bounded for later runs', async () => {
    const { repo, store } = createRepo();
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-1',
        userId: 't2_user',
        targetId: 't3_first',
        createdAtMs: nowMs,
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-2',
        userId: 't2_user',
        targetId: 't3_second',
        createdAtMs: nowMs + 1,
      })
    );
    await store.zAdd('users:tracked', {
      member: 't2_user',
      score: nowMs,
    });

    await expect(repo.deleteUserLedgerByUserId('t2_user', 1)).resolves.toEqual({
      scanned: 1,
      deleted: 1,
      remaining: 1,
    });

    await expect(store.zRange('users:tracked', 0, -1)).resolves.toEqual([
      't2_user',
    ]);
    await expect(repo.getUserLedger('id:t2_user')).resolves.toHaveLength(1);
  });

  it('bounds tracked-user account checks at the Redis read', async () => {
    const store = new RecordingRedisStore();
    const repo = new LedgerRepository(store);
    for (let index = 0; index < 5; index += 1) {
      await store.zAdd('users:tracked', {
        member: `t2_due_${index}`,
        score: nowMs,
      });
    }

    await expect(
      repo.getTrackedUserIdsForAccountCheck(nowMs + 1, 2, 0)
    ).resolves.toEqual(['t2_due_0', 't2_due_1']);
    expect(store.zRangeCalls).toContainEqual({
      key: 'users:tracked',
      start: 0,
      stop: nowMs + 1,
      options: {
        by: 'score',
        limit: { offset: 0, count: 2 },
      },
    });
  });

  it('does not postpone account deletion checks when adding another entry', async () => {
    const { repo, store } = createRepo();
    const originalTrackedAtMs = nowMs - 2 * MS_PER_DAY;
    const entry = buildEntry({ createdAtMs: nowMs });

    await store.zAdd('users:tracked', {
      member: 't2_user',
      score: originalTrackedAtMs,
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
    ).resolves.toMatchObject({ status: 'created' });

    await expect(
      repo.getTrackedUserIdsForAccountCheck(originalTrackedAtMs + 1, 10, 0)
    ).resolves.toEqual(['t2_user']);
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

  it('does not merge username-key entries into ID-key totals', async () => {
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
    ).resolves.toMatchObject({ status: 'created', activeTotal: 2 });
    await expect(repo.getCachedActiveTotal('id:t2_user')).resolves.toBe(2);

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
    await expect(repo.getCachedActiveTotal('id:t2_user')).resolves.toBe(0);
  });

  it('does not index ID-key entries under username-derived keys', async () => {
    const { repo, store } = createRepo();
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

    await repo.createLedgerEntry({
      entry,
      formNonce: entry.formNonce,
      submittedAtMs: nowMs,
      nowMs,
      config: DEFAULT_CONFIG,
    });

    await expect(
      store.zRange('user:name:target-user:ledger', 0, -1)
    ).resolves.toEqual([]);
    await expect(
      repo.recalculateActiveTotalForKeys(
        ['name:target-user'],
        'name:target-user',
        DEFAULT_CONFIG,
        nowMs,
        'testsub'
      )
    ).resolves.toBe(0);
  });

  it('uses explicitly provided user keys when recalculating after reversal', async () => {
    const { repo, store } = createRepo();
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-id',
        userKey: 'id:t2_user',
        userId: 't2_user',
        username: 'TargetUser',
        targetId: 't3_current',
        originalPoints: 2,
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-other-user',
        userId: 't2_other',
        userKey: 'id:t2_other',
        username: 'OtherUser',
        targetId: 't3_other',
        originalPoints: 3,
      })
    );

    const result = await repo.reverseLedgerEntry({
      entryId: 'entry-other-user',
      reversedAtMs: nowMs + 1000,
      reversedBy: 'mod-b',
      reversalReason: 'issued in error',
      config: DEFAULT_CONFIG,
      nowMs,
      userKeys: ['id:t2_user', 'id:t2_other'],
      cacheUserKey: 'id:t2_user',
    } as Parameters<LedgerRepository['reverseLedgerEntry']>[0] & {
      userKeys: string[];
      cacheUserKey: string;
    });

    expect(result).toMatchObject({ status: 'reversed', activeTotal: 2 });
    await expect(repo.getCachedActiveTotal('id:t2_user')).resolves.toBe(2);
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

  it('returns the existing retry entry across retry bucket boundaries', async () => {
    const { repo } = createRepo();
    const firstSubmittedAtMs = nowMs + 10 * 60 * 1000 - 1;
    const firstEntry = buildEntry({ createdAtMs: firstSubmittedAtMs });
    await repo.saveFormNonce(buildNonce({ createdAtMs: firstSubmittedAtMs }));
    await repo.createLedgerEntry({
      entry: firstEntry,
      formNonce: firstEntry.formNonce,
      submittedAtMs: firstSubmittedAtMs,
      nowMs: firstSubmittedAtMs,
      config: DEFAULT_CONFIG,
    });

    const retrySubmittedAtMs = nowMs + 10 * 60 * 1000 + 1;
    const retryEntry = buildEntry({
      entryId: 'entry-2',
      formNonce: 'nonce-2',
      createdAtMs: retrySubmittedAtMs,
    });
    await repo.saveFormNonce(
      buildNonce({
        nonce: 'nonce-2',
        createdAtMs: retrySubmittedAtMs,
        expiresAtMs: retrySubmittedAtMs + 10 * 60 * 1000,
      })
    );

    await expect(
      repo.createLedgerEntry({
        entry: retryEntry,
        formNonce: retryEntry.formNonce,
        submittedAtMs: retrySubmittedAtMs,
        nowMs: retrySubmittedAtMs,
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
    expect(store.transactionWatchKeys).toContainEqual(
      expect.arrayContaining([
        'ledger_entry:entry-1',
        getDuplicateClaimKey({
          targetId: firstEntry.targetId,
          action: firstEntry.action,
          ruleId: firstEntry.ruleId,
        }),
      ])
    );
    await expect(repo.getCachedActiveTotal(firstEntry.userKey)).resolves.toBe(
      0
    );
    await expect(
      store.get(
        getDuplicateClaimKey({
          targetId: firstEntry.targetId,
          action: firstEntry.action,
          ruleId: firstEntry.ruleId,
        })
      )
    ).resolves.toBeNull();

    const secondEntry = buildEntry({
      entryId: 'entry-2',
      formNonce: 'nonce-2',
    });
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
    const mismatchedEntry = buildEntry({
      entryId: 'entry-2',
      formNonce: 'nonce-2',
    });

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

  it('blocks nonce author identity mismatches before ledger creation', async () => {
    const { repo } = createRepo();
    const entry = buildEntry();
    await repo.saveFormNonce(buildNonce({ authorId: 't2_other' }));

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
      reason: 'nonce_context_mismatch',
    });
  });

  it('limits deleted-post scrub work and records a continuation', async () => {
    const { repo, store } = createRepo();
    const deletedAtMs = nowMs + 1;
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-1',
        targetId: 't3_post',
        targetKind: 'post',
        targetPostId: 't3_post',
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-2',
        targetId: 't1_comment',
        targetKind: 'comment',
        targetPostId: 't3_post',
      })
    );

    await expect(
      repo.markTargetDeleted({
        targetId: 't3_post',
        targetKind: 'post',
        subredditName: 'testsub',
        deletedAtMs,
        maxEntries: 1,
      })
    ).resolves.toEqual({
      scanned: 1,
      updated: 1,
      remaining: 1,
    });

    await expect(repo.getLedgerEntry('entry-1')).resolves.toMatchObject({
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
    const unsanitizedEntry = await repo.getLedgerEntry('entry-2');
    expect(unsanitizedEntry).toMatchObject({
      targetPermalink: '/r/testsub/comments/target',
    });
    expect(unsanitizedEntry).not.toHaveProperty('targetDeletedAtMs');
    await expect(
      store.get('target_delete_scrub:post:t3_post')
    ).resolves.not.toBeNull();
  });

  it('continues deleted-target scrub from the saved cursor', async () => {
    const { repo, store } = createRepo();
    const deletedAtMs = nowMs + 1;
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-1',
        targetId: 't3_post',
        targetKind: 'post',
        targetPostId: 't3_post',
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-2',
        targetId: 't1_comment',
        targetKind: 'comment',
        targetPostId: 't3_post',
      })
    );
    await repo.markTargetDeleted({
      targetId: 't3_post',
      targetKind: 'post',
      subredditName: 'testsub',
      deletedAtMs,
      maxEntries: 1,
    });

    await expect(
      repo.continueTargetDeletedScrub({
        nowMs,
        maxTargets: 1,
        maxEntriesPerTarget: 1,
      })
    ).resolves.toEqual({
      targets: 1,
      scanned: 1,
      updated: 1,
      remainingTargets: 0,
    });

    await expect(repo.getLedgerEntry('entry-2')).resolves.toMatchObject({
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
    await expect(
      store.get('target_delete_scrub:post:t3_post')
    ).resolves.toBeNull();
    await expect(
      store.zRange('target_delete_scrub:pending', 0, -1)
    ).resolves.toEqual([]);
  });

  it('continues deleted-target scrub without skipping entries when source ranks shift', async () => {
    const { repo, store } = createRepo();
    const deletedAtMs = nowMs + 1;
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-1',
        targetId: 't3_post',
        targetKind: 'post',
        targetPostId: 't3_post',
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-2',
        targetId: 't1_comment_2',
        targetKind: 'comment',
        targetPostId: 't3_post',
        createdAtMs: nowMs + 1,
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-3',
        targetId: 't1_comment_3',
        targetKind: 'comment',
        targetPostId: 't3_post',
        createdAtMs: nowMs + 2,
      })
    );
    await repo.markTargetDeleted({
      targetId: 't3_post',
      targetKind: 'post',
      subredditName: 'testsub',
      deletedAtMs,
      maxEntries: 1,
    });
    await store.zRem('post:t3_post:entries', ['entry-1']);
    await store.del('ledger_entry:entry-1');

    await expect(
      repo.continueTargetDeletedScrub({
        nowMs,
        maxTargets: 1,
        maxEntriesPerTarget: 1,
      })
    ).resolves.toEqual({
      targets: 1,
      scanned: 1,
      updated: 1,
      remainingTargets: 1,
    });

    await expect(repo.getLedgerEntry('entry-2')).resolves.toMatchObject({
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
    const unsanitizedEntry = await repo.getLedgerEntry('entry-3');
    expect(unsanitizedEntry).toMatchObject({
      targetPermalink: '/r/testsub/comments/target',
    });
    expect(unsanitizedEntry).not.toHaveProperty('targetDeletedAtMs');
    await expect(
      store.get('target_delete_scrub:post:t3_post')
    ).resolves.not.toBeNull();
  });

  it('shares target-delete scrub runtime budget across pending targets', async () => {
    const { repo, store } = createRepo();
    const deletedAtMs = nowMs + 1;
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-1',
        targetId: 't3_first',
        targetKind: 'post',
        targetPostId: 't3_first',
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-2',
        targetId: 't3_second',
        targetKind: 'post',
        targetPostId: 't3_second',
      })
    );
    await store.set(
      'target_delete_scrub:post:t3_first',
      JSON.stringify({
        targetId: 't3_first',
        targetKind: 'post',
        subredditName: 'testsub',
        deletedAtMs,
        cursor: 0,
        updatedAtMs: nowMs,
      })
    );
    await store.zAdd('target_delete_scrub:pending', {
      member: 'target_delete_scrub:post:t3_first',
      score: nowMs,
    });
    await store.set(
      'target_delete_scrub:post:t3_second',
      JSON.stringify({
        targetId: 't3_second',
        targetKind: 'post',
        subredditName: 'testsub',
        deletedAtMs,
        cursor: 0,
        updatedAtMs: nowMs + 1,
      })
    );
    await store.zAdd('target_delete_scrub:pending', {
      member: 'target_delete_scrub:post:t3_second',
      score: nowMs + 1,
    });
    const clock = [0, 0, 0, 0, 9, 9, 10];
    const getNowMs = () => clock.shift() ?? 10;

    await expect(
      repo.continueTargetDeletedScrub({
        nowMs,
        maxTargets: 2,
        maxEntriesPerTarget: 1,
        maxRuntimeMs: 10,
        getNowMs,
      })
    ).resolves.toEqual({
      targets: 2,
      scanned: 1,
      updated: 1,
      remainingTargets: 1,
      stoppedEarly: true,
    });

    await expect(repo.getLedgerEntry('entry-1')).resolves.toMatchObject({
      targetPermalink: '',
      targetDeletedAtMs: deletedAtMs,
    });
    const unsanitizedEntry = await repo.getLedgerEntry('entry-2');
    expect(unsanitizedEntry).toMatchObject({
      targetPermalink: '/r/testsub/comments/target',
    });
    expect(unsanitizedEntry).not.toHaveProperty('targetDeletedAtMs');
    await expect(
      store.get('target_delete_scrub:post:t3_second')
    ).resolves.not.toBeNull();
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
          entryId: `other-${index}`,
          userId: 't2_other',
          userKey: 'id:t2_other',
          targetId: `t3_other_${index}`,
          createdAtMs: baseMs + 1000 + index,
        })
      );
    }

    const result = await repo.getUserLedgerPageForKeys(
      ['id:t2_user', 'id:t2_other'],
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

  it('keeps newer enforcement side effects when a stale reversal checkpoint arrives', async () => {
    const { repo, store } = createRepo();
    await seedEntry(
      store,
      buildEntry({
        status: 'partial',
        sideEffects: { ...EMPTY_SIDE_EFFECTS, publicComment: 'failed' },
      })
    );
    await repo.updateLedgerEntrySideEffects(
      buildEntry({
        status: 'succeeded',
        sideEffects: { ...EMPTY_SIDE_EFFECTS, publicComment: 'succeeded' },
        publicCommentId: 't1_comment',
      })
    );

    await repo.updateLedgerEntrySideEffects(
      buildEntry({
        status: 'reversed',
        sideEffects: {
          ...EMPTY_SIDE_EFFECTS,
          publicComment: 'failed',
          reversalModNote: 'succeeded',
        },
        reversalModNoteId: 'mod-note-1',
      })
    );

    const stored = await repo.getLedgerEntry('entry-1');

    expect(stored?.status).toBe('reversed');
    expect(stored?.sideEffects.publicComment).toBe('succeeded');
    expect(stored?.sideEffects.reversalModNote).toBe('succeeded');
    expect(stored?.publicCommentId).toBe('t1_comment');
    expect(stored?.reversalModNoteId).toBe('mod-note-1');
  });

  it('cleans up old inactive ledger entries from all indexes', async () => {
    const { repo, store } = createRepo();
    const old = nowMs - 400 * MS_PER_DAY;
    const recent = nowMs - 10 * MS_PER_DAY;
    const oldInactive = buildEntry({
      entryId: 'old-inactive',
      createdAtMs: old,
    });
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
    await expect(
      store.zRange('user:id:t2_user:ledger', 0, -1)
    ).resolves.toEqual(['recent-active']);
    await expect(
      store.zRange('target:t3_target:entries', 0, -1)
    ).resolves.toEqual(['recent-active']);
    await expect(
      store.zRange('ledger:testsub:entries', 0, -1)
    ).resolves.toEqual(['recent-active']);
  });

  it('keeps old entries that were reversed inside the retention window', async () => {
    const { repo, store } = createRepo();
    const old = nowMs - 400 * MS_PER_DAY;
    await seedEntry(
      store,
      buildEntry({
        entryId: 'recently-reversed',
        status: 'reversed',
        createdAtMs: old,
        reversedAtMs: nowMs - 10 * MS_PER_DAY,
        reversedBy: 'mod-b',
        reversalReason: 'issued in error',
      })
    );

    const result = await repo.cleanupLedger({
      config: DEFAULT_CONFIG,
      maxEntries: 10,
      nowMs,
      retentionDays: 365,
      subredditName: 'testsub',
    });

    expect(result).toEqual({ scanned: 1, deleted: 0 });
    expect(await repo.getLedgerEntry('recently-reversed')).not.toBeNull();
  });

  it('deletes per-user ledger metadata when cleanup removes the last user entry', async () => {
    const { repo, store } = createRepo();
    const old = nowMs - 400 * MS_PER_DAY;
    const oldInactive = buildEntry({
      entryId: 'old-inactive',
      createdAtMs: old,
    });
    await seedEntry(store, oldInactive);
    await store.set('user:id:t2_user:ledger_version', '7');
    await store.set('user:id:t2_user:active_total', '1');

    await repo.cleanupLedger({
      config: DEFAULT_CONFIG,
      maxEntries: 10,
      nowMs,
      retentionDays: 365,
      subredditName: 'testsub',
    });

    await expect(
      store.get('user:id:t2_user:ledger_version')
    ).resolves.toBeNull();
    await expect(store.get('user:id:t2_user:active_total')).resolves.toBeNull();
    await expect(
      store.zRange('user:id:t2_user:ledger', 0, -1)
    ).resolves.toEqual([]);
    await expect(
      store.zRange('target:t3_target:entries', 0, -1)
    ).resolves.toEqual([]);
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

  it('stops ledger cleanup when the runtime budget is exhausted', async () => {
    const { repo, store } = createRepo();
    const old = nowMs - 400 * MS_PER_DAY;
    await seedEntry(
      store,
      buildEntry({
        entryId: 'old-inactive-1',
        targetId: 't3_old_inactive_1',
        createdAtMs: old,
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'old-inactive-2',
        targetId: 't3_old_inactive_2',
        createdAtMs: old + 1,
      })
    );
    const clock = [0, 0, 1_001, 1_001];
    const getNowMs = () => clock.shift() ?? 1_001;

    const result = await repo.cleanupLedger({
      config: DEFAULT_CONFIG,
      getNowMs,
      maxEntries: 10,
      maxRuntimeMs: 1_000,
      nowMs,
      retentionDays: 365,
      subredditName: 'testsub',
    });

    expect(result).toEqual({ scanned: 1, deleted: 1, stoppedEarly: true });
    expect(await repo.getLedgerEntry('old-inactive-1')).toBeNull();
    expect(await repo.getLedgerEntry('old-inactive-2')).not.toBeNull();
  });

  it('advances the cleanup cursor when runtime stops after an undeleted entry', async () => {
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
    const clock = [0, 0, 1_001, 1_001];
    const getNowMs = () => clock.shift() ?? 1_001;

    const result = await repo.cleanupLedger({
      config: DEFAULT_CONFIG,
      getNowMs,
      maxEntries: 10,
      maxRuntimeMs: 1_000,
      nowMs,
      retentionDays: 365,
      subredditName: 'testsub',
    });

    expect(result).toEqual({ scanned: 1, deleted: 0, stoppedEarly: true });
    await expect(store.get('ledger:testsub:cleanup_cursor')).resolves.toBe('1');
    expect(await repo.getLedgerEntry('old-active')).not.toBeNull();
    expect(await repo.getLedgerEntry('old-inactive')).not.toBeNull();
  });

  it('keeps the cleanup cursor on the same rank after deleting scanned entries', async () => {
    const { repo, store } = createRepo();
    const old = nowMs - 400 * MS_PER_DAY;
    await seedEntry(
      store,
      buildEntry({
        entryId: 'old-inactive-1',
        targetId: 't3_old_inactive_1',
        createdAtMs: old,
      })
    );
    await seedEntry(
      store,
      buildEntry({
        entryId: 'old-inactive-2',
        targetId: 't3_old_inactive_2',
        createdAtMs: old + 1,
      })
    );

    const result = await repo.cleanupLedger({
      config: DEFAULT_CONFIG,
      maxEntries: 2,
      nowMs,
      retentionDays: 365,
      subredditName: 'testsub',
    });

    expect(result).toEqual({ scanned: 2, deleted: 2 });
    await expect(store.get('ledger:testsub:cleanup_cursor')).resolves.toBe('0');
    expect(store.transactionWatchKeys).toContainEqual(
      expect.arrayContaining([
        'ledger_entry:old-inactive-1',
        'form_nonce:nonce-1',
        'duplicate:t3_old_inactive_1:warn:rule-general',
        'users:tracked',
        'user:id:t2_user:ledger',
        'post:t3_old_inactive_1:entries',
        'target:t3_old_inactive_1:entries',
        'ledger:testsub:entries',
      ])
    );
  });

  it('reads and recalculates across explicitly provided user keys', async () => {
    const { repo, store } = createRepo();
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-other-user',
        userId: 't2_other',
        userKey: 'id:t2_other',
        username: 'OtherUser',
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
      repo.getUserLedgerPageForKeys(['id:t2_user', 'id:t2_other'], 0, 2)
    ).resolves.toEqual([
      expect.objectContaining({ entryId: 'entry-id' }),
      expect.objectContaining({ entryId: 'entry-other-user' }),
    ]);
    await expect(
      repo.recalculateActiveTotalForKeys(
        ['id:t2_user', 'id:t2_other'],
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

  it('retries active-total recalculation when the ledger changes mid-read', async () => {
    const store = new MutatingLedgerRedisStore();
    const repo = new LedgerRepository(store);
    await seedEntry(
      store,
      buildEntry({
        entryId: 'entry-first',
        targetId: 't3_first',
        originalPoints: 1,
        createdAtMs: nowMs,
      })
    );
    store.mutation = async () => {
      await seedEntry(
        store,
        buildEntry({
          entryId: 'entry-second',
          targetId: 't3_second',
          originalPoints: 2,
          createdAtMs: nowMs + 1,
        })
      );
      await store.set('user:id:t2_user:ledger_version', '1');
    };

    await expect(
      repo.recalculateActiveTotalForKeys(
        ['id:t2_user'],
        'id:t2_user',
        DEFAULT_CONFIG,
        nowMs,
        'testsub'
      )
    ).resolves.toBe(3);
    await expect(repo.getCachedActiveTotal('id:t2_user')).resolves.toBe(3);
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
