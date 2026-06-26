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

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
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
    revision: 1,
    decayAmount: 1,
    decayIntervalDays: 30,
    userNoticesEnabled: true,
    nativeModNotesEnabled: true,
    rules: [],
  },
};

describe('dashboard startup', () => {
  beforeEach(() => {
    vi.resetModules();
    devvitClient.mode = 'inline';
    devvitClient.listeners.length = 0;
    devvitClient.requestExpandedMode.mockReset();
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
});
