import type { RedisClient, TxClientLike } from '@devvit/redis';
import { describe, expect, it, vi } from 'vitest';
import { DevvitRedisStore } from './devvitRedisStore';

const buildClients = () => {
  const calls: string[] = [];
  const defaultExecResults: unknown[] = ['OK', 1, 1];
  const execResultsQueue: unknown[][] = [];
  const transaction = {
    multi: vi.fn(async () => {
      calls.push('tx.multi');
    }),
    exec: vi.fn(async () => {
      calls.push('tx.exec');
      return execResultsQueue.shift() ?? defaultExecResults;
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
    incrBy: vi.fn(async () => {
      calls.push('tx.incrBy');
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
    incrBy: vi.fn(),
    zAdd: vi.fn(),
    zRange: vi.fn(async () => []),
  };

  return {
    calls,
    execResultsQueue,
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
        await store.incrBy('counter-key', 1);
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
      'tx.incrBy',
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

  it('retries when exec does not commit queued commands', async () => {
    const { calls, execResultsQueue, redis, transaction } = buildClients();
    execResultsQueue.push([], ['OK']);
    const store = new DevvitRedisStore(redis);

    await expect(
      store.runTransaction(['watched-key'], async () => {
        await store.set('write-key', 'value');
        return 'done';
      })
    ).resolves.toBe('done');

    expect(transaction.exec).toHaveBeenCalledTimes(2);
    expect(transaction.discard).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'redis.watch',
      'tx.multi',
      'tx.set',
      'tx.exec',
      'redis.watch',
      'tx.multi',
      'tx.set',
      'tx.exec',
    ]);
  });

  it('fails closed after repeated transaction conflicts', async () => {
    const { execResultsQueue, redis, transaction } = buildClients();
    execResultsQueue.push([], [], []);
    const store = new DevvitRedisStore(redis);

    await expect(
      store.runTransaction(['watched-key'], async () => {
        await store.set('write-key', 'value');
        return 'done';
      })
    ).rejects.toThrow(
      'StrikeLedger Redis transaction did not commit after retries.'
    );

    expect(transaction.exec).toHaveBeenCalledTimes(3);
    expect(transaction.discard).not.toHaveBeenCalled();
  });
});
