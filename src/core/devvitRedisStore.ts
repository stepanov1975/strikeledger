import type { RedisClient } from '@devvit/redis';
import type { RedisSetOptions, RedisStore, ZMember, ZRangeOptions } from './redisStore';

export class DevvitRedisStore implements RedisStore {
  constructor(private readonly redis: RedisClient) {}

  async get(key: string): Promise<string | null> {
    return (await this.redis.get(key)) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {}
  ): Promise<void> {
    await this.redis.set(key, value, {
      ...(options.expiresAtMs !== undefined
        ? { expiration: new Date(options.expiresAtMs) }
        : {}),
    });
  }

  async del(...keys: string[]): Promise<void> {
    await this.redis.del(...keys);
  }

  async zAdd(key: string, member: ZMember): Promise<void> {
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

  async runTransaction<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
