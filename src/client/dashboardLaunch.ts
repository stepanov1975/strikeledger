export type DashboardView = 'history' | 'profile' | 'settings' | 'limited';

export type BootstrapResponse = {
  view: DashboardView;
  subredditName: string;
  currentUsername?: string;
  moderatorUsername?: string;
  hasPendingBootstrap: boolean;
  contextToken?: string;
};

export type DashboardLaunch = {
  view: DashboardView;
  contextToken?: string;
};

export type DashboardWebViewMode = 'inline' | 'expanded';

export const DASHBOARD_ENTRYPOINT = 'dashboard';

const isDashboardView = (
  value: string | null
): value is Exclude<DashboardView, 'limited'> =>
  value === 'history' || value === 'profile' || value === 'settings';

export const shouldKeepDashboardContext = (view: DashboardView): boolean =>
  view === 'history' || view === 'profile';

export const shouldLoadDashboardData = (
  mode: DashboardWebViewMode
): boolean => mode === 'expanded';

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
  if (bootstrap.view === 'limited') {
    return { view: 'limited' };
  }

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
