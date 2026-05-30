import type { RedisClient, SetOptions, TxClientLike } from '@devvit/redis';
import type { RedisSetOptions, RedisStore, ZMember, ZRangeOptions } from './redisStore';

export class DevvitRedisStore implements RedisStore {
  private transactionClient: TxClientLike | null = null;
  private transactionStarted = false;

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
      return;
    }

    await this.redis.del(...keys);
  }

  async zAdd(key: string, member: ZMember): Promise<void> {
    if (this.transactionClient) {
      await this.ensureTransactionStarted();
      await this.transactionClient.zAdd(key, member);
      return;
    }

    await this.redis.zAdd(key, member);
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options: ZRangeOptions = {}
  ): Promise<string[]> {
    const members = await this.redis.zRange(key, start, stop, {
      by: 'rank',
      ...(options.reverse !== undefined ? { reverse: options.reverse } : {}),
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

    const transaction = await this.redis.watch(...watchedKeys);
    this.transactionClient = transaction;
    this.transactionStarted = false;

    try {
      const result = await operation();
      if (this.transactionStarted) {
        await transaction.exec();
      } else {
        await transaction.unwatch();
      }
      return result;
    } catch (error) {
      if (this.transactionStarted) {
        await transaction.discard().catch((discardError: unknown) => {
          console.error('StrikeLedger Redis transaction discard failed', discardError);
        });
      } else {
        await transaction.unwatch().catch((unwatchError: unknown) => {
          console.error('StrikeLedger Redis transaction unwatch failed', unwatchError);
        });
      }
      throw error;
    } finally {
      this.transactionClient = null;
      this.transactionStarted = false;
    }
  }

  private async ensureTransactionStarted(): Promise<void> {
    if (!this.transactionClient || this.transactionStarted) {
      return;
    }

    await this.transactionClient.multi();
    this.transactionStarted = true;
  }
}
