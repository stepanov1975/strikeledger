import './dashboard.css';
import {
  ACTION_LABELS,
  STRIKE_ACTIONS,
  type RuleConfig,
  type StrikeLedgerConfig,
  type StrikeAction,
} from '../core/domain';

type DashboardView = 'history' | 'profile' | 'settings';

type BootstrapResponse = {
  view: DashboardView;
  subredditName: string;
  moderatorUsername: string;
  contextToken?: string;
};

type ViewContext = {
  subredditName: string;
  userKey: string;
  targetId?: string;
  targetKind?: 'post' | 'comment';
  authorName?: string;
};

type SideEffects = Record<string, string | Record<string, string>>;

type LedgerEntryRow = {
  entryId: string;
  username: string;
  targetPermalink: string;
  actionLabel: string;
  ruleLabel: string;
  originalPoints: number;
  activePoints: number;
  moderatorUsername: string;
  createdAtMs: number;
  status: string;
  sideEffects: SideEffects;
};

type HistoryResponse = {
  context: ViewContext;
  activeTotal: number;
  entries: LedgerEntryRow[];
  nextOffset: number | null;
};

type ProfileResponse = {
  context: ViewContext;
  summary: {
    activeTotal: number;
    lifetimeOriginalPoints: number;
    decayedPoints: number;
    reversedEntries: number;
    averagePostScore: number | null;
    postScorePostCount: number;
    postScoreWindowDays: number;
    removalsByRule: Record<string, number>;
  };
  recentEntries: LedgerEntryRow[];
};

type ReverseResponse = {
  status: 'reversed' | 'already_reversed';
  activeTotal: number;
};

type SettingsResponse = {
  subredditName: string;
  canManage: boolean;
  config: StrikeLedgerConfig;
};

type AdminConfig = Pick<
  StrikeLedgerConfig,
  'schemaVersion' | 'revision' | 'rules'
>;

type SettingsSaveResponse =
  | { status: 'saved'; config: StrikeLedgerConfig }
  | { status: 'conflict'; currentRevision: number }
  | {
      status: 'invalid';
      issues: Array<{ path: string; message: string }>;
    };

type RecalculateResponse = {
  userKey: string;
  activeTotal: number;
};

type ImportedRedditRule = {
  id: string;
  label: string;
  redditShortName: string;
  description: string;
  kind: string;
  violationReason: string;
  priority: number;
  enabled: true;
};

type RedditRulesResponse = {
  subredditName: string;
  rules: ImportedRedditRule[];
};

type RuleImportMode = 'add-missing' | 'replace' | 'sync-labels-order';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app root.');
}

let bootstrap: BootstrapResponse | null = null;
let activeView: DashboardView = 'settings';
let main: HTMLElement | null = null;
let historyEntries: LedgerEntryRow[] = [];
let historyNextOffset: number | null = null;
let historyContext: ViewContext | null = null;
let historyActiveTotal = 0;
let historyNotice: string | null = null;
let settingsNotice: string | null = null;

