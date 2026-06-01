import type { StrikeLedgerConfig } from '../core/domain';

export type DashboardView = 'history' | 'profile' | 'settings';

export type BootstrapResponse = {
  view: DashboardView;
  subredditName: string;
  moderatorUsername: string;
  contextToken?: string;
};

export type ViewContext = {
  subredditName: string;
  userKey: string;
  targetId?: string;
  targetKind?: 'post' | 'comment';
  authorName?: string;
};

export type SideEffects = Record<string, string | Record<string, string>>;

export type LedgerEntryRow = {
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

export type HistoryResponse = {
  context: ViewContext;
  activeTotal: number;
  entries: LedgerEntryRow[];
  nextOffset: number | null;
};

export type ProfileResponse = {
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

export type ReverseResponse = {
  status: 'reversed' | 'already_reversed';
  activeTotal: number;
};

export type SettingsResponse = {
  subredditName: string;
  canManage: boolean;
  config: StrikeLedgerConfig;
};

export type AdminConfig = Pick<
  StrikeLedgerConfig,
  'schemaVersion' | 'revision' | 'rules'
>;

export type SettingsSaveResponse =
  | { status: 'saved'; config: StrikeLedgerConfig }
  | { status: 'conflict'; currentRevision: number }
  | {
      status: 'invalid';
      issues: Array<{ path: string; message: string }>;
    };

export type RecalculateResponse = {
  userKey: string;
  activeTotal: number;
};

export type ImportedRedditRule = {
  id: string;
  label: string;
  redditShortName: string;
  description: string;
  kind: string;
  violationReason: string;
  priority: number;
  enabled: true;
};

export type RedditRulesResponse = {
  subredditName: string;
  rules: ImportedRedditRule[];
};

export type RuleImportMode = 'add-missing' | 'replace' | 'sync-labels-order';

export type RuleEditorOptions = {
  isExisting: boolean;
};
