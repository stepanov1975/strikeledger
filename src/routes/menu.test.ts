import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../core/config';

describe('menu helpers', () => {
  it('shows action-specific points in enforcement rule options', async () => {
    vi.resetModules();
    vi.doMock('@devvit/web/server', () => ({
      reddit: {},
      redis: {},
      settings: { getAll: vi.fn(async () => ({})) },
    }));
    const { buildEnforcementFields } = await import('./menu');

    const fields = buildEnforcementFields('nonce-1', 'warn_remove', {
      ...DEFAULT_CONFIG,
      rules: [
        { id: 'rule-general', label: 'Community rule violation', enabled: true },
        {
          id: 'rule-severe',
          label: 'Severe violation',
          enabled: true,
          pointOverrides: { warn_remove: 7 },
        },
      ],
    });

    expect(fields[0]).toMatchObject({
      name: 'ruleId',
      options: [
        { label: 'Community rule violation (+3)', value: 'rule-general' },
        { label: 'Severe violation (+7)', value: 'rule-severe' },
      ],
    });

    const nonceField = fields.find(
      (field) => 'name' in field && field.name === 'formNonce'
    );
    expect(nonceField).toMatchObject({
      name: 'formNonce',
      label: 'Form token',
      type: 'select',
      required: true,
      options: [{ label: 'Current moderation action', value: 'nonce-1' }],
      defaultValue: ['nonce-1'],
    });
  });
});
