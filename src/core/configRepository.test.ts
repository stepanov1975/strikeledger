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
    expect(store.transactionWatchKeys[0]).toEqual(['config']);
    await expect(
      store.get('settings_audit_snapshot:1767225600000:mod-a')
    ).resolves.not.toBeNull();
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

  it('rejects malformed imported config without throwing', async () => {
    const { repo } = createRepo();

    await expect(
      repo.saveConfig({
        expectedRevision: 1,
        nextConfig: {} as typeof DEFAULT_CONFIG,
        moderatorUsername: 'mod-a',
        timestampMs: nowMs,
      })
    ).resolves.toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([
        { path: 'rules', message: 'Rules must be an array.' },
      ]),
    });
  });

  it('keeps full config snapshots only for the latest twenty saves', async () => {
    const { repo, store } = createRepo();

    for (let index = 0; index < 25; index += 1) {
      const currentConfig = await repo.getConfig();
      await expect(
        repo.saveConfig({
          expectedRevision: currentConfig.revision,
          nextConfig: {
            ...currentConfig,
            actionPoints: {
              ...currentConfig.actionPoints,
              warn: index,
            },
          },
          moderatorUsername: 'mod-a',
          timestampMs: nowMs + index,
        })
      ).resolves.toMatchObject({ status: 'saved' });
    }

    await expect(
      store.zRange('settings_audit_snapshots', 0, -1)
    ).resolves.toHaveLength(20);
    await expect(
      store.get('settings_audit_snapshot:1767225600000:mod-a')
    ).resolves.toBeNull();
    await expect(
      store.get('settings_audit_snapshot:1767225600024:mod-a')
    ).resolves.not.toBeNull();
  });
});
