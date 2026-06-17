import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_NATIVE_MOD_NOTE_TEMPLATE,
  DEFAULT_PRIVATE_USER_NOTICE_TEMPLATE,
  DEFAULT_PUBLIC_COMMENT_TEMPLATE,
  DEFAULT_ZERO_POINT_NATIVE_MOD_NOTE_TEMPLATE,
  DEFAULT_ZERO_POINT_PRIVATE_USER_NOTICE_TEMPLATE,
} from '../core/config';
import { settingsValidators } from './settingsValidators';

describe('settings validators', () => {
  it('accepts valid integer settings', async () => {
    const response = await settingsValidators.request('/validate-points', {
      method: 'POST',
      body: JSON.stringify({ value: 3, isEditing: true }),
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it('rejects out-of-range integer settings', async () => {
    const response = await settingsValidators.request('/validate-days', {
      method: 'POST',
      body: JSON.stringify({ value: 0, isEditing: true }),
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Day value must be from 1 to 36.',
    });
  });

  it('rejects decay intervals that can exceed the maximum active lifetime', async () => {
    const response = await settingsValidators.request('/validate-days', {
      method: 'POST',
      body: JSON.stringify({ value: 37, isEditing: true }),
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Day value must be from 1 to 36.',
    });
  });

  it('rejects zero decay amount', async () => {
    const response = await settingsValidators.request(
      '/validate-decay-amount',
      {
        method: 'POST',
        body: JSON.stringify({ value: 0, isEditing: true }),
        headers: { 'Content-Type': 'application/json' },
      }
    );

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Decay amount must be from 1 to 100.',
    });
  });

  it('rejects private placeholders in public templates', async () => {
    const response = await settingsValidators.request(
      '/validate-public-template',
      {
        method: 'POST',
        body: JSON.stringify({ value: 'Total {activeTotal}' }),
        headers: { 'Content-Type': 'application/json' },
      }
    );

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Unsupported placeholder {activeTotal}.',
    });
  });

  it('rejects templates larger than the native setting byte limit', async () => {
    const response = await settingsValidators.request(
      '/validate-public-template',
      {
        method: 'POST',
        body: JSON.stringify({ value: 'é'.repeat(1025) }),
        headers: { 'Content-Type': 'application/json' },
      }
    );

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Template must be 2048 bytes or fewer.',
    });
  });

  it('documents boolean native settings for new moderators', () => {
    const config = JSON.parse(readFileSync('devvit.json', 'utf8')) as {
      settings?: {
        subreddit?: Record<
          string,
          { type?: string; label?: string; helpText?: string }
        >;
      };
    };
    const booleanSettings = Object.entries(config.settings?.subreddit ?? {})
      .filter(([, setting]) => setting.type === 'boolean')
      .map(([name, setting]) => ({ name, ...setting }));

    expect(booleanSettings).not.toHaveLength(0);
    for (const setting of booleanSettings) {
      expect(setting.label?.trim(), setting.name).toBeTruthy();
      expect(setting.helpText?.trim(), setting.name).toBeTruthy();
    }
  });

  it('keeps Devvit native template defaults aligned with runtime defaults', () => {
    const config = JSON.parse(readFileSync('devvit.json', 'utf8')) as {
      settings?: {
        subreddit?: Record<
          string,
          { defaultValue?: unknown; helpText?: string }
        >;
      };
    };
    const settings = config.settings?.subreddit ?? {};

    expect(settings.defaultPublicCommentTemplate?.defaultValue).toBe(
      DEFAULT_PUBLIC_COMMENT_TEMPLATE
    );
    expect(settings.defaultPublicCommentTemplate?.helpText).toContain(
      '{actionEffect}'
    );
    expect(settings.defaultPrivateUserNoticeTemplate?.defaultValue).toBe(
      DEFAULT_PRIVATE_USER_NOTICE_TEMPLATE
    );
    expect(settings.defaultPrivateUserNoticeTemplate?.helpText).toContain(
      '{actionOutcome}'
    );
    expect(
      settings.defaultZeroPointPrivateUserNoticeTemplate?.defaultValue
    ).toBe(DEFAULT_ZERO_POINT_PRIVATE_USER_NOTICE_TEMPLATE);
    expect(settings.defaultNativeModNoteTemplate?.defaultValue).toBe(
      DEFAULT_NATIVE_MOD_NOTE_TEMPLATE
    );
    expect(settings.defaultZeroPointNativeModNoteTemplate?.defaultValue).toBe(
      DEFAULT_ZERO_POINT_NATIVE_MOD_NOTE_TEMPLATE
    );
  });

  it('checks that Devvit native settings are generated from TypeScript defaults', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ['scripts/sync-devvit-settings.mjs', '--check'],
        {
          stdio: 'pipe',
        }
      )
    ).not.toThrow();
  });
});