const create = <K extends keyof HTMLElementTagNameMap>(
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

const fetchJson = async <T>(url: string): Promise<T> => {
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

const formatTargetUser = (context: ViewContext): string =>
  context.authorName ? `u/${context.authorName}` : context.userKey;

const appendContextTokenParam = (params: URLSearchParams): boolean => {
  if (bootstrap?.contextToken) {
    params.set('contextToken', bootstrap.contextToken);
    return true;
  }

  return false;
};

const renderFrame = () => {
  if (!bootstrap) {
    return;
  }

  const shell = create('div', 'shell');
  const topbar = create('header', 'topbar');
  const brand = create('div', 'brand');
  brand.append(
    create('h1', 'brand-title', 'StrikeLedger'),
    create(
      'p',
      'brand-meta',
      `r/${bootstrap.subredditName} · ${bootstrap.moderatorUsername}`
    )
  );

  const tabs = create('div', 'tabs');
  for (const view of [
    'history',
    'profile',
    'settings',
  ] satisfies DashboardView[]) {
    const button = create('button', 'tab', dashboardViewLabel(view));
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(view === activeView));
    button.addEventListener('click', () => {
      void setActiveView(view);
    });
    tabs.append(button);
  }

  topbar.append(brand, tabs);
  main = create('main', 'content');
  shell.append(topbar, main);
  app.replaceChildren(shell);
};

const titleCase = (value: string): string =>
  value.slice(0, 1).toUpperCase() + value.slice(1);

const dashboardViewLabel = (view: DashboardView): string =>
  view === 'settings' ? 'Admin' : titleCase(view);

const setActiveView = async (view: DashboardView) => {
  activeView = view;
  renderFrame();
  await loadActiveView();
};

const showError = (message: string) => {
  main?.replaceChildren(create('div', 'error', message));
};

const renderToolbar = (
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

const renderMetrics = (
  items: Array<[string, string | number]>
): HTMLElement => {
  const metrics = create('section', 'metrics');
  for (const [label, value] of items) {
    metrics.append(metric(label, value));
  }
  return metrics;
};

const formatAverageScore = (score: number | null): string => {
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

const renderEntryTable = (
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

const renderHistory = () => {
  if (!main || !historyContext) {
    return;
  }

  const children: HTMLElement[] = [
    renderToolbar('History', formatTargetUser(historyContext)),
    renderMetrics([['Active total', historyActiveTotal]]),
  ];

  if (historyNotice) {
    children.push(create('div', 'notice', historyNotice));
  }

  if (historyEntries.length === 0) {
    children.push(create('div', 'empty', 'No ledger entries.'));
  } else {
    children.push(renderEntryTable(historyEntries, reverseEntry));
  }

  if (historyNextOffset !== null) {
    const loadMore = create('button', 'load-more', 'Load more');
    loadMore.type = 'button';
    loadMore.addEventListener('click', () => {
      void loadHistory(historyNextOffset ?? 0);
    });
    children.push(loadMore);
  }

  main.replaceChildren(...children);
};

const renderContextRequired = (
  view: Extract<DashboardView, 'history' | 'profile'>
) => {
  if (!main) {
    return;
  }

  main.replaceChildren(
    renderToolbar(titleCase(view), 'No selected author'),
    create('div', 'empty', 'Open this view from a post or comment menu item.')
  );
};

const loadHistory = async (offset: number) => {
  const params = new URLSearchParams({
    offset: String(offset),
  });
  if (!appendContextTokenParam(params)) {
    renderContextRequired('history');
    return;
  }

  const response = await fetchJson<HistoryResponse>(`/api/history?${params}`);

  if (offset === 0) {
    historyEntries = [];
  }

  historyContext = response.context;
  historyActiveTotal = response.activeTotal;
  historyEntries = [...historyEntries, ...response.entries];
  historyNextOffset = response.nextOffset;
  renderHistory();
};

type ReverseDialogResult = {
  reversalReason: string;
  reversalNote?: string;
  addNativeModNote: boolean;
};

const showReverseDialog = (
  entry: LedgerEntryRow
): Promise<ReverseDialogResult | null> =>
  new Promise((resolve) => {
    const dialog = create('dialog', 'modal');
    const form = create('form', 'modal-form') as HTMLFormElement;
    form.method = 'dialog';

    const title = create('h2', 'title', 'Reverse strike');
    const subtitle = create(
      'p',
      'subtitle',
      `${entry.actionLabel} · ${entry.ruleLabel}`
    );
    const reasonLabel = create('label', 'field-label', 'Reason');
    const reason = create('textarea', 'field-control') as HTMLTextAreaElement;
    reason.required = true;
    reason.rows = 4;
    const noteLabel = create('label', 'field-label', 'Internal note');
    const note = create('textarea', 'field-control') as HTMLTextAreaElement;
    note.rows = 3;

    const checkboxLabel = create('label', 'checkbox-label');
    const checkbox = create('input') as HTMLInputElement;
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkboxLabel.append(
      checkbox,
      document.createTextNode('Add native mod note')
    );

    reasonLabel.append(reason);
    noteLabel.append(note);

    const actions = create('div', 'modal-actions');
    const cancel = create('button', 'secondary-button', 'Cancel');
    cancel.type = 'button';
    const submit = create('button', 'danger-button', 'Reverse');
    submit.type = 'submit';
    actions.append(cancel, submit);

    form.append(
      title,
      subtitle,
      reasonLabel,
      noteLabel,
      checkboxLabel,
      actions
    );
    dialog.append(form);
    document.body.append(dialog);

    const cleanup = (value: ReverseDialogResult | null) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };

    cancel.addEventListener('click', () => cleanup(null));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const reversalReason = reason.value.trim();
      const reversalNote = note.value.trim();
      if (!reversalReason) {
        reason.reportValidity();
        return;
      }

      cleanup({
        reversalReason,
        ...(reversalNote ? { reversalNote } : {}),
        addNativeModNote: checkbox.checked,
      });
    });
    dialog.addEventListener('cancel', () => cleanup(null));

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  });

const reverseEntry = async (entry: LedgerEntryRow) => {
  const reversal = await showReverseDialog(entry);
  if (!reversal) {
    return;
  }

  try {
    const response = await fetch('/api/reverse', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        entryId: entry.entryId,
        ...reversal,
      }),
    });

    if (!response.ok) {
      throw new Error(`Reversal failed with ${response.status}.`);
    }

    const result = (await response.json()) as ReverseResponse;
    historyNotice =
      result.status === 'already_reversed'
        ? 'Strike was already reversed.'
        : `Strike reversed. Active total: ${result.activeTotal}.`;
    await loadHistory(0);
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Reversal failed.');
  }
};

