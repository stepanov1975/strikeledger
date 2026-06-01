import { ACTION_LABELS, STRIKE_ACTIONS } from '../core/domain';
import type { StrikeLedgerConfig } from '../core/domain';
import type {
  DashboardView,
  ImportedRedditRule,
  LedgerEntryRow,
  RuleImportMode,
  SideEffects,
  ViewContext,
} from './dashboardTypes';

export const create = <K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
};

export const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}.`);
  }

  return response.json() as Promise<T>;
};

const formatDate = (value: number): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

export const formatTargetUser = (context: ViewContext): string =>
  context.authorName ? `u/${context.authorName}` : context.userKey;

export const titleCase = (value: string): string =>
  value.slice(0, 1).toUpperCase() + value.slice(1);

export const dashboardViewLabel = (view: DashboardView): string =>
  view === 'settings' ? 'Admin' : titleCase(view);

export const renderToolbar = (
  title: string,
  subtitle: string,
  action?: HTMLElement
): HTMLElement => {
  const toolbar = create('div', 'toolbar');
  const heading = create('div');
  heading.append(
    create('h2', 'title', title),
    create('p', 'subtitle', subtitle)
  );
  toolbar.append(heading);
  if (action) {
    toolbar.append(action);
  }
  return toolbar;
};

const metric = (label: string, value: string | number): HTMLElement => {
  const item = create('div', 'metric');
  item.append(
    create('div', 'metric-label', label),
    create('div', 'metric-value', String(value))
  );
  return item;
};

export const renderMetrics = (
  items: Array<[string, string | number]>
): HTMLElement => {
  const metrics = create('section', 'metrics');
  for (const [label, value] of items) {
    metrics.append(metric(label, value));
  }
  return metrics;
};

export const formatAverageScore = (score: number | null): string => {
  if (score === null) {
    return 'n/a';
  }

  return Number.isInteger(score) ? String(score) : score.toFixed(1);
};

const sideEffectSummary = (sideEffects: SideEffects): string => {
  const notable: string[] = [];

  for (const [name, value] of Object.entries(sideEffects)) {
    if (typeof value === 'string') {
      if (value !== 'skipped' && value !== 'succeeded') {
        notable.push(`${name}: ${value}`);
      }
      continue;
    }

    for (const [option, status] of Object.entries(value)) {
      if (status !== 'skipped' && status !== 'succeeded') {
        notable.push(`${name}.${option}: ${status}`);
      }
    }
  }

  return notable.length > 0 ? notable.join(', ') : 'OK';
};

export const renderEntryTable = (
  entries: LedgerEntryRow[],
  onReverse?: (entry: LedgerEntryRow) => void
): HTMLElement => {
  const panel = create('div', 'panel');
  const table = create('table');
  const thead = create('thead');
  const headerRow = create('tr');
  const headers = [
    'Date',
    'Rule',
    'Action',
    'Points',
    'Status',
    'Target',
    'Moderator',
    'Side effects',
  ];
  if (onReverse) {
    headers.push('Actions');
  }
  for (const label of headers) {
    headerRow.append(create('th', undefined, label));
  }
  thead.append(headerRow);

  const tbody = create('tbody');
  for (const entry of entries) {
    const row = create('tr');
    row.append(
      create('td', undefined, formatDate(entry.createdAtMs)),
      create('td', undefined, entry.ruleLabel),
      create('td', undefined, entry.actionLabel),
      create('td', undefined, `${entry.activePoints}/${entry.originalPoints}`)
    );

    const statusCell = create('td');
    statusCell.append(
      create('span', `status ${entry.status}`, titleCase(entry.status))
    );
    row.append(statusCell);

    const targetCell = create('td');
    const targetLink = create('a', 'link', 'Open');
    targetLink.href = entry.targetPermalink;
    targetLink.target = '_blank';
    targetLink.rel = 'noreferrer';
    targetCell.append(targetLink);

    row.append(
      targetCell,
      create('td', undefined, entry.moderatorUsername),
      create('td', undefined, sideEffectSummary(entry.sideEffects))
    );

    if (onReverse) {
      const actionCell = create('td');
      if (entry.status !== 'reversed') {
        const reverseButton = create('button', 'secondary-button', 'Reverse');
        reverseButton.type = 'button';
        reverseButton.addEventListener('click', () => {
          onReverse(entry);
        });
        actionCell.append(reverseButton);
      }
      row.append(actionCell);
    }

    tbody.append(row);
  }

  table.append(thead, tbody);
  panel.append(table);
  return panel;
};

export const renderRulesTable = (config: StrikeLedgerConfig): HTMLElement => {
  const panel = create('div', 'panel');
  const table = create('table');
  const thead = create('thead');
  const headerRow = create('tr');
  for (const label of ['Rule ID', 'Label', 'Points', 'Enabled']) {
    headerRow.append(create('th', undefined, label));
  }
  thead.append(headerRow);

  const tbody = create('tbody');
  for (const rule of config.rules) {
    const points = STRIKE_ACTIONS.map(
      (action) =>
        `${ACTION_LABELS[action]}: ${
          rule.pointOverrides?.[action] ?? config.actionPoints[action]
        }`
    ).join(', ');
    const row = create('tr');
    row.append(
      create('td', undefined, rule.id),
      create('td', undefined, rule.label),
      create('td', undefined, points),
      create('td', undefined, rule.enabled ? 'Yes' : 'No')
    );
    tbody.append(row);
  }
  table.append(thead, tbody);
  panel.append(table);
  return panel;
};

export const renderImportedRulesTable = (
  rules: ImportedRedditRule[]
): HTMLElement => {
  const panel = create('div', 'panel');
  const table = create('table');
  const thead = create('thead');
  const headerRow = create('tr');
  for (const label of ['Imported ID', 'StrikeLedger label', 'Reddit rule']) {
    headerRow.append(create('th', undefined, label));
  }
  thead.append(headerRow);

  const tbody = create('tbody');
  for (const rule of rules) {
    const row = create('tr');
    row.append(
      create('td', undefined, rule.id),
      create('td', undefined, rule.label),
      create('td', undefined, rule.redditShortName)
    );
    tbody.append(row);
  }

  table.append(thead, tbody);
  panel.append(table);
  return panel;
};

export const settingsSection = (
  title: string,
  subtitle: string | null,
  ...children: HTMLElement[]
): HTMLElement => {
  const section = create('section', 'settings-section');
  section.append(create('h3', 'section-title', title));
  if (subtitle) {
    section.append(create('p', 'subtitle', subtitle));
  }
  section.append(...children);
  return section;
};

export const numberField = (
  labelText: string,
  name: string,
  value: number | undefined,
  options: {
    min: number;
    max: number;
    required?: boolean;
    placeholder?: string;
  }
): HTMLElement => {
  const label = create('label', 'field-label', labelText);
  const input = create('input', 'field-control') as HTMLInputElement;
  input.type = 'number';
  input.name = name;
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = '1';
  input.required = options.required ?? false;
  input.value = value === undefined ? '' : String(value);
  if (options.placeholder) {
    input.placeholder = options.placeholder;
  }
  label.append(input);
  return label;
};

export const textField = (
  labelText: string,
  name: string,
  value: string | undefined,
  options: { required?: boolean; pattern?: string; maxLength?: number } = {}
): HTMLElement => {
  const label = create('label', 'field-label', labelText);
  const input = create('input', 'field-control') as HTMLInputElement;
  input.type = 'text';
  input.name = name;
  input.value = value ?? '';
  input.required = options.required ?? false;
  if (options.pattern) {
    input.pattern = options.pattern;
  }
  if (options.maxLength) {
    input.maxLength = options.maxLength;
  }
  label.append(input);
  return label;
};

export const textareaField = (
  labelText: string,
  name: string,
  value: string | undefined,
  required: boolean
): HTMLElement => {
  const label = create('label', 'field-label', labelText);
  const textarea = create(
    'textarea',
    'field-control template-editor'
  ) as HTMLTextAreaElement;
  textarea.name = name;
  textarea.rows = 4;
  textarea.maxLength = 2000;
  textarea.required = required;
  textarea.value = value ?? '';
  label.append(textarea);
  return label;
};

export const toggleField = (
  labelText: string,
  name: string,
  checked: boolean
): HTMLElement => {
  const label = create('label', 'toggle-row');
  const input = create('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.name = name;
  input.checked = checked;
  label.append(input, create('span', undefined, labelText));
  return label;
};

export const ruleImportModeSelect = (): HTMLSelectElement => {
  const select = create('select', 'field-control') as HTMLSelectElement;
  const options: Array<[RuleImportMode, string]> = [
    ['add-missing', 'Add missing rules'],
    ['replace', 'Replace active rules'],
    ['sync-labels-order', 'Sync labels and order'],
  ];

  for (const [value, label] of options) {
    const option = create('option', undefined, label) as HTMLOptionElement;
    option.value = value;
    select.append(option);
  }

  return select;
};

export const actionPointSummary = (config: StrikeLedgerConfig): string =>
  STRIKE_ACTIONS.map(
    (action) => `${ACTION_LABELS[action]}: ${config.actionPoints[action]}`
  ).join(', ');
