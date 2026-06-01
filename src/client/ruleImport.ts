import type { RuleConfig } from '../core/domain';
import type { ImportedRedditRule, RuleImportMode } from './dashboardTypes';

const normalizeRuleMatchValue = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

const importedRuleToConfig = (rule: ImportedRedditRule): RuleConfig => ({
  id: rule.id,
  label: rule.label,
  enabled: true,
});

export const buildUsedRuleIds = (rules: RuleConfig[]): Set<string> =>
  new Set(rules.map((rule) => rule.id));

export const nextAvailableRuleId = (usedIds: Set<string>): string => {
  let index = 1;
  while (usedIds.has(`rule-${index}`)) {
    index += 1;
  }

  const id = `rule-${index}`;
  usedIds.add(id);
  return id;
};

const withAvailableRuleId = (
  rule: RuleConfig,
  usedIds: Set<string>
): RuleConfig => {
  if (!usedIds.has(rule.id)) {
    usedIds.add(rule.id);
    return rule;
  }

  return {
    ...rule,
    id: nextAvailableRuleId(usedIds),
  };
};

export const mergeImportedRules = (
  currentRules: RuleConfig[],
  importedRules: ImportedRedditRule[],
  mode: RuleImportMode
): RuleConfig[] => {
  const importedConfigs = importedRules.map(importedRuleToConfig);
  const currentById = new Map(
    currentRules.map((rule) => [normalizeRuleMatchValue(rule.id), rule])
  );
  const currentByLabel = new Map(
    currentRules.map((rule) => [normalizeRuleMatchValue(rule.label), rule])
  );

  if (mode === 'replace') {
    const usedIds = buildUsedRuleIds(currentRules);
    const matched = new Set<RuleConfig>();
    const replacementRules = importedConfigs.map((importedRule) => {
      const existing =
        currentById.get(normalizeRuleMatchValue(importedRule.id)) ??
        currentByLabel.get(normalizeRuleMatchValue(importedRule.label));
      if (!existing) {
        return withAvailableRuleId(importedRule, usedIds);
      }

      matched.add(existing);
      return { ...existing, label: importedRule.label, enabled: true };
    });
    const disabledCurrentRules = currentRules
      .filter((rule) => !matched.has(rule))
      .map((rule) => ({ ...rule, enabled: false }));

    return [...replacementRules, ...disabledCurrentRules];
  }

  if (mode === 'sync-labels-order') {
    const matched = new Set<RuleConfig>();
    const synced = importedConfigs.flatMap((importedRule) => {
      const existing =
        currentById.get(normalizeRuleMatchValue(importedRule.id)) ??
        currentByLabel.get(normalizeRuleMatchValue(importedRule.label));
      if (!existing) {
        return [];
      }

      matched.add(existing);
      return [{ ...existing, label: importedRule.label }];
    });

    return [...synced, ...currentRules.filter((rule) => !matched.has(rule))];
  }

  const usedIds = buildUsedRuleIds(currentRules);
  const newRules = importedConfigs
    .filter(
      (rule) =>
        !currentById.has(normalizeRuleMatchValue(rule.id)) &&
        !currentByLabel.has(normalizeRuleMatchValue(rule.label))
    )
    .map((rule) => withAvailableRuleId(rule, usedIds));

  return [...currentRules, ...newRules];
};
