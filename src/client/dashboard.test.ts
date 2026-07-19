// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const devvitClient = vi.hoisted(() => ({
  mode: 'inline' as 'inline' | 'expanded',
  listeners: [] as Array<(mode: 'inline' | 'expanded') => void>,
  requestExpandedMode: vi.fn(),
}));

vi.mock('@devvit/client', () => ({
  addWebViewModeListener: (callback: (mode: 'inline' | 'expanded') => void) => {
    devvitClient.listeners.push(callback);
  },
  getWebViewMode: () => devvitClient.mode,
  requestExpandedMode: devvitClient.requestExpandedMode,
}));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
};

const waitFor = async (assertion: () => void) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
};

const settingsResponse = {
  subredditName: 'testsub',
  canManage: false,
  config: {
    schemaVersion: 1,
    revision: 1,
    actionPoints: {
      warn: 1,
      warn_remove: 2,
      warn_nsfw: 3,
    },
    decayAmount: 1,
    decayIntervalDays: 30,
    defaultPublicCommentTemplate: 'Public notice',
    defaultPrivateUserNoticeTemplate: 'Private notice',
    defaultZeroPointPrivateUserNoticeTemplate: 'Zero point notice',
    defaultNativeModNoteTemplate: 'Mod note',
    defaultZeroPointNativeModNoteTemplate: 'Zero point mod note',
    userNoticesEnabled: true,
    distinguishAppComments: false,
    stickyAppComments: {
      warn: false,
      warn_remove: false,
      warn_nsfw: false,
    },
    lockAppComments: false,
    nativeModNotesEnabled: true,
    reversalNativeModNotesEnabled: true,
    rules: [],
  },
};

const historyEntry = {
  entryId: 'entry-1',
  username: 'target-user',
  targetPermalink: 'https://reddit.com/r/testsub/comments/example',
  actionLabel: 'Warn',
  ruleLabel: 'Rule 1',
  originalPoints: 1,
  activePoints: 1,
  moderatorUsername: 'mod-a',
  createdAtMs: 0,
  status: 'succeeded',
  sideEffects: {},
};

const historyResponse = (canReverse: boolean, entries = [historyEntry]) => ({
  context: { subredditName: 'testsub', userKey: 'id:t2_user' },
  activeTotal: 1,
  canAddReversalModNote: false,
  canReverse,
  entries,
  nextOffset: null,
});

const expandedBootstrap = (view: 'history' | 'settings') => ({
  view,
  subredditName: 'testsub',
  moderatorUsername: 'mod-a',
  hasPendingBootstrap: view === 'history',
  ...(view === 'history' ? { contextToken: 'view-token' } : {}),
});

const buttonByText = (text: string): HTMLButtonElement => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === text
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
};

