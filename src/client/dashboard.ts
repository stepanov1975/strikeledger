import './dashboard.css';
import type { StrikeLedgerConfig } from '../core/domain';
import {
  collectRule,
  createRuleEditor,
  getCurrentRuleEditors,
  replaceRuleEditors,
  updateRuleControls,
} from './dashboardRuleEditor';
import type {
  AdminConfig,
  BootstrapResponse,
  DashboardView,
  HistoryResponse,
  LedgerEntryRow,
  ProfileResponse,
  RecalculateResponse,
  RedditRulesResponse,
  ReverseResponse,
  RuleImportMode,
  SettingsResponse,
  SettingsSaveResponse,
  ViewContext,
} from './dashboardTypes';
import {
  actionPointSummary,
  create,
  dashboardViewLabel,
  fetchJson,
  formatAverageScore,
  formatTargetUser,
  renderEntryTable,
  renderImportedRulesTable,
  renderMetrics,
  renderRulesTable,
  renderToolbar,
  ruleImportModeSelect,
  settingsSection,
  titleCase,
} from './dashboardUi';
import {
  buildUsedRuleIds,
  mergeImportedRules,
  nextAvailableRuleId,
} from './ruleImport';

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

const setActiveView = async (view: DashboardView) => {
  activeView = view;
  renderFrame();
  await loadActiveView();
};

const showError = (message: string) => {
  main?.replaceChildren(create('div', 'error', message));
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
