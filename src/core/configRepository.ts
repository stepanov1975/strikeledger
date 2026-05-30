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

const parseJson = <T>(raw: string | null): T | null =>
  raw === null ? null : (JSON.parse(raw) as T);

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
      return storedConfig;
    }

    await this.store.set(configKey, JSON.stringify(DEFAULT_CONFIG));
    return DEFAULT_CONFIG;
  }

  async saveConfig(request: SaveConfigRequest): Promise<SaveConfigResult> {
    return this.store.runTransaction([configKey], async () => {
      const currentConfig =
        parseJson<StrikeLedgerConfig>(await this.store.get(configKey)) ??
        DEFAULT_CONFIG;
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
      const audit: SettingsAuditRecord = {
        moderatorUsername: request.moderatorUsername,
        timestampMs: request.timestampMs,
        changedFields: changedTopLevelFields(currentConfig, nextConfig),
        beforeHash: sha256Hex(beforeConfig),
        afterHash: sha256Hex(afterConfig),
      };

      await this.store.set(configKey, JSON.stringify(nextConfig));
      await this.store.set(
        settingsAuditKey(request.timestampMs, request.moderatorUsername),
        JSON.stringify(audit)
      );

      return { status: 'saved', config: nextConfig, audit };
    });
  }
}
