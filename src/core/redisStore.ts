export type ZMember = {
  member: string;
  score: number;
};

export type RedisSetOptions = {
  expiresAtMs?: number;
};

export type ZRangeOptions = {
  reverse?: boolean;
  by?: 'rank' | 'score';
  limit?: {
    offset: number;
    count: number;
  };
};

export interface RedisStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<void>;
  del(...keys: string[]): Promise<void>;
  incrBy(key: string, value: number): Promise<void>;
  zAdd(key: string, member: ZMember): Promise<void>;
  zRem(key: string, members: string[]): Promise<void>;
  zScore(key: string, member: string): Promise<number | null>;
  zRange(
    key: string,
    start: number,
    stop: number,
    options?: ZRangeOptions
  ): Promise<string[]>;
  runTransaction<T>(
    watchedKeys: readonly string[],
    operation: () => Promise<T>
  ): Promise<T>;
}

export class RedisTransactionConflictError extends Error {
  constructor() {
    super('StrikeLedger Redis transaction did not commit after retries.');
    this.name = 'RedisTransactionConflictError';
  }
}

export const isRedisTransactionConflictError = (
  error: unknown
): error is RedisTransactionConflictError =>
  error instanceof RedisTransactionConflictError;

export class FakeRedisStore implements RedisStore {
  nowMs = 0;

  private readonly values = new Map<
    string,
    { value: string; expiresAtMs?: number }
  >();

  private readonly sortedSets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    const record = this.values.get(key);
    if (!record) {
      return null;
    }

    if (record.expiresAtMs !== undefined && record.expiresAtMs <= this.nowMs) {
      this.values.delete(key);
      return null;
    }

    return record.value;
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {}
  ): Promise<void> {
    this.values.set(key, { value, ...options });
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.values.delete(key);
      this.sortedSets.delete(key);
    }
  }

  async incrBy(key: string, value: number): Promise<void> {
    const current = Number((await this.get(key)) ?? '0');
    const next = Number.isFinite(current) ? current + value : value;
    await this.set(key, String(next));
  }

  async zAdd(key: string, member: ZMember): Promise<void> {
    const set = this.sortedSets.get(key) ?? new Map<string, number>();
    set.set(member.member, member.score);
    this.sortedSets.set(key, set);
  }

  async zRem(key: string, members: string[]): Promise<void> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return;
    }

    for (const member of members) {
      set.delete(member);
    }
  }

  async zScore(key: string, member: string): Promise<number | null> {
    return this.sortedSets.get(key)?.get(member) ?? null;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options: ZRangeOptions = {}
  ): Promise<string[]> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return [];
    }

    const sortedEntries = Array.from(set.entries())
      .sort(([leftMember, leftScore], [rightMember, rightScore]) => {
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }

        return leftMember.localeCompare(rightMember);
      });
    let rangedEntries =
      options.by === 'score'
        ? sortedEntries.filter(([, score]) => score >= start && score <= stop)
        : sortedEntries;

    if (options.reverse) {
      rangedEntries = [...rangedEntries].reverse();
    }

    if (options.by === 'score' && options.limit) {
      const offset = Math.max(0, options.limit.offset);
      const count = Math.max(0, options.limit.count);
      rangedEntries = rangedEntries.slice(offset, offset + count);
    }

    const members = rangedEntries.map(([member]) => member);

    if (options.by === 'score') {
      return members;
    }

    const normalizedStop = stop < 0 ? members.length + stop : stop;
    if (normalizedStop < start) {
      return [];
    }

    return members.slice(start, normalizedStop + 1);
  }

  readonly transactionWatchKeys: string[][] = [];

  async runTransaction<T>(
    watchedKeys: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    this.transactionWatchKeys.push([...watchedKeys]);
    return operation();
  }
}
