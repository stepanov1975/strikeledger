import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_RULE } from './config';
import { ConfigRepository, canonicalJson, sha256Hex } from './configRepository';
import type { NativeSettingsValues } from './nativeSettings';
import { FakeRedisStore } from './redisStore';

const nowMs = Date.UTC(2026, 0, 1);

const createRepo = (nativeSettings: NativeSettingsValues = {}) => {
  const store = new FakeRedisStore();
  store.nowMs = nowMs;
  return {
    repo: new ConfigRepository(store, {
      getAll: async <T extends object = NativeSettingsValues>() =>
        nativeSettings as T,
    }),
    store,
  };
};

describe('ConfigRepository', () => {
  it('bootstraps default config when Redis is empty', async () => {
    const { repo } = createRepo();

    await expect(repo.getConfig()).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('overlays native install settings onto the stored rule config', async () => {
    const { repo } = createRepo({
      warnPoints: 2,
      decayIntervalDays: 14,
      userNoticesEnabled: false,
    });

    await expect(repo.getConfig()).resolves.toMatchObject({
      revision: 1,
      actionPoints: expect.objectContaining({ warn: 2 }),
      decayIntervalDays: 14,
      userNoticesEnabled: false,
      rules: [DEFAULT_RULE],
    });
  });

  it('fails instead of falling back to defaults when native settings cannot be read', async () => {
    const store = new FakeRedisStore();
    const repo = new ConfigRepository(store, {
      getAll: async () => {
        throw new Error('native settings unavailable');
      },
    });

    await expect(repo.getConfig()).rejects.toThrow(
      'native settings unavailable'
    );
  });

  it('saves valid admin config with a revision bump and audit hashes', async () => {
    const { repo, store } = createRepo();
    const nextConfig = {
      ...DEFAULT_CONFIG,
      rules: [{ ...DEFAULT_RULE, label: 'Updated rule label' }],
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
    expect(result.audit.changedFields).toEqual(['rules']);
    expect(result.audit.beforeHash).toBe(
      sha256Hex(canonicalJson(DEFAULT_CONFIG))
    );
    expect(store.transactionWatchKeys[0]).toEqual(['config']);
    await expect(
      store.get('settings_audit_snapshot:1767225600000:mod-a')
    ).resolves.not.toBeNull();
    await expect(repo.getConfig()).resolves.toMatchObject({
      revision: DEFAULT_CONFIG.revision + 1,
      rules: [expect.objectContaining({ label: 'Updated rule label' })],
    });
    await expect(
      store.get('settings_audit:1767225600000:mod-a')
    ).resolves.not.toBeNull();
  });

  it('ignores native-owned fields submitted through the admin save path', async () => {
    const { repo } = createRepo({ warnPoints: 7 });

    const result = await repo.saveConfig({
      expectedRevision: DEFAULT_CONFIG.revision,
      nextConfig: {
        ...DEFAULT_CONFIG,
        actionPoints: { ...DEFAULT_CONFIG.actionPoints, warn: 99 },
        rules: [{ ...DEFAULT_RULE, label: 'Rules only' }],
      },
      moderatorUsername: 'mod-a',
      timestampMs: nowMs,
    });

    expect(result).toMatchObject({
      status: 'saved',
      config: {
        actionPoints: expect.objectContaining({ warn: 7 }),
        rules: [expect.objectContaining({ label: 'Rules only' })],
      },
    });
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

  it('rejects unsupported imported schema versions', async () => {
    const { repo } = createRepo();

    await expect(
      repo.saveConfig({
        expectedRevision: 1,
        nextConfig: {
          ...DEFAULT_CONFIG,
          schemaVersion: 2 as typeof DEFAULT_CONFIG.schemaVersion,
        },
        moderatorUsername: 'mod-a',
        timestampMs: nowMs,
      })
    ).resolves.toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([
        {
          path: 'schemaVersion',
          message: 'Unsupported config schema version 2.',
        },
      ]),
    });
  });

  it('rejects changes that remove existing rule IDs', async () => {
    const { repo } = createRepo();

    await expect(
      repo.saveConfig({
        expectedRevision: 1,
        nextConfig: {
          ...DEFAULT_CONFIG,
          rules: [
            {
              ...DEFAULT_RULE,
              id: 'rule-renamed',
            },
          ],
        },
        moderatorUsername: 'mod-a',
        timestampMs: nowMs,
      })
    ).resolves.toMatchObject({
      status: 'invalid',
      issues: expect.arrayContaining([
        {
          path: 'rules',
          message:
            'Existing rule ID "rule-general" cannot be removed or changed; disable it instead.',
        },
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
            rules: [{ ...DEFAULT_RULE, label: `Rule ${index}` }],
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
      store.get('settings_audit:1767225600000:mod-a')
    ).resolves.not.toBeNull();
    await expect(
      store.get('settings_audit_snapshot:1767225600024:mod-a')
    ).resolves.not.toBeNull();
    await expect(
      store.get('settings_audit:1767225600024:mod-a')
    ).resolves.not.toBeNull();
  });
});
