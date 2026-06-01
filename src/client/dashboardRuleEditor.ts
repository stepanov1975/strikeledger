import {
  ACTION_LABELS,
  STRIKE_ACTIONS,
  type RuleConfig,
  type StrikeAction,
  type StrikeLedgerConfig,
} from '../core/domain';
import type { RuleEditorOptions } from './dashboardTypes';
import {
  create,
  numberField,
  textField,
  textareaField,
  toggleField,
} from './dashboardUi';

const getRuleInput = (row: HTMLElement, field: string): HTMLInputElement => {
  const input = row.querySelector<HTMLInputElement>(
    `[data-rule-field="${field}"]`
  );
  if (!input) {
    throw new Error(`Missing rule field: ${field}.`);
  }

  return input;
};

const getRuleTextarea = (
  row: HTMLElement,
  field: string
): HTMLTextAreaElement => {
  const textarea = row.querySelector<HTMLTextAreaElement>(
    `[data-rule-field="${field}"]`
  );
  if (!textarea) {
    throw new Error(`Missing rule field: ${field}.`);
  }

  return textarea;
};

export const updateRuleControls = (rulesList: HTMLElement) => {
  const rows = Array.from(
    rulesList.querySelectorAll<HTMLElement>('[data-rule-row]')
  );
  rows.forEach((row, index) => {
    row
      .querySelector<HTMLButtonElement>('.rule-move-up')
      ?.toggleAttribute('disabled', index === 0);
    row
      .querySelector<HTMLButtonElement>('.rule-move-down')
      ?.toggleAttribute('disabled', index === rows.length - 1);
    row
      .querySelector<HTMLButtonElement>('.rule-remove')
      ?.toggleAttribute('disabled', rows.length <= 1);
  });
};

export const createRuleEditor = (
  rule: RuleConfig,
  config: StrikeLedgerConfig,
  rulesList: HTMLElement,
  options: RuleEditorOptions
): HTMLElement => {
  const item = create('article', 'rule-editor');
  item.dataset.ruleRow = 'true';

  const header = create('div', 'rule-editor-header');
  header.append(create('h4', 'rule-title', rule.label || 'New rule'));
  const ruleActions = create('div', 'rule-actions');
  const moveUp = create('button', 'secondary-button rule-move-up', 'Up');
  moveUp.type = 'button';
  moveUp.addEventListener('click', () => {
    const previous = item.previousElementSibling;
    if (previous) {
      rulesList.insertBefore(item, previous);
      updateRuleControls(rulesList);
    }
  });
  const moveDown = create('button', 'secondary-button rule-move-down', 'Down');
  moveDown.type = 'button';
  moveDown.addEventListener('click', () => {
    const next = item.nextElementSibling;
    if (next) {
      rulesList.insertBefore(next, item);
      updateRuleControls(rulesList);
    }
  });
  ruleActions.append(moveUp, moveDown);
  if (!options.isExisting) {
    const remove = create('button', 'secondary-button rule-remove', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      item.remove();
      updateRuleControls(rulesList);
    });
    ruleActions.append(remove);
  }
  header.append(ruleActions);

  const fields = create('div', 'settings-grid');
  const id = textField('Rule ID', '', rule.id, {
    required: true,
    pattern: '[a-z0-9-]+',
  });
  const idInput = id.querySelector('input');
  idInput?.setAttribute('data-rule-field', 'id');
  if (idInput && options.isExisting) {
    idInput.disabled = true;
  }

  const label = textField('Label', '', rule.label, {
    required: true,
    maxLength: 120,
  });
  const labelInput = label.querySelector('input');
  labelInput?.setAttribute('data-rule-field', 'label');

  const enabled = toggleField('Enabled', '', rule.enabled);
  const enabledInput = enabled.querySelector('input');
  enabledInput?.setAttribute('data-rule-field', 'enabled');

  fields.append(id, label, enabled);

  const pointFields = create('div', 'settings-grid');
  for (const action of STRIKE_ACTIONS) {
    const field = numberField(
      `${ACTION_LABELS[action]} override`,
      '',
      rule.pointOverrides?.[action],
      {
        min: 0,
        max: 100,
        placeholder: `Default ${config.actionPoints[action]}`,
      }
    );
    field
      .querySelector('input')
      ?.setAttribute('data-rule-field', `point-${action}`);
    pointFields.append(field);
  }

  const templateFields = create('div', 'template-grid');
  const publicTemplate = textareaField(
    'Public comment template',
    '',
    rule.publicTemplate,
    false
  );
  publicTemplate
    .querySelector('textarea')
    ?.setAttribute('data-rule-field', 'publicTemplate');
  const internalTemplate = textareaField(
    'Native mod note template',
    '',
    rule.internalNoteTemplate,
    false
  );
  internalTemplate
    .querySelector('textarea')
    ?.setAttribute('data-rule-field', 'internalNoteTemplate');
  templateFields.append(publicTemplate, internalTemplate);

  item.append(
    header,
    fields,
    create('p', 'settings-subhead', 'Point overrides'),
    pointFields,
    create('p', 'settings-subhead', 'Rule templates'),
    templateFields
  );
  return item;
};

export const collectRule = (row: HTMLElement): RuleConfig => {
  const pointOverrides: Partial<Record<StrikeAction, number>> = {};
  for (const action of STRIKE_ACTIONS) {
    const rawValue = getRuleInput(row, `point-${action}`).value.trim();
    if (rawValue) {
      pointOverrides[action] = Number(rawValue);
    }
  }

  const publicTemplate = getRuleTextarea(row, 'publicTemplate').value;
  const internalNoteTemplate = getRuleTextarea(
    row,
    'internalNoteTemplate'
  ).value;

  return {
    id: getRuleInput(row, 'id').value.trim(),
    label: getRuleInput(row, 'label').value.trim(),
    enabled: getRuleInput(row, 'enabled').checked,
    ...(publicTemplate.trim() ? { publicTemplate } : {}),
    ...(internalNoteTemplate.trim() ? { internalNoteTemplate } : {}),
    ...(Object.keys(pointOverrides).length > 0 ? { pointOverrides } : {}),
  };
};

export const getCurrentRuleEditors = (rulesList: HTMLElement): RuleConfig[] =>
  Array.from(
    rulesList.querySelectorAll<HTMLElement>('[data-rule-row]'),
    collectRule
  );

export const replaceRuleEditors = (
  rulesList: HTMLElement,
  rules: RuleConfig[],
  config: StrikeLedgerConfig
) => {
  rulesList.replaceChildren(
    ...rules.map((rule) =>
      createRuleEditor(rule, config, rulesList, {
        isExisting: config.rules.some((existing) => existing.id === rule.id),
      })
    )
  );
  updateRuleControls(rulesList);
};