describe('dashboard startup', () => {
  beforeEach(() => {
    vi.resetModules();
    devvitClient.mode = 'inline';
    devvitClient.listeners.length = 0;
    devvitClient.requestExpandedMode.mockReset();
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('reuses the in-flight expanded bootstrap request for duplicate expanded callbacks', async () => {
    devvitClient.mode = 'expanded';
    const bootstrap = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return bootstrap.promise;
      }
      if (url.startsWith('/api/history')) {
        return Promise.resolve(
          jsonResponse({
            context: { subredditName: 'testsub', userKey: 'id:t2_user' },
            activeTotal: 0,
            canAddReversalModNote: false,
            entries: [],
            nextOffset: null,
          })
        );
      }
      return Promise.resolve(jsonResponse(settingsResponse));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    expect(fetchMock).toHaveBeenCalledWith('/api/bootstrap', expect.anything());

    devvitClient.listeners[0]?.('expanded');

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === '/api/bootstrap')
    ).toHaveLength(1);

    bootstrap.resolve(
      jsonResponse({
        view: 'history',
        subredditName: 'testsub',
        moderatorUsername: 'mod-a',
        hasPendingBootstrap: true,
        contextToken: 'view-token',
      })
    );
    await waitFor(() =>
      expect(document.querySelector('.shell')).not.toBeNull()
    );
  });

  it('starts a fresh bootstrap after inline re-entry and ignores the stale response', async () => {
    devvitClient.mode = 'expanded';
    const bootstrapA = deferred<Response>();
    const bootstrapB = deferred<Response>();
    let bootstrapRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        bootstrapRequests += 1;
        return bootstrapRequests === 1 ? bootstrapA.promise : bootstrapB.promise;
      }
      if (url === '/api/inline-profile-preview') {
        return Promise.resolve(
          jsonResponse({ status: 'unavailable', subredditName: 'testsub' })
        );
      }
      if (url.startsWith('/api/history')) {
        return Promise.resolve(
          jsonResponse(
            historyResponse(true, [
              { ...historyEntry, ruleLabel: 'Stale Bootstrap History' },
            ])
          )
        );
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    expect(bootstrapRequests).toBe(1);

    devvitClient.mode = 'inline';
    devvitClient.listeners[0]?.('inline');
    await waitFor(() =>
      expect(document.querySelector('.launcher-shell')).not.toBeNull()
    );

    devvitClient.mode = 'expanded';
    devvitClient.listeners[0]?.('expanded');
    await waitFor(() => expect(bootstrapRequests).toBe(2));

    bootstrapA.resolve(jsonResponse(expandedBootstrap('history')));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.launcher-shell')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Stale Bootstrap History');

    bootstrapB.resolve(jsonResponse(expandedBootstrap('settings')));
    await waitFor(() =>
      expect(document.querySelector('.content')?.textContent).toContain('Admin')
    );
    expect(document.body.textContent).not.toContain('Stale Bootstrap History');
  });

  it('keeps a fresh bootstrap pending when the pre-inline request rejects', async () => {
    devvitClient.mode = 'expanded';
    const bootstrapA = deferred<Response>();
    const bootstrapB = deferred<Response>();
    let bootstrapRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        bootstrapRequests += 1;
        return bootstrapRequests === 1 ? bootstrapA.promise : bootstrapB.promise;
      }
      if (url === '/api/inline-profile-preview') {
        return Promise.resolve(
          jsonResponse({ status: 'unavailable', subredditName: 'testsub' })
        );
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');

    devvitClient.mode = 'inline';
    devvitClient.listeners[0]?.('inline');
    await waitFor(() =>
      expect(document.querySelector('.launcher-shell')).not.toBeNull()
    );

    devvitClient.mode = 'expanded';
    devvitClient.listeners[0]?.('expanded');
    await waitFor(() => expect(bootstrapRequests).toBe(2));

    bootstrapA.reject(new Error('Stale bootstrap failed.'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('#app > .error')).toBeNull();
    expect(document.querySelector('.launcher-shell')).not.toBeNull();

    bootstrapB.resolve(jsonResponse(expandedBootstrap('settings')));
    await waitFor(() =>
      expect(document.querySelector('.content')?.textContent).toContain('Admin')
    );
  });

  it('does not let a stale inline preview repaint after expanded mode renders', async () => {
    const inlinePreview = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/inline-profile-preview') {
        return inlinePreview.promise;
      }
      if (url === '/api/bootstrap') {
        return Promise.resolve(
          jsonResponse({
            view: 'settings',
            subredditName: 'testsub',
            moderatorUsername: 'mod-a',
            hasPendingBootstrap: false,
          })
        );
      }
      return Promise.resolve(jsonResponse(settingsResponse));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/bootstrap')
    ).toBe(false);

    devvitClient.mode = 'expanded';
    devvitClient.listeners[0]?.('expanded');
    await waitFor(() =>
      expect(document.querySelector('.shell')).not.toBeNull()
    );

    inlinePreview.resolve(
      jsonResponse({
        status: 'available',
        subredditName: 'testsub',
        contextToken: 'view-token',
        context: { subredditName: 'testsub', authorName: 'target-user' },
        summary: {
          activeTotal: 3,
          originalPoints: 3,
          decayedPoints: 0,
          reversedEntries: 0,
          removalsByRule: {},
          hasMoreEntries: false,
          summaryEntryLimit: 25,
        },
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.shell')).not.toBeNull();
    expect(document.querySelector('.launcher-shell')).toBeNull();
  });

  it('does not let a stale expanded bootstrap error replace inline content', async () => {
    devvitClient.mode = 'expanded';
    const bootstrap = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return bootstrap.promise;
      }
      if (url === '/api/inline-profile-preview') {
        return Promise.resolve(
          jsonResponse({ status: 'unavailable', subredditName: 'testsub' })
        );
      }
      return Promise.resolve(jsonResponse(settingsResponse));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    devvitClient.mode = 'inline';
    devvitClient.listeners[0]?.('inline');
    await waitFor(() =>
      expect(document.querySelector('.launcher-shell')).not.toBeNull()
    );

    bootstrap.resolve(
      new Response('bootstrap unavailable', {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.launcher-shell')).not.toBeNull();
    expect(document.querySelector('#app > .error')).toBeNull();
  });

  it('renders expanded Admin without Profile tab or lookup action', async () => {
    devvitClient.mode = 'expanded';
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(
          jsonResponse({
            view: 'settings',
            subredditName: 'testsub',
            moderatorUsername: 'mod-a',
            hasPendingBootstrap: false,
          })
        );
      }
      if (url === '/api/settings') {
        return Promise.resolve(
          jsonResponse({
            ...settingsResponse,
            canManage: true,
          })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');

    await waitFor(() =>
      expect(document.querySelector('.shell')).not.toBeNull()
    );

    const tabLabels = Array.from(document.querySelectorAll('.tab')).map(
      (button) => button.textContent
    );
    const buttonLabels = Array.from(document.querySelectorAll('button')).map(
      (button) => button.textContent
    );
    expect(tabLabels).toEqual(['History', 'Admin']);
    expect(buttonLabels).not.toContain('Profile');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/profile'))
    ).toBe(false);
  });

  it('renders Reverse controls only when History grants reversal permission', async () => {
    devvitClient.mode = 'expanded';
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('history')));
      }
      if (url.startsWith('/api/history')) {
        return Promise.resolve(jsonResponse(historyResponse(false)));
      }
      return Promise.resolve(jsonResponse(settingsResponse));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() =>
      expect(document.querySelector('.entry-list')).not.toBeNull()
    );

    expect(Array.from(document.querySelectorAll('button'))).not.toContainEqual(
      expect.objectContaining({ textContent: 'Reverse' })
    );
  });

  it('does not let a delayed History response overwrite a later Admin render', async () => {
    devvitClient.mode = 'expanded';
    const history = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('history')));
      }
      if (url.startsWith('/api/history')) {
        return history.promise;
      }
      return Promise.resolve(jsonResponse(settingsResponse));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(document.querySelector('.shell')).not.toBeNull());

    buttonByText('Admin').click();
    await waitFor(() =>
      expect(document.querySelector('.content')?.textContent).toContain('Admin')
    );

    history.resolve(
      jsonResponse(
        historyResponse(true, [
          { ...historyEntry, ruleLabel: 'Delayed History Rule' },
        ])
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.content')?.textContent).toContain('Admin');
    expect(document.querySelector('.content')?.textContent).not.toContain(
      'Delayed History Rule'
    );
  });

  it('does not let History A overwrite History B after an Admin round trip', async () => {
    devvitClient.mode = 'expanded';
    const historyA = deferred<Response>();
    let historyRequests = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('history')));
      }
      if (url.startsWith('/api/history')) {
        historyRequests += 1;
        if (historyRequests === 1) {
          return historyA.promise;
        }
        return Promise.resolve(
          jsonResponse(
            historyResponse(true, [
              { ...historyEntry, ruleLabel: 'Current History Rule' },
            ])
          )
        );
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(document.querySelector('.shell')).not.toBeNull());

    buttonByText('Admin').click();
    await waitFor(() =>
      expect(document.querySelector('.settings-form input')).not.toBeNull()
    );

    document.querySelector<HTMLInputElement>('.settings-form input')!.value = 'id:t2_user';
    document.querySelector<HTMLButtonElement>('.settings-form button[type="button"]')!.click();
    await waitFor(() =>
      expect(document.querySelector('.content')?.textContent).toContain(
        'Current History Rule'
      )
    );

    historyA.resolve(
      jsonResponse(
        historyResponse(true, [
          { ...historyEntry, ruleLabel: 'Stale History Rule' },
        ])
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.content')?.textContent).toContain(
      'Current History Rule'
    );
    expect(document.querySelector('.content')?.textContent).not.toContain(
      'Stale History Rule'
    );
  });

  it('submits a reversal with the required reason and refreshes History', async () => {
    devvitClient.mode = 'expanded';
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('history')));
      }
      if (url.startsWith('/api/history')) {
        return Promise.resolve(jsonResponse(historyResponse(true)));
      }
      if (url === '/api/reverse' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ status: 'reversed', activeTotal: 0 }));
      }
      return Promise.resolve(jsonResponse(settingsResponse));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() =>
      expect(document.querySelector('.entry-list')).not.toBeNull()
    );

    buttonByText('Reverse').click();
    const reason = document.querySelector<HTMLTextAreaElement>('dialog textarea');
    expect(reason).not.toBeNull();
    reason!.value = 'Moderator mistake';
    document
      .querySelector<HTMLFormElement>('dialog form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/reverse' &&
            JSON.parse(String((init as RequestInit).body)).reversalReason ===
              'Moderator mistake'
        )
      ).toBe(true)
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain('Strike reversed. Active total: 0.')
    );
  });

  it('shows the current revision when an Admin save conflicts', async () => {
    devvitClient.mode = 'expanded';
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('settings')));
      }
      if (url === '/api/settings' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ status: 'conflict', currentRevision: 2 }, 409)
        );
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(() => buttonByText('Save admin changes')).not.toThrow());

    buttonByText('Save admin changes').click();
    await waitFor(() =>
      expect(document.body.textContent).toContain('Settings changed. Current revision: 2.')
    );
  });

  it('shows server validation issues when an Admin save is invalid', async () => {
    devvitClient.mode = 'expanded';
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('settings')));
      }
      if (url === '/api/settings' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              status: 'invalid',
              issues: [{ path: 'rules[0].id', message: 'must be unique' }],
            },
            400
          )
        );
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(() => buttonByText('Save admin changes')).not.toThrow());

    buttonByText('Save admin changes').click();
    await waitFor(() =>
      expect(document.body.textContent).toContain('rules[0].id: must be unique')
    );
  });

  it('does not let a stale settings-save rejection replace History', async () => {
    devvitClient.mode = 'expanded';
    const save = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('settings')));
      }
      if (url === '/api/settings' && init?.method === 'POST') {
        return save.promise;
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(() => buttonByText('Save admin changes')).not.toThrow());

    buttonByText('Save admin changes').click();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/settings' &&
            (init as RequestInit).method === 'POST'
        )
      ).toBe(true)
    );

    buttonByText('History').click();
    await waitFor(() =>
      expect(document.querySelector('.content')?.textContent).toContain(
        'No selected author'
      )
    );

    save.reject(new Error('Settings save unavailable.'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.content')?.textContent).toContain(
      'No selected author'
    );
    expect(document.querySelector('.content > .error')).toBeNull();
  });

  it('does not let a stale settings-save rejection replace a newer Admin view', async () => {
    devvitClient.mode = 'expanded';
    const save = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('settings')));
      }
      if (url === '/api/settings' && init?.method === 'POST') {
        return save.promise;
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(() => buttonByText('Save admin changes')).not.toThrow());

    buttonByText('Save admin changes').click();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/settings' &&
            (init as RequestInit).method === 'POST'
        )
      ).toBe(true)
    );

    buttonByText('History').click();
    await waitFor(() =>
      expect(document.querySelector('.content')?.textContent).toContain(
        'No selected author'
      )
    );
    buttonByText('Admin').click();
    await waitFor(() => expect(() => buttonByText('Save admin changes')).not.toThrow());

    save.reject(new Error('Settings save unavailable.'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.content')?.textContent).toContain('Admin');
    expect(document.querySelector('.content > .error')).toBeNull();
  });

  it('saves Rules JSON using its imported revision and config', async () => {
    devvitClient.mode = 'expanded';
    const importedConfig = {
      schemaVersion: 1,
      revision: 7,
      rules: [{ id: 'rule-7', label: 'Imported rule', enabled: true }],
    };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('settings')));
      }
      if (url === '/api/settings' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            status: 'saved',
            config: { ...settingsResponse.config, ...importedConfig },
          })
        );
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() =>
      expect(document.querySelector('.config-json-editor')).not.toBeNull()
    );

    const editor = document.querySelector<HTMLTextAreaElement>('.config-json-editor')!;
    editor.value = JSON.stringify(importedConfig);
    buttonByText('Save imported JSON').click();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url) === '/api/settings' &&
            (init as RequestInit).method === 'POST' &&
            JSON.parse(String((init as RequestInit).body)).revision === 7 &&
            JSON.parse(String((init as RequestInit).body)).config.rules[0].id ===
              'rule-7'
        )
      ).toBe(true)
    );
  });

  it('recalculates a user total from the Admin lookup form', async () => {
    devvitClient.mode = 'expanded';
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('settings')));
      }
      if (url === '/api/recalculate-user-total' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ userKey: 'id:t2_user', activeTotal: 4 }));
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(() => buttonByText('Recalculate')).not.toThrow());

    document.querySelector<HTMLInputElement>('.settings-form input')!.value = 'id:t2_user';
    buttonByText('Recalculate').click();

    await waitFor(() =>
      expect(document.body.textContent).toContain('id:t2_user: active total 4.')
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/api/recalculate-user-total' &&
          JSON.parse(String((init as RequestInit).body)).userKey === 'id:t2_user'
      )
    ).toBe(true);
  });

  it('runs ledger cleanup from Admin maintenance', async () => {
    devvitClient.mode = 'expanded';
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('settings')));
      }
      if (url === '/api/cleanup-ledger' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ scanned: 5, deleted: 2, retentionDays: 90, maxEntries: 100 })
        );
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(() => buttonByText('Run cleanup')).not.toThrow());

    buttonByText('Run cleanup').click();
    await waitFor(() =>
      expect(document.body.textContent).toContain('Cleanup scanned 5, deleted 2.')
    );
  });

  it('loads settings audit records into Admin maintenance', async () => {
    devvitClient.mode = 'expanded';
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/bootstrap') {
        return Promise.resolve(jsonResponse(expandedBootstrap('settings')));
      }
      if (url === '/api/settings/audit') {
        return Promise.resolve(
          jsonResponse({
            records: [
              {
                moderatorUsername: 'mod-a',
                timestampMs: 0,
                changedFields: ['rules'],
                beforeHash: 'beforehash123456',
                afterHash: 'afterhash123456',
              },
            ],
          })
        );
      }
      return Promise.resolve(jsonResponse({ ...settingsResponse, canManage: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('./dashboard');
    await waitFor(() => expect(() => buttonByText('Load audit')).not.toThrow());

    buttonByText('Load audit').click();
    await waitFor(() =>
      expect(document.body.textContent).toContain('u/mod-a')
    );
    expect(document.body.textContent).toContain('rules');
  });
});
