import { describe, expect, it } from 'vitest';
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
      error: 'Day value must be from 1 to 3650.',
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
});
