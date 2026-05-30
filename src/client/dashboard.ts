import './dashboard.css';

type DashboardView = 'history' | 'profile' | 'settings';

type BootstrapResponse = {
  view: DashboardView;
  subredditName: string;
  moderatorUsername: string;
  contextToken?: string;
};

type ViewContext = {
  targetId: string;
  targetKind: 'post' | 'comment';
  subredditName: string;
  userKey: string;
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
  config: {
    revision: number;
    rules: Array<{ id: string; label: string; enabled: boolean }>;
    actionPoints: Record<string, number>;
    decayAmount: number;
    decayIntervalDays: number;
    userNoticesEnabled: boolean;
    nativeModNotesEnabled: boolean;
    reversalNativeModNotesEnabled: boolean;
    distinguishAppComments: boolean;
    lockAppComments: boolean;
  };
};

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
  for (const view of ['history', 'profile', 'settings'] satisfies DashboardView[]) {
    const button = create('button', 'tab', titleCase(view));
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(view === activeView));
    button.disabled = view !== 'settings' && bootstrap.contextToken === undefined;
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
  heading.append(create('h2', 'title', title), create('p', 'subtitle', subtitle));
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

const renderMetrics = (items: Array<[string, string | number]>): HTMLElement => {
  const metrics = create('section', 'metrics');
  for (const [label, value] of items) {
    metrics.append(metric(label, value));
  }
  return metrics;
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
    statusCell.append(create('span', `status ${entry.status}`, titleCase(entry.status)));
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

const loadHistory = async (offset: number) => {
  if (!bootstrap?.contextToken) {
    showError('Missing view context.');
    return;
  }

  const params = new URLSearchParams({
    contextToken: bootstrap.contextToken,
    offset: String(offset),
  });
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
    const subtitle = create('p', 'subtitle', `${entry.actionLabel} · ${entry.ruleLabel}`);
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
    checkboxLabel.append(checkbox, document.createTextNode('Add native mod note'));

    reasonLabel.append(reason);
    noteLabel.append(note);

    const actions = create('div', 'modal-actions');
    const cancel = create('button', 'secondary-button', 'Cancel');
    cancel.type = 'button';
    const submit = create('button', 'danger-button', 'Reverse');
    submit.type = 'submit';
    actions.append(cancel, submit);

    form.append(title, subtitle, reasonLabel, noteLabel, checkboxLabel, actions);
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
    ]),
    create('p', 'subtitle', removals || 'No removals recorded.'),
    response.recentEntries.length > 0
      ? renderEntryTable(response.recentEntries)
      : create('div', 'empty', 'No ledger entries.')
  );
};

const loadProfile = async () => {
  if (!bootstrap?.contextToken) {
    showError('Missing view context.');
    return;
  }

  const params = new URLSearchParams({ contextToken: bootstrap.contextToken });
  renderProfile(await fetchJson<ProfileResponse>(`/api/profile?${params}`));
};

const renderSettings = (response: SettingsResponse) => {
  if (!main) {
    return;
  }

  const actionPoints = Object.entries(response.config.actionPoints)
    .map(([action, points]) => `${action}: ${points}`)
    .join(', ');
  const rulesPanel = create('div', 'panel');
  const table = create('table');
  const thead = create('thead');
  const headerRow = create('tr');
  for (const label of ['Rule ID', 'Label', 'Enabled']) {
    headerRow.append(create('th', undefined, label));
  }
  thead.append(headerRow);

  const tbody = create('tbody');
  for (const rule of response.config.rules) {
    const row = create('tr');
    row.append(
      create('td', undefined, rule.id),
      create('td', undefined, rule.label),
      create('td', undefined, rule.enabled ? 'Yes' : 'No')
    );
    tbody.append(row);
  }
  table.append(thead, tbody);
  rulesPanel.append(table);

  main.replaceChildren(
    renderToolbar('Settings', `r/${response.subredditName}`),
    renderMetrics([
      ['Revision', response.config.revision],
      ['Decay', `${response.config.decayAmount}/${response.config.decayIntervalDays}d`],
      ['User notices', response.config.userNoticesEnabled ? 'On' : 'Off'],
      ['Mod notes', response.config.nativeModNotesEnabled ? 'On' : 'Off'],
    ]),
    create('p', 'subtitle', actionPoints),
    rulesPanel
  );
};

const loadSettings = async () => {
  renderSettings(await fetchJson<SettingsResponse>('/api/settings'));
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
