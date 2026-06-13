export type DashboardView = 'history' | 'profile' | 'settings';

export type BootstrapResponse = {
  view: DashboardView;
  subredditName: string;
  moderatorUsername: string;
  hasPendingBootstrap: boolean;
  contextToken?: string;
};

export type DashboardLaunch = {
  view: DashboardView;
  contextToken?: string;
};

const isDashboardView = (value: string | null): value is DashboardView =>
  value === 'history' || value === 'profile' || value === 'settings';

const trimParam = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const resolveDashboardLaunch = (
  bootstrap: BootstrapResponse,
  params: URLSearchParams
): DashboardLaunch => {
  if (bootstrap.hasPendingBootstrap) {
    return {
      view: bootstrap.view,
      ...(bootstrap.contextToken !== undefined
        ? { contextToken: bootstrap.contextToken }
        : {}),
    };
  }

  const rawView = params.get('view');
  const view = isDashboardView(rawView) ? rawView : bootstrap.view;
  const contextToken = trimParam(params.get('contextToken'));

  return {
    view,
    ...(view !== 'settings' && contextToken ? { contextToken } : {}),
  };
};