const renderProfile = (response: ProfileResponse) => {
  if (!main) {
    return;
  }

  const removals = Object.entries(response.summary.removalsByRule)
    .map(([rule, count]) => `${rule}: ${count}`)
    .join(', ');

  main.replaceChildren(
    renderToolbar('Profile', formatTargetUser(response.context)),
    renderMetrics([
      ['Active total', response.summary.activeTotal],
      ['Lifetime points', response.summary.lifetimeOriginalPoints],
      ['Decayed points', response.summary.decayedPoints],
      ['Reversed entries', response.summary.reversedEntries],
      [
        `Avg post score, last ${response.summary.postScoreWindowDays} days`,
        formatAverageScore(response.summary.averagePostScore),
      ],
    ]),
    create('p', 'subtitle', removals || 'No removals recorded.'),
    response.recentEntries.length > 0
      ? renderEntryTable(response.recentEntries)
      : create('div', 'empty', 'No ledger entries.')
  );
};

const loadProfile = async () => {
  const params = new URLSearchParams();
  if (!appendContextTokenParam(params)) {
    renderContextRequired('profile');
    return;
  }

  const response = await fetchJson<ProfileResponse>(`/api/profile?${params}`);
  renderProfile(response);
};

const renderRulesTable = (config: StrikeLedgerConfig): HTMLElement => {
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

const renderImportedRulesTable = (rules: ImportedRedditRule[]): HTMLElement => {
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

const settingsSection = (
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

const numberField = (
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

const textField = (
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

const textareaField = (
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

const toggleField = (
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

const ruleImportModeSelect = (): HTMLSelectElement => {
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

const actionPointSummary = (config: StrikeLedgerConfig): string =>
  STRIKE_ACTIONS.map(
    (action) => `${ACTION_LABELS[action]}: ${config.actionPoints[action]}`
  ).join(', ');

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

type RuleEditorOptions = {
  isExisting: boolean;
};

const updateRuleControls = (rulesList: HTMLElement) => {
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

const createRuleEditor = (
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

const collectRule = (row: HTMLElement): RuleConfig => {
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

const normalizeRuleMatchValue = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

const importedRuleToConfig = (rule: ImportedRedditRule): RuleConfig => ({
  id: rule.id,
  label: rule.label,
  enabled: true,
});

const getCurrentRuleEditors = (rulesList: HTMLElement): RuleConfig[] =>
  Array.from(
    rulesList.querySelectorAll<HTMLElement>('[data-rule-row]'),
    collectRule
  );

const buildUsedRuleIds = (rules: RuleConfig[]): Set<string> =>
  new Set(rules.map((rule) => rule.id));

const nextAvailableRuleId = (usedIds: Set<string>): string => {
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

const mergeImportedRules = (
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

  const existingLabels = new Set(
    currentRules.map((rule) => normalizeRuleMatchValue(rule.label))
  );
  const usedIds = buildUsedRuleIds(currentRules);
  const newRules = importedConfigs
    .filter((rule) => !existingLabels.has(normalizeRuleMatchValue(rule.label)))
    .map((rule) => withAvailableRuleId(rule, usedIds));

  return [...currentRules, ...newRules];
};

const replaceRuleEditors = (
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

const buildRuleImportSection = (
  rulesList: HTMLElement,
  config: StrikeLedgerConfig
): HTMLElement => {
  const preview = create('div', 'rule-import-preview');
  const importButton = create(
    'button',
    'secondary-button',
    'Import from Reddit rules'
  );
  importButton.type = 'button';
  importButton.addEventListener('click', async () => {
    importButton.disabled = true;
    preview.replaceChildren(create('div', 'notice', 'Loading Reddit rules.'));

    try {
      const response = await fetchJson<RedditRulesResponse>(
        '/api/settings/reddit-rules'
      );
      if (response.rules.length === 0) {
        preview.replaceChildren(
          create('div', 'empty', 'No Reddit rules found.')
        );
        return;
      }

      const modeLabel = create('label', 'field-label', 'Import mode');
      const modeSelect = ruleImportModeSelect();
      modeLabel.append(modeSelect);

      const apply = create('button', 'load-more', 'Apply import preview');
      apply.type = 'button';
      apply.addEventListener('click', () => {
        const currentRules = getCurrentRuleEditors(rulesList);
        const nextRules = mergeImportedRules(
          currentRules,
          response.rules,
          modeSelect.value as RuleImportMode
        );
        replaceRuleEditors(rulesList, nextRules, config);
        preview.replaceChildren(
          create(
            'div',
            'notice',
            `${response.rules.length} Reddit rule(s) applied to the form.`
          )
        );
      });

      const actions = create('div', 'modal-actions');
      actions.append(apply);
      preview.replaceChildren(
        renderImportedRulesTable(response.rules),
        modeLabel,
        actions
      );
    } catch (error) {
      preview.replaceChildren(
        create(
          'div',
          'error',
          error instanceof Error ? error.message : 'Unable to import rules.'
        )
      );
    } finally {
      importButton.disabled = false;
    }
  });

  return settingsSection(
    'Reddit rules import',
    'Imported rules are flattened to Rule 1, Rule 2, Rule 3 order.',
    importButton,
    preview
  );
};

const toAdminConfig = (config: StrikeLedgerConfig): AdminConfig => ({
  schemaVersion: config.schemaVersion,
  revision: config.revision,
  rules: config.rules,
});

const buildRulesJsonSection = (
  revision: number,
  config: AdminConfig,
  getCurrentConfig: () => AdminConfig
): HTMLElement => {
  const status = create('div', 'rule-import-preview');
  const label = create('label', 'field-label', 'Rules JSON');
  const textarea = create(
    'textarea',
    'field-control config-json-editor'
  ) as HTMLTextAreaElement;
  textarea.rows = 12;
  textarea.maxLength = 100000;
  textarea.value = JSON.stringify(config, null, 2);
  label.append(textarea);

  const refresh = create('button', 'secondary-button', 'Refresh export');
  refresh.type = 'button';
  refresh.addEventListener('click', () => {
    textarea.value = JSON.stringify(getCurrentConfig(), null, 2);
    status.replaceChildren(create('div', 'notice', 'Rules JSON refreshed.'));
  });

  const importButton = create(
    'button',
    'secondary-button',
    'Save imported JSON'
  );
  importButton.type = 'button';
  importButton.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(textarea.value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Rules JSON must be an object.');
      }

      void saveSettings(revision, parsed as AdminConfig);
    } catch (error) {
      status.replaceChildren(
        create(
          'div',
          'error',
          error instanceof Error ? error.message : 'Invalid rules JSON.'
        )
      );
    }
  });

  const actions = create('div', 'modal-actions');
  actions.append(refresh, importButton);
  return settingsSection('Rules JSON', null, label, actions, status);
};

const collectAdminConfig = (
  form: HTMLFormElement,
  currentConfig: StrikeLedgerConfig
): AdminConfig => {
  const ruleRows = form.querySelectorAll<HTMLElement>('[data-rule-row]');

  return {
    schemaVersion: currentConfig.schemaVersion,
    revision: currentConfig.revision,
    rules: Array.from(ruleRows, collectRule),
  };
};

const buildSettingsForm = (response: SettingsResponse): HTMLFormElement => {
  const form = create(
    'form',
    'settings-form settings-editor'
  ) as HTMLFormElement;
  const { config } = response;

  const rulesList = create('div', 'rule-editor-list');
  for (const rule of config.rules) {
    rulesList.append(
      createRuleEditor(rule, config, rulesList, { isExisting: true })
    );
  }
  updateRuleControls(rulesList);

  const addRule = create('button', 'secondary-button', 'Add rule');
  addRule.type = 'button';
  addRule.addEventListener('click', () => {
    const usedIds = buildUsedRuleIds(getCurrentRuleEditors(rulesList));
    rulesList.append(
      createRuleEditor(
        { id: nextAvailableRuleId(usedIds), label: '', enabled: true },
        config,
        rulesList,
        { isExisting: false }
      )
    );
    updateRuleControls(rulesList);
  });
  const rulesJsonSection = buildRulesJsonSection(
    config.revision,
    toAdminConfig(config),
    () => collectAdminConfig(form, config)
  );

  const actions = create('div', 'modal-actions');
  const save = create('button', 'load-more', 'Save admin changes');
  save.type = 'submit';
  actions.append(save);

  form.append(
    buildRuleImportSection(rulesList, config),
    settingsSection(
      'Rules',
      'Blank rule templates use the matching default template.',
      rulesList,
      addRule
    ),
    rulesJsonSection,
    actions
  );

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings(config.revision, collectAdminConfig(form, config));
  });

  return form;
};

const renderSettings = (response: SettingsResponse) => {
  if (!main) {
    return;
  }

  const children: HTMLElement[] = [
    renderToolbar('Admin', `r/${response.subredditName}`),
    renderMetrics([
      ['Revision', response.config.revision],
      [
        'Decay',
        `${response.config.decayAmount}/${response.config.decayIntervalDays}d`,
      ],
      ['Post score window', `${response.config.postScoreWindowDays}d`],
      ['User notices', response.config.userNoticesEnabled ? 'On' : 'Off'],
      ['Mod notes', response.config.nativeModNotesEnabled ? 'On' : 'Off'],
    ]),
    create('p', 'subtitle', actionPointSummary(response.config)),
  ];

  if (settingsNotice) {
    children.push(create('div', 'notice', settingsNotice));
  }

  if (response.canManage) {
    const recalcForm = create('form', 'settings-form') as HTMLFormElement;
    const recalcLabel = create('label', 'field-label', 'Username or user key');
    const recalcInput = create('input', 'field-control') as HTMLInputElement;
    recalcInput.type = 'text';
    recalcLabel.append(recalcInput);
    const recalcActions = create('div', 'modal-actions');
    const recalcButton = create('button', 'secondary-button', 'Recalculate');
    recalcButton.type = 'submit';
    recalcActions.append(recalcButton);
    recalcForm.append(recalcLabel, recalcActions);
    recalcForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void recalculateUserTotal(recalcInput.value);
    });
    children.push(recalcForm, buildSettingsForm(response));
  } else {
    children.push(renderRulesTable(response.config));
  }

  main.replaceChildren(...children);
};

const loadSettings = async () => {
  renderSettings(await fetchJson<SettingsResponse>('/api/settings'));
};

const recalculateUserTotal = async (rawValue: string) => {
  const value = rawValue.trim();
  if (!value) {
    showError('User is required.');
    return;
  }

  try {
    const keyField =
      value.startsWith('id:') || value.startsWith('name:')
        ? 'userKey'
        : 'username';
    const response = await fetch('/api/recalculate-user-total', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ [keyField]: value }),
    });

    if (!response.ok) {
      throw new Error(`Recalculate failed with ${response.status}.`);
    }

    const result = (await response.json()) as RecalculateResponse;
    settingsNotice = `${result.userKey}: active total ${result.activeTotal}.`;
    await loadSettings();
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Recalculate failed.');
  }
};

const saveSettings = async (revision: number, config: AdminConfig) => {
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ revision, config }),
    });
    const result = (await response.json()) as SettingsSaveResponse;

    if (!response.ok) {
      if (result.status === 'conflict') {
        throw new Error(
          `Settings changed. Current revision: ${result.currentRevision}.`
        );
      }

      if (result.status === 'invalid') {
        throw new Error(
          result.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join('; ')
        );
      }

      throw new Error(`Settings save failed with ${response.status}.`);
    }

    if (result.status !== 'saved') {
      throw new Error('Unexpected settings response.');
    }

    settingsNotice = 'Admin changes saved.';
    renderSettings({
      subredditName: bootstrap?.subredditName ?? '',
      canManage: true,
      config: result.config,
    });
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Settings save failed.');
  }
};

const loadActiveView = async () => {
  try {
    if (activeView === 'history') {
      await loadHistory(0);
    } else if (activeView === 'profile') {
      await loadProfile();
    } else {
      await loadSettings();
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Request failed.');
  }
};

const start = async () => {
  try {
    bootstrap = await fetchJson<BootstrapResponse>('/api/bootstrap');
    activeView = bootstrap.view;
    renderFrame();
    await loadActiveView();
  } catch (error) {
    app.replaceChildren(
      create(
        'div',
        'error',
        error instanceof Error ? error.message : 'Unable to load StrikeLedger.'
      )
    );
  }
};

void start();
