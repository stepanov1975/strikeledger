export type DashboardView = 'history' | 'profile' | 'settings' | 'limited';

export type ExpandedDashboardView = 'history' | 'settings';

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

export type DashboardModeContent = 'launcher' | 'dashboard';

export type DashboardBootstrapRefreshState = {
  mode: DashboardWebViewMode;
  previousMode: DashboardWebViewMode | null;
  hasBootstrap: boolean;
};

export const DASHBOARD_ENTRYPOINT = 'dashboard';

export const EXPANDED_DASHBOARD_VIEWS = [
  'history',
  'settings',
] as const satisfies readonly ExpandedDashboardView[];

const isDashboardView = (
  value: string | null
): value is ExpandedDashboardView =>
  value === 'history' || value === 'settings';

export const shouldKeepDashboardContext = (view: DashboardView): boolean =>
  view === 'history';

export const getDashboardModeContent = (
  mode: DashboardWebViewMode
): DashboardModeContent => (mode === 'expanded' ? 'dashboard' : 'launcher');

export const shouldRefreshDashboardBootstrap = ({
  mode,
  previousMode,
  hasBootstrap,
}: DashboardBootstrapRefreshState): boolean =>
  mode === 'expanded' && (!hasBootstrap || previousMode !== 'expanded');

export const formatInlineRemovalSummary = (
  removalsByRule: Record<string, number>,
  limit = 3
): string => {
  const entries = Object.entries(removalsByRule);
  if (entries.length === 0) {
    return 'No removals recorded.';
  }

  const visible = entries
    .slice(0, limit)
    .map(([rule, count]) => `${formatInlineRuleLabel(rule)}: ${count}`);
  const remaining = entries.length - visible.length;
  return `Removals: ${[
    ...visible,
    ...(remaining > 0 ? [`+${remaining} more`] : []),
  ].join(', ')}.`;
};

const formatInlineRuleLabel = (value: string, maxLength = 68): string => {
  if (value.length <= maxLength) {
    return value;
  }

  const truncated = value.slice(0, maxLength).trimEnd();
  const wordBoundary = truncated.lastIndexOf(' ');
  const visible =
    wordBoundary > Math.floor(maxLength * 0.7)
      ? truncated.slice(0, wordBoundary)
      : truncated;
  return `${visible}...`;
};

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
      view: bootstrap.view === 'profile' ? 'history' : bootstrap.view,
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
