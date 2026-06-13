import {
  DEFAULT_CONFIG,
  DEFAULT_NATIVE_MOD_NOTE_TEMPLATE,
  DEFAULT_PRIVATE_USER_NOTICE_TEMPLATE,
  DEFAULT_PUBLIC_COMMENT_TEMPLATE,
  DEFAULT_ZERO_POINT_NATIVE_MOD_NOTE_TEMPLATE,
  DEFAULT_ZERO_POINT_PRIVATE_USER_NOTICE_TEMPLATE,
} from './config';
import type { StrikeLedgerConfig } from './domain';
import {
  PRIVATE_PLACEHOLDERS,
  PUBLIC_PLACEHOLDERS,
  validateTemplatePlaceholders,
} from './templates';

export type NativeSettingValue =
  | string
  | string[]
  | boolean
  | number
  | undefined;

export type NativeSettingsValues = Record<string, NativeSettingValue>;

export type NativeSettingsProvider = {
  getAll<T extends object = NativeSettingsValues>(): Promise<T>;
};

export const NATIVE_SETTINGS_KEYS = {
  warnPoints: 'warnPoints',
  warnRemovePoints: 'warnRemovePoints',
  warnNsfwPoints: 'warnNsfwPoints',
  decayAmount: 'decayAmount',
  decayIntervalDays: 'decayIntervalDays',
  defaultPublicCommentTemplate: 'defaultPublicCommentTemplate',
  defaultPrivateUserNoticeTemplate: 'defaultPrivateUserNoticeTemplate',
  defaultZeroPointPrivateUserNoticeTemplate:
    'defaultZeroPointPrivateUserNoticeTemplate',
  defaultNativeModNoteTemplate: 'defaultNativeModNoteTemplate',
  defaultZeroPointNativeModNoteTemplate:
    'defaultZeroPointNativeModNoteTemplate',
  userNoticesEnabled: 'userNoticesEnabled',
  distinguishAppComments: 'distinguishAppComments',
  stickyCommentsWarn: 'stickyCommentsWarn',
  stickyCommentsWarnRemove: 'stickyCommentsWarnRemove',
  stickyCommentsWarnNsfw: 'stickyCommentsWarnNsfw',
  lockAppComments: 'lockAppComments',
  nativeModNotesEnabled: 'nativeModNotesEnabled',
  reversalNativeModNotesEnabled: 'reversalNativeModNotesEnabled',
} as const;

const MAX_TEMPLATE_LENGTH = 2000;

const integerSetting = (
  values: NativeSettingsValues,
  key: string,
  fallback: number,
  min: number,
  max: number
): number => {
  const value = values[key];
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
};

const booleanSetting = (
  values: NativeSettingsValues,
  key: string,
  fallback: boolean
): boolean => {
  const value = values[key];
  return typeof value === 'boolean' ? value : fallback;
};

const templateSetting = (
  values: NativeSettingsValues,
  key: string,
  fallback: string,
  allowedPlaceholders: readonly string[]
): string => {
  const value = values[key];
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_TEMPLATE_LENGTH ||
    validateTemplatePlaceholders(key, value, allowedPlaceholders).length > 0
  ) {
    return fallback;
  }

  return value;
};

