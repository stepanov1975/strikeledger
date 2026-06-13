import { canonicalJson, sha256Hex } from './canonicalJson';
import {
  DEFAULT_CONFIG,
  validateConfig,
  type ConfigValidationIssue,
} from './config';
import type { StrikeLedgerConfig } from './domain';
import {
  applyNativeSettings,
  toRedisOwnedConfig,
  type NativeSettingsProvider,
  type NativeSettingsValues,
} from './nativeSettings';
import { logError } from './logging';
import type { RedisStore } from './redisStore';

export type SettingsAuditRecord = {
  moderatorUsername: string;
  timestampMs: number;
  changedFields: string[];
  beforeHash: string;
  afterHash: string;
};

export type SettingsAuditSnapshotRecord = {
  auditKey: string;
  beforeConfig: string;
  afterConfig: string;
};

export type SaveConfigRequest = {
  expectedRevision: number;
  nextConfig: StrikeLedgerConfig;
  moderatorUsername: string;
  timestampMs: number;
};

export type SaveConfigResult =
  | { status: 'saved'; config: StrikeLedgerConfig; audit: SettingsAuditRecord }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'invalid'; issues: ConfigValidationIssue[] };

const configKey = 'config';
const settingsAuditKey = (
  timestampMs: number,
  moderatorUsername: string
): string => `settings_audit:${timestampMs}:${moderatorUsername}`;
const settingsAuditSnapshotKey = (
  timestampMs: number,
  moderatorUsername: string
): string => `settings_audit_snapshot:${timestampMs}:${moderatorUsername}`;
const settingsAuditSnapshotIndexKey = 'settings_audit_snapshots';
const SETTINGS_AUDIT_SNAPSHOT_LIMIT = 20;

const parseJson = <T>(raw: string | null): T | null =>
  raw === null ? null : (JSON.parse(raw) as T);

export { canonicalJson, sha256Hex };

const changedTopLevelFields = (
  beforeConfig: StrikeLedgerConfig,
  afterConfig: StrikeLedgerConfig
): string[] => {
  const before = beforeConfig as unknown as Record<string, unknown>;
  const after = afterConfig as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('revision');

  return Array.from(keys)
    .filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]))
    .sort((left, right) => left.localeCompare(right));
};

const validateExistingRuleIds = (
  currentConfig: StrikeLedgerConfig,
  nextConfig: StrikeLedgerConfig
): ConfigValidationIssue[] => {
  if (!Array.isArray(nextConfig.rules)) {
    return [];
  }

  const nextRuleIds = new Set(
    nextConfig.rules
      .map((rule) => rule?.id)
      .filter((id): id is string => typeof id === 'string')
  );

  return currentConfig.rules
    .filter((rule) => !nextRuleIds.has(rule.id))
    .map((rule) => ({
      path: 'rules',
      message: `Existing rule ID "${rule.id}" cannot be removed or changed; disable it instead.`,
    }));
};

export class ConfigRepository {
  constructor(
    private readonly store: RedisStore,
    private readonly nativeSettings?: NativeSettingsProvider
  ) {}

  private async getNativeSettingsValues(): Promise<NativeSettingsValues> {
    if (!this.nativeSettings) {
      return {};
    }

    try {
      return await this.nativeSettings.getAll<NativeSettingsValues>();
    } catch (error) {
      logError('config.native_settings_read_failed', {}, error);
      throw error;
    }
  }

  private async getStoredConfig(): Promise<StrikeLedgerConfig> {
    const storedConfig = parseJson<StrikeLedgerConfig>(
      await this.store.get(configKey)
    );

    if (storedConfig) {
      return storedConfig;
    }

    const defaultStoredConfig = toRedisOwnedConfig(DEFAULT_CONFIG);
    await this.store.set(configKey, JSON.stringify(defaultStoredConfig));
    return defaultStoredConfig;
  }

  async getConfig(): Promise<StrikeLedgerConfig> {
    return applyNativeSettings(
      await this.getStoredConfig(),
      await this.getNativeSettingsValues()
    );
  }

