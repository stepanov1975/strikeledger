import type { RedisClient, TxClientLike } from '@devvit/redis';
import { describe, expect, it, vi } from 'vitest';
import { DevvitRedisStore } from './devvitRedisStore';

const buildClients = () => {
  const calls: string[] = [];
  const transaction = {
    multi: vi.fn(async () => {
      calls.push('tx.multi');
    }),
    exec: vi.fn(async () => {
      calls.push('tx.exec');
      return [];
    }),
    unwatch: vi.fn(async () => {
      calls.push('tx.unwatch');
      return transaction as unknown as TxClientLike;
    }),
    discard: vi.fn(async () => {
      calls.push('tx.discard');
    }),
    set: vi.fn(async () => {
      calls.push('tx.set');
      return transaction as unknown as TxClientLike;
    }),
    del: vi.fn(async () => {
      calls.push('tx.del');
      return transaction as unknown as TxClientLike;
    }),
    zAdd: vi.fn(async () => {
      calls.push('tx.zAdd');
      return transaction as unknown as TxClientLike;
    }),
  };
  const redis = {
    watch: vi.fn(async () => {
      calls.push('redis.watch');
      return transaction as unknown as TxClientLike;
    }),
    get: vi.fn(async () => {
      calls.push('redis.get');
      return 'value';
    }),
    set: vi.fn(),
    del: vi.fn(),
    zAdd: vi.fn(),
    zRange: vi.fn(async () => []),
  };

  return {
    calls,
    redis: redis as unknown as RedisClient,
    transaction,
  };
};

describe('DevvitRedisStore', () => {
  it('watches keys, reads normally, queues writes, and execs', async () => {
    const { calls, redis, transaction } = buildClients();
    const store = new DevvitRedisStore(redis);

    await expect(
      store.runTransaction(['watched-key'], async () => {
        await store.get('watched-key');
        await store.set('write-key', 'value');
        await store.zAdd('set-key', { member: 'entry-1', score: 1 });
        return 'done';
      })
    ).resolves.toBe('done');

    expect(redis.watch).toHaveBeenCalledWith('watched-key');
    expect(transaction.multi).toHaveBeenCalledTimes(1);
    expect(transaction.exec).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'redis.watch',
      'redis.get',
      'tx.multi',
      'tx.set',
      'tx.zAdd',
      'tx.exec',
    ]);
  });

  it('unwatches transactions with no queued writes', async () => {
    const { calls, redis, transaction } = buildClients();
    const store = new DevvitRedisStore(redis);

    await store.runTransaction(['watched-key'], async () => 'done');

    expect(transaction.multi).not.toHaveBeenCalled();
    expect(transaction.exec).not.toHaveBeenCalled();
    expect(transaction.unwatch).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['redis.watch', 'tx.unwatch']);
  });
});
