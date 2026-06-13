import { describe, expect, it } from 'vitest';
import {
  resolveDashboardLaunch,
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

  it('prefers pending bootstrap view and context over URL hints', () => {
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
      view: 'profile',
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

  it('keeps selected target context only for history and profile tabs', () => {
    expect(shouldKeepDashboardContext('history')).toBe(true);
    expect(shouldKeepDashboardContext('profile')).toBe(true);
    expect(shouldKeepDashboardContext('settings')).toBe(false);
  });
});
