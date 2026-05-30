import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import { ConfigRepository, canonicalJson, sha256Hex } from './configRepository';
import { FakeRedisStore } from './redisStore';

const nowMs = Date.UTC(2026, 0, 1);

const createRepo = () => {
  const store = new FakeRedisStore();
  store.nowMs = nowMs;
  return { repo: new ConfigRepository(store), store };
};

describe('ConfigRepository', () => {
  it('bootstraps default config when Redis is empty', async () => {
    const { repo } = createRepo();

    await expect(repo.getConfig()).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('saves valid config with a revision bump and audit hashes', async () => {
    const { repo, store } = createRepo();
    const nextConfig = {
      ...DEFAULT_CONFIG,
      actionPoints: { ...DEFAULT_CONFIG.actionPoints, warn: 2 },
    };

    const result = await repo.saveConfig({
      expectedRevision: DEFAULT_CONFIG.revision,
      nextConfig,
      moderatorUsername: 'mod-a',
      timestampMs: nowMs,
    });

    expect(result.status).toBe('saved');
    if (result.status !== 'saved') {
      return;
    }

    expect(result.config.revision).toBe(DEFAULT_CONFIG.revision + 1);
    expect(result.audit.changedFields).toEqual(['actionPoints']);
    expect(result.audit.beforeHash).toBe(sha256Hex(canonicalJson(DEFAULT_CONFIG)));
    await expect(repo.getConfig()).resolves.toMatchObject({
      revision: DEFAULT_CONFIG.revision + 1,
      actionPoints: expect.objectContaining({ warn: 2 }),
    });
    await expect(store.get('settings_audit:1767225600000:mod-a')).resolves.not.toBeNull();
  });

  it('rejects stale revisions and invalid config', async () => {
    const { repo } = createRepo();

    await expect(
      repo.saveConfig({
        expectedRevision: 0,
        nextConfig: DEFAULT_CONFIG,
        moderatorUsername: 'mod-a',
        timestampMs: nowMs,
      })
    ).resolves.toEqual({ status: 'conflict', currentRevision: 1 });

    await expect(
      repo.saveConfig({
        expectedRevision: 1,
        nextConfig: {
          ...DEFAULT_CONFIG,
          rules: [],
        },
        moderatorUsername: 'mod-a',
        timestampMs: nowMs,
      })
    ).resolves.toMatchObject({ status: 'invalid' });
  });
});
