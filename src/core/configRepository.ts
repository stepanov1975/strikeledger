import { createHash } from 'node:crypto';
import {
  DEFAULT_CONFIG,
  validateConfig,
  type ConfigValidationIssue,
} from './config';
import type { StrikeLedgerConfig } from './domain';
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

const applyConfigDefaults = (config: StrikeLedgerConfig): StrikeLedgerConfig => ({
  ...config,
  postScoreWindowDays:
    typeof config.postScoreWindowDays === 'number'
      ? config.postScoreWindowDays
      : DEFAULT_CONFIG.postScoreWindowDays,
});

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, canonicalize(entryValue)])
    );
  }

  return value;
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

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

export class ConfigRepository {
  constructor(private readonly store: RedisStore) {}

  async getConfig(): Promise<StrikeLedgerConfig> {
    const storedConfig = parseJson<StrikeLedgerConfig>(
      await this.store.get(configKey)
    );

    if (storedConfig) {
      return applyConfigDefaults(storedConfig);
    }

    await this.store.set(configKey, JSON.stringify(DEFAULT_CONFIG));
    return DEFAULT_CONFIG;
  }

  async saveConfig(request: SaveConfigRequest): Promise<SaveConfigResult> {
    const result = await this.store.runTransaction(
      [configKey],
      async (): Promise<SaveConfigResult> => {
      const currentConfig = applyConfigDefaults(
        parseJson<StrikeLedgerConfig>(await this.store.get(configKey)) ??
          DEFAULT_CONFIG
      );
      if (currentConfig.revision !== request.expectedRevision) {
        return {
          status: 'conflict',
          currentRevision: currentConfig.revision,
        };
      }

      const nextConfig: StrikeLedgerConfig = {
        ...request.nextConfig,
        schemaVersion: DEFAULT_CONFIG.schemaVersion,
        revision: currentConfig.revision + 1,
      };
      const issues = validateConfig(nextConfig);
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

      return { status: 'saved', config: nextConfig, audit };
      }
    );

    if (result.status === 'saved') {
      await this.pruneOldSettingsSnapshots();
    }

    return result;
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

    await this.store.del(...oldSnapshotKeys);
    await this.store.zRem(settingsAuditSnapshotIndexKey, oldSnapshotKeys);
  }
}
