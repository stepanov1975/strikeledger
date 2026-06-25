import type { RedisClient, SetOptions, TxClientLike } from '@devvit/redis';
import {
  RedisTransactionConflictError,
  type RedisSetOptions,
  type RedisStore,
  type ZMember,
  type ZRangeOptions,
} from './redisStore';

const MAX_TRANSACTION_ATTEMPTS = 3;

export class DevvitRedisStore implements RedisStore {
  private transactionClient: TxClientLike | null = null;
  private transactionStarted = false;
  private transactionQueuedCommands = 0;

  constructor(private readonly redis: RedisClient) {}

  async get(key: string): Promise<string | null> {
    return (await this.redis.get(key)) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {}
  ): Promise<void> {
    const setOptions = this.toDevvitSetOptions(options);
    if (this.transactionClient) {
      await this.ensureTransactionStarted();
      await this.transactionClient.set(key, value, setOptions);
      this.transactionQueuedCommands += 1;
      return;
    }

    await this.redis.set(key, value, setOptions);
  }

  private toDevvitSetOptions(options: RedisSetOptions): SetOptions {
    return {
      ...(options.expiresAtMs !== undefined
        ? { expiration: new Date(options.expiresAtMs) }
        : {}),
    };
  }

  async del(...keys: string[]): Promise<void> {
    if (this.transactionClient) {
      await this.ensureTransactionStarted();
      await this.transactionClient.del(...keys);
      this.transactionQueuedCommands += 1;
      return;
    }

    await this.redis.del(...keys);
  }

  async incrBy(key: string, value: number): Promise<void> {
    if (this.transactionClient) {
      await this.ensureTransactionStarted();
      await this.transactionClient.incrBy(key, value);
      this.transactionQueuedCommands += 1;
      return;
    }

    await this.redis.incrBy(key, value);
  }

  async zAdd(key: string, member: ZMember): Promise<void> {
    if (this.transactionClient) {
      await this.ensureTransactionStarted();
      await this.transactionClient.zAdd(key, member);
      this.transactionQueuedCommands += 1;
      return;
    }

    await this.redis.zAdd(key, member);
  }

  async zRem(key: string, members: string[]): Promise<void> {
    if (this.transactionClient) {
      await this.ensureTransactionStarted();
      await this.transactionClient.zRem(key, members);
      this.transactionQueuedCommands += 1;
      return;
    }

    await this.redis.zRem(key, members);
  }

  async zScore(key: string, member: string): Promise<number | null> {
    return (await this.redis.zScore(key, member)) ?? null;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options: ZRangeOptions = {}
  ): Promise<string[]> {
    const members = await this.redis.zRange(key, start, stop, {
      by: options.by ?? 'rank',
      ...(options.reverse !== undefined ? { reverse: options.reverse } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    return members.map((member) => member.member);
  }

  async runTransaction<T>(
    watchedKeys: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.transactionClient) {
      return operation();
    }

    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const transaction = await this.redis.watch(...watchedKeys);
      this.transactionClient = transaction;
      this.transactionStarted = false;
      this.transactionQueuedCommands = 0;
      let execCompleted = false;

      try {
        const result = await operation();
        if (this.transactionStarted) {
          const execResults = await transaction.exec();
          execCompleted = true;
          if (!this.transactionCommitted(execResults)) {
            if (attempt < MAX_TRANSACTION_ATTEMPTS) {
              continue;
            }

            throw new RedisTransactionConflictError();
          }
        } else {
          await transaction.unwatch();
        }
        return result;
      } catch (error) {
        await this.cleanupTransaction(transaction, execCompleted);
        throw error;
      } finally {
        this.clearTransactionState();
      }
    }

    throw new RedisTransactionConflictError();
  }

  private async ensureTransactionStarted(): Promise<void> {
    if (!this.transactionClient || this.transactionStarted) {
      return;
    }

    await this.transactionClient.multi();
    this.transactionStarted = true;
  }

  private transactionCommitted(execResults: unknown): boolean {
    return (
      Array.isArray(execResults) &&
      execResults.length === this.transactionQueuedCommands
    );
  }

  private async cleanupTransaction(
    transaction: TxClientLike,
    execCompleted: boolean
  ): Promise<void> {
    if (execCompleted) {
      return;
    }

    if (this.transactionStarted) {
      await transaction.discard().catch((discardError: unknown) => {
        console.error(
          'StrikeLedger Redis transaction discard failed',
          discardError
        );
      });
      return;
    }

    await transaction.unwatch().catch((unwatchError: unknown) => {
      console.error(
        'StrikeLedger Redis transaction unwatch failed',
        unwatchError
      );
    });
  }

  private clearTransactionState(): void {
    this.transactionClient = null;
    this.transactionStarted = false;
    this.transactionQueuedCommands = 0;
  }
}