  async saveConfig(request: SaveConfigRequest): Promise<SaveConfigResult> {
    const nativeSettings = await this.getNativeSettingsValues();
    const result = await this.store.runTransaction(
      [configKey],
      async (): Promise<SaveConfigResult> => {
        const currentConfig = toRedisOwnedConfig(
          parseJson<StrikeLedgerConfig>(await this.store.get(configKey)) ??
            DEFAULT_CONFIG
        );
        if (currentConfig.revision !== request.expectedRevision) {
          return {
            status: 'conflict',
            currentRevision: currentConfig.revision,
          };
        }

        const nextConfig = toRedisOwnedConfig({
          ...request.nextConfig,
          revision: currentConfig.revision + 1,
        });
        const effectiveNextConfig = applyNativeSettings(
          nextConfig,
          nativeSettings
        );
        const issues = [
          ...validateConfig(effectiveNextConfig),
          ...validateExistingRuleIds(currentConfig, nextConfig),
        ];
        if (issues.length > 0) {
          return { status: 'invalid', issues };
        }

        const beforeConfig = canonicalJson(currentConfig);
        const afterConfig = canonicalJson(nextConfig);
        const auditKey = settingsAuditKey(
          request.timestampMs,
          request.moderatorUsername
        );
        const snapshotKey = settingsAuditSnapshotKey(
          request.timestampMs,
          request.moderatorUsername
        );
        const audit: SettingsAuditRecord = {
          moderatorUsername: request.moderatorUsername,
          timestampMs: request.timestampMs,
          changedFields: changedTopLevelFields(currentConfig, nextConfig),
          beforeHash: sha256Hex(beforeConfig),
          afterHash: sha256Hex(afterConfig),
        };

        await this.store.set(configKey, JSON.stringify(nextConfig));
        await this.store.set(auditKey, JSON.stringify(audit));
        await this.store.set(
          snapshotKey,
          JSON.stringify({
            auditKey,
            beforeConfig,
            afterConfig,
          } satisfies SettingsAuditSnapshotRecord)
        );
        await this.store.zAdd(settingsAuditSnapshotIndexKey, {
          member: snapshotKey,
          score: request.timestampMs,
        });

        return { status: 'saved', config: effectiveNextConfig, audit };
      }
    );

    if (result.status === 'saved') {
      await this.pruneOldSettingsSnapshots();
    }

    return result;
  }

  async getSettingsAudit(limit = 20): Promise<SettingsAuditRecord[]> {
    const normalizedLimit = Math.max(0, limit);
    if (normalizedLimit === 0) {
      return [];
    }

    const snapshotKeys = await this.store.zRange(
      settingsAuditSnapshotIndexKey,
      0,
      normalizedLimit - 1,
      { reverse: true }
    );
    const records: SettingsAuditRecord[] = [];

    for (const snapshotKey of snapshotKeys) {
      const snapshot = parseJson<SettingsAuditSnapshotRecord>(
        await this.store.get(snapshotKey)
      );
      if (!snapshot) {
        continue;
      }

      const audit = parseJson<SettingsAuditRecord>(
        await this.store.get(snapshot.auditKey)
      );
      if (audit) {
        records.push(audit);
      }
    }

    return records;
  }

  private async pruneOldSettingsSnapshots(): Promise<void> {
    const oldSnapshotKeys = await this.store.zRange(
      settingsAuditSnapshotIndexKey,
      0,
      -(SETTINGS_AUDIT_SNAPSHOT_LIMIT + 1)
    );
    if (oldSnapshotKeys.length === 0) {
      return;
    }

    const keysToDelete = new Set(oldSnapshotKeys);
    for (const snapshotKey of oldSnapshotKeys) {
      const snapshot = parseJson<SettingsAuditSnapshotRecord>(
        await this.store.get(snapshotKey)
      );
      if (snapshot) {
        keysToDelete.add(snapshot.auditKey);
      }
    }

    await this.store.del(...keysToDelete);
    await this.store.zRem(settingsAuditSnapshotIndexKey, oldSnapshotKeys);
  }
}
