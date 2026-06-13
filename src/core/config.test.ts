import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_RULE,
  getRulePoints,
  validateConfig,
} from './config';
import type { StrikeLedgerConfig } from './domain';

const cloneConfig = (): StrikeLedgerConfig => structuredClone(DEFAULT_CONFIG);

describe('config validation', () => {
  it('accepts the default MVP config', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });

  it('requires at least one enabled rule', () => {
    const config = cloneConfig();
    config.rules = [{ ...DEFAULT_RULE, enabled: false }];

    expect(validateConfig(config)).toContainEqual({
      path: 'rules',
      message: 'At least one enabled rule is required.',
    });
  });

  it('validates rule IDs and labels', () => {
    const config = cloneConfig();
    config.rules = [{ id: 'Rule 1', label: '', enabled: true }];

    expect(validateConfig(config)).toEqual(
      expect.arrayContaining([
        {
          path: 'rules.0.id',
          message:
            'Rule ID must contain only lowercase letters, numbers, and hyphens.',
        },
        {
          path: 'rules.0.label',
          message: 'Rule label is required and must be 120 characters or fewer.',
        },
      ])
    );
  });

  it('rejects duplicate rule IDs', () => {
    const config = cloneConfig();
    config.rules = [
      DEFAULT_RULE,
      { ...DEFAULT_RULE, label: 'Duplicate rule label' },
    ];

    expect(validateConfig(config)).toContainEqual({
      path: 'rules.1.id',
      message: 'Rule ID must be unique.',
    });
  });

  it('rejects invalid point and decay values', () => {
    const config = cloneConfig();
    config.actionPoints.warn_remove = 101;
    config.decayAmount = 0;
    config.decayIntervalDays = 0;

    expect(validateConfig(config)).toEqual(
      expect.arrayContaining([
        {
          path: 'actionPoints.warn_remove',
          message: 'Point value must be an integer from 0 to 100.',
        },
        {
          path: 'decayAmount',
          message: 'Decay amount must be an integer from 1 to 100.',
        },
        {
          path: 'decayIntervalDays',
          message: 'Decay interval must be an integer from 1 to 3650 days.',
        },
      ])
    );
  });

  it('reports malformed imported config objects instead of throwing', () => {
    expect(validateConfig({})).toEqual(
      expect.arrayContaining([
        { path: 'rules', message: 'Rules must be an array.' },
        { path: 'actionPoints', message: 'Action points must be an object.' },
        { path: 'userNoticesEnabled', message: 'Value must be true or false.' },
      ])
    );
  });

  it('rejects private placeholders in the default public template', () => {
    const config = cloneConfig();
    config.defaultPublicCommentTemplate =
      'Violation {ruleLabel}; points {pointsAdded}.';

    expect(validateConfig(config)).toContainEqual({
      path: 'defaultPublicCommentTemplate',
      message: 'Unsupported placeholder {pointsAdded}.',
    });
  });

  it('uses rule point overrides before action defaults', () => {
    const config = cloneConfig();
    const rule = {
      ...DEFAULT_RULE,
      pointOverrides: { warn_remove: 7 },
    };

    expect(getRulePoints(config, rule, 'warn_remove')).toBe(7);
    expect(getRulePoints(config, rule, 'warn')).toBe(1);
  });
});
