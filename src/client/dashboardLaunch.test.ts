import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_ENTRYPOINT,
  EXPANDED_DASHBOARD_VIEWS,
  formatInlineRemovalSummary,
  getDashboardModeContent,
  resolveDashboardLaunch,
  shouldRefreshDashboardBootstrap,
  shouldKeepDashboardContext,
} from './dashboardLaunch';

const bootstrap = {
  view: 'settings' as const,
  subredditName: 'testsub',
  moderatorUsername: 'mod-a',
};

describe('resolveDashboardLaunch', () => {
  it('uses URL view and context token when no pending bootstrap exists', () => {
    expect(
      resolveDashboardLaunch(
        { ...bootstrap, hasPendingBootstrap: false },
        new URLSearchParams('view=history&contextToken=view-token')
      )
    ).toEqual({
      view: 'history',
      contextToken: 'view-token',
    });
  });

  it('opens pending profile launches as expanded history with the same context', () => {
    expect(
      resolveDashboardLaunch(
        {
          ...bootstrap,
          view: 'profile',
          contextToken: 'bootstrap-token',
          hasPendingBootstrap: true,
        },
        new URLSearchParams('view=history&contextToken=url-token')
      )
    ).toEqual({
      view: 'history',
      contextToken: 'bootstrap-token',
    });
  });

  it('ignores invalid URL views', () => {
    expect(
      resolveDashboardLaunch(
        { ...bootstrap, hasPendingBootstrap: false },
        new URLSearchParams('view=reports&contextToken=view-token')
      )
    ).toEqual({
      view: 'settings',
    });
  });

  it('ignores profile URL hints because profile renders only inline', () => {
    expect(
      resolveDashboardLaunch(
        { ...bootstrap, hasPendingBootstrap: false },
        new URLSearchParams('view=profile&contextToken=view-token')
      )
    ).toEqual({
      view: 'settings',
    });
  });

  it('keeps limited bootstrap responses out of protected views', () => {
    expect(
      resolveDashboardLaunch(
        {
          ...bootstrap,
          view: 'limited',
          currentUsername: 'viewer-a',
          hasPendingBootstrap: false,
        },
        new URLSearchParams('view=history&contextToken=view-token')
      )
    ).toEqual({
      view: 'limited',
    });
  });

  it('keeps selected target context only for expanded history', () => {
    expect(shouldKeepDashboardContext('history')).toBe(true);
    expect(shouldKeepDashboardContext('profile')).toBe(false);
    expect(shouldKeepDashboardContext('settings')).toBe(false);
  });

  it('uses the dashboard entrypoint for expanded mode', () => {
    expect(DASHBOARD_ENTRYPOINT).toBe('dashboard');
  });

  it('keeps expanded dashboard tabs to history and admin settings', () => {
    expect(EXPANDED_DASHBOARD_VIEWS).toEqual(['history', 'settings']);
  });

  it('maps webview modes to launcher or dashboard content', () => {
    expect(getDashboardModeContent('expanded')).toBe('dashboard');
    expect(getDashboardModeContent('inline')).toBe('launcher');
  });

  it('refreshes bootstrap only when entering expanded mode or missing bootstrap', () => {
    expect(
      shouldRefreshDashboardBootstrap({
        mode: 'expanded',
        previousMode: 'inline',
        hasBootstrap: false,
      })
    ).toBe(true);
    expect(
      shouldRefreshDashboardBootstrap({
        mode: 'expanded',
        previousMode: 'expanded',
        hasBootstrap: true,
      })
    ).toBe(false);
    expect(
      shouldRefreshDashboardBootstrap({
        mode: 'expanded',
        previousMode: 'expanded',
        hasBootstrap: false,
      })
    ).toBe(true);
    expect(
      shouldRefreshDashboardBootstrap({
        mode: 'inline',
        previousMode: 'expanded',
        hasBootstrap: true,
      })
    ).toBe(false);
  });

  it('keeps inline removal summaries bounded', () => {
    const summary = formatInlineRemovalSummary({
      'A very long moderator rule label that would overflow the inline preview without truncation':
        2,
      Harassment: 1,
      'Off topic': 3,
      'Personal info': 1,
    });

    expect(summary).toMatch(/^Removals: /);
    expect(summary).toContain('...: 2');
    expect(summary).toContain('Harassment: 1');
    expect(summary).toContain('Off topic: 3');
    expect(summary).toContain('+1 more.');
    expect(summary).not.toContain('Personal info');
    expect(summary.match(/: \d/g)).toHaveLength(3);
    expect(summary.length).toBeLessThanOrEqual(140);
  });
});
