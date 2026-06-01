import { describe, expect, it } from 'vitest';
import type { RuleConfig } from '../core/domain';
import type { ImportedRedditRule } from './dashboardTypes';
import { mergeImportedRules, nextAvailableRuleId } from './ruleImport';

const currentRules: RuleConfig[] = [
  {
    id: 'rule-1',
    label: 'Spam',
    enabled: true,
    pointOverrides: { warn_remove: 4 },
  },
  {
    id: 'rule-2',
    label: 'Personal attacks',
    enabled: true,
  },
];

const importedRules: ImportedRedditRule[] = [
  {
    id: 'rule-1',
    label: 'Spam or repetitive content',
    redditShortName: 'Spam or repetitive content',
    description: 'No spam.',
    kind: 'link',
    violationReason: 'SPAM',
    priority: 0,
    enabled: true,
  },
  {
    id: 'rule-2',
    label: 'Personal attacks',
    redditShortName: 'Personal attacks',
    description: 'Be civil.',
    kind: 'all',
    violationReason: 'ABUSE',
    priority: 1,
    enabled: true,
  },
  {
    id: 'rule-3',
    label: 'Off topic',
    redditShortName: 'Off topic',
    description: 'Stay on topic.',
    kind: 'all',
    violationReason: 'CUSTOM',
    priority: 2,
    enabled: true,
  },
];

describe('rule import merging', () => {
  it('allocates the next unused generated rule ID', () => {
    expect(nextAvailableRuleId(new Set(['rule-1', 'rule-2']))).toBe('rule-3');
  });

  it('adds missing imported rules without changing existing rules', () => {
    const merged = mergeImportedRules(
      currentRules,
      importedRules,
      'add-missing'
    );

    expect(merged).toEqual([
      currentRules[0],
      currentRules[1],
      { id: 'rule-3', label: 'Off topic', enabled: true },
    ]);
  });

  it('replaces active rules while preserving matched rule settings', () => {
    const merged = mergeImportedRules(currentRules, importedRules, 'replace');

    expect(merged).toEqual([
      {
        ...currentRules[0],
        label: 'Spam or repetitive content',
        enabled: true,
      },
      { ...currentRules[1], label: 'Personal attacks', enabled: true },
      { id: 'rule-3', label: 'Off topic', enabled: true },
    ]);
  });

  it('syncs matched labels and order without adding unmatched imported rules', () => {
    const merged = mergeImportedRules(
      currentRules,
      importedRules,
      'sync-labels-order'
    );

    expect(merged).toEqual([
      {
        ...currentRules[0],
        label: 'Spam or repetitive content',
      },
      currentRules[1],
    ]);
  });
});