export const applyNativeSettings = (
  config: StrikeLedgerConfig,
  values: NativeSettingsValues
): StrikeLedgerConfig => ({
  ...config,
  actionPoints: {
    warn: integerSetting(
      values,
      NATIVE_SETTINGS_KEYS.warnPoints,
      DEFAULT_CONFIG.actionPoints.warn,
      0,
      100
    ),
    warn_remove: integerSetting(
      values,
      NATIVE_SETTINGS_KEYS.warnRemovePoints,
      DEFAULT_CONFIG.actionPoints.warn_remove,
      0,
      100
    ),
    warn_nsfw: integerSetting(
      values,
      NATIVE_SETTINGS_KEYS.warnNsfwPoints,
      DEFAULT_CONFIG.actionPoints.warn_nsfw,
      0,
      100
    ),
  },
  decayAmount: integerSetting(
    values,
    NATIVE_SETTINGS_KEYS.decayAmount,
    DEFAULT_CONFIG.decayAmount,
    1,
    100
  ),
  decayIntervalDays: integerSetting(
    values,
    NATIVE_SETTINGS_KEYS.decayIntervalDays,
    DEFAULT_CONFIG.decayIntervalDays,
    1,
    3650
  ),
  defaultPublicCommentTemplate: templateSetting(
    values,
    NATIVE_SETTINGS_KEYS.defaultPublicCommentTemplate,
    DEFAULT_PUBLIC_COMMENT_TEMPLATE,
    PUBLIC_PLACEHOLDERS
  ),
  defaultPrivateUserNoticeTemplate: templateSetting(
    values,
    NATIVE_SETTINGS_KEYS.defaultPrivateUserNoticeTemplate,
    DEFAULT_PRIVATE_USER_NOTICE_TEMPLATE,
    PRIVATE_PLACEHOLDERS
  ),
  defaultZeroPointPrivateUserNoticeTemplate: templateSetting(
    values,
    NATIVE_SETTINGS_KEYS.defaultZeroPointPrivateUserNoticeTemplate,
    DEFAULT_ZERO_POINT_PRIVATE_USER_NOTICE_TEMPLATE,
    PRIVATE_PLACEHOLDERS
  ),
  defaultNativeModNoteTemplate: templateSetting(
    values,
    NATIVE_SETTINGS_KEYS.defaultNativeModNoteTemplate,
    DEFAULT_NATIVE_MOD_NOTE_TEMPLATE,
    PRIVATE_PLACEHOLDERS
  ),
  defaultZeroPointNativeModNoteTemplate: templateSetting(
    values,
    NATIVE_SETTINGS_KEYS.defaultZeroPointNativeModNoteTemplate,
    DEFAULT_ZERO_POINT_NATIVE_MOD_NOTE_TEMPLATE,
    PRIVATE_PLACEHOLDERS
  ),
  userNoticesEnabled: booleanSetting(
    values,
    NATIVE_SETTINGS_KEYS.userNoticesEnabled,
    DEFAULT_CONFIG.userNoticesEnabled
  ),
  distinguishAppComments: booleanSetting(
    values,
    NATIVE_SETTINGS_KEYS.distinguishAppComments,
    DEFAULT_CONFIG.distinguishAppComments
  ),
  stickyAppComments: {
    warn: booleanSetting(
      values,
      NATIVE_SETTINGS_KEYS.stickyCommentsWarn,
      DEFAULT_CONFIG.stickyAppComments.warn
    ),
    warn_remove: booleanSetting(
      values,
      NATIVE_SETTINGS_KEYS.stickyCommentsWarnRemove,
      DEFAULT_CONFIG.stickyAppComments.warn_remove
    ),
    warn_nsfw: booleanSetting(
      values,
      NATIVE_SETTINGS_KEYS.stickyCommentsWarnNsfw,
      DEFAULT_CONFIG.stickyAppComments.warn_nsfw
    ),
  },
  lockAppComments: booleanSetting(
    values,
    NATIVE_SETTINGS_KEYS.lockAppComments,
    DEFAULT_CONFIG.lockAppComments
  ),
  nativeModNotesEnabled: booleanSetting(
    values,
    NATIVE_SETTINGS_KEYS.nativeModNotesEnabled,
    DEFAULT_CONFIG.nativeModNotesEnabled
  ),
  reversalNativeModNotesEnabled: booleanSetting(
    values,
    NATIVE_SETTINGS_KEYS.reversalNativeModNotesEnabled,
    DEFAULT_CONFIG.reversalNativeModNotesEnabled
  ),
});

export const toRedisOwnedConfig = (
  config: StrikeLedgerConfig
): StrikeLedgerConfig => ({
  ...DEFAULT_CONFIG,
  schemaVersion: config.schemaVersion,
  revision: config.revision,
  rules: config.rules,
});
