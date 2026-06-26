import type { TargetKind } from './domain';
import type { RedisStore } from './redisStore';
import {
  trackedUsersKey,
  userViewContextIndexKey,
  viewContextKey,
} from './userIdentityIndexes';

export const DASHBOARD_CONTEXT_TTL_MS = 15 * 60 * 1000;

export type DashboardView = 'history' | 'profile' | 'settings';

export type DashboardPostRecord = {
  postId: string;
  subredditName: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ViewContextRecord = {
  token: string;
  targetId: string;
  targetKind: TargetKind;
  subredditName: string;
  userKey?: string;
  createdAtMs: number;
  expiresAtMs: number;
  authorId?: string;
  authorName?: string;
};

export type DashboardBootstrapRecord = {
  view: DashboardView;
  subredditName: string;
  moderatorUsername: string;
  createdAtMs: number;
  expiresAtMs: number;
  contextToken?: string;
};

const dashboardPostKey = 'dashboard_post_id';
const dashboardBootstrapKey = (
  subredditName: string,
  moderatorUsername: string
): string =>
  `dashboard_bootstrap:${subredditName.toLowerCase()}:${moderatorUsername.toLowerCase()}`;

const parseJson = <T>(raw: string | null): T | null =>
  raw === null ? null : (JSON.parse(raw) as T);

const isExpired = (record: { expiresAtMs?: number }): boolean =>
  record.expiresAtMs !== undefined && record.expiresAtMs <= Date.now();

export const createExpiringTimes = (
  nowMs: number
): Pick<ViewContextRecord, 'createdAtMs' | 'expiresAtMs'> => ({
  createdAtMs: nowMs,
  expiresAtMs: nowMs + DASHBOARD_CONTEXT_TTL_MS,
});

const getViewContextUserKey = (record: ViewContextRecord): string | null => {
  if (record.userKey?.trim()) {
    return record.userKey.trim();
  }

  return record.authorId?.trim() ? `id:${record.authorId.trim()}` : null;
};

const getViewContextAuthorId = (record: ViewContextRecord): string | null =>
  record.authorId?.trim() || null;

export class DashboardRepository {
  constructor(private readonly store: RedisStore) {}

  async saveDashboardPost(record: DashboardPostRecord): Promise<void> {
    await this.store.set(dashboardPostKey, JSON.stringify(record));
  }

  async getDashboardPost(
    subredditName: string
  ): Promise<DashboardPostRecord | null> {
    const record = parseJson<DashboardPostRecord>(
      await this.store.get(dashboardPostKey)
    );

    if (!record) {
      return null;
    }

    return record.subredditName.toLowerCase() === subredditName.toLowerCase()
      ? record
      : null;
  }

  async clearDashboardPost(): Promise<void> {
    await this.store.del(dashboardPostKey);
  }

  async saveViewContext(record: ViewContextRecord): Promise<void> {
    const recordKey = viewContextKey(record.token);
    const userKey = getViewContextUserKey(record);
    const authorId = getViewContextAuthorId(record);
    const indexKey = userKey ? userViewContextIndexKey(userKey) : null;
    const watchedKeys = [
      recordKey,
      ...(indexKey ? [indexKey] : []),
      ...(authorId ? [trackedUsersKey()] : []),
    ];
    await this.store.runTransaction(watchedKeys, async () => {
      await this.store.set(recordKey, JSON.stringify(record), {
        expiresAtMs: record.expiresAtMs,
      });
      if (indexKey) {
        await this.store.zAdd(indexKey, {
          member: record.token,
          score: record.expiresAtMs,
        });
      }

      if (
        authorId &&
        (await this.store.zScore(trackedUsersKey(), authorId)) === null
      ) {
        await this.store.zAdd(trackedUsersKey(), {
          member: authorId,
          score: record.createdAtMs,
        });
      }
    });
  }

  async getViewContext(token: string): Promise<ViewContextRecord | null> {
    const key = viewContextKey(token);
    const record = parseJson<ViewContextRecord>(await this.store.get(key));
    if (!record) {
      return null;
    }

    if (isExpired(record)) {
      await this.store.del(key);
      return null;
    }

    return record;
  }

  async saveDashboardBootstrap(
    record: DashboardBootstrapRecord
  ): Promise<void> {
    await this.store.set(
      dashboardBootstrapKey(record.subredditName, record.moderatorUsername),
      JSON.stringify(record),
      { expiresAtMs: record.expiresAtMs }
    );
  }

  async getDashboardBootstrap(
    subredditName: string,
    moderatorUsername: string
  ): Promise<DashboardBootstrapRecord | null> {
    const key = dashboardBootstrapKey(subredditName, moderatorUsername);
    const record = parseJson<DashboardBootstrapRecord>(await this.store.get(key));
    if (!record) {
      return null;
    }

    if (isExpired(record)) {
      await this.store.del(key);
      return null;
    }

    return record;
  }

  async consumeDashboardBootstrap(
    subredditName: string,
    moderatorUsername: string
  ): Promise<DashboardBootstrapRecord | null> {
    const key = dashboardBootstrapKey(subredditName, moderatorUsername);
    const record = parseJson<DashboardBootstrapRecord>(await this.store.get(key));

    if (record) {
      await this.store.del(key);
    }

    return record && !isExpired(record) ? record : null;
  }
}
