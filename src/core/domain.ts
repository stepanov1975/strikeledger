export const SCHEMA_VERSION = 1;

export const STRIKE_ACTIONS = ['warn', 'warn_remove', 'warn_nsfw'] as const;

export type StrikeAction = (typeof STRIKE_ACTIONS)[number];

export type TargetKind = 'post' | 'comment';

export type LedgerStatus = 'pending' | 'succeeded' | 'partial' | 'reversed';

export type SideEffectStatus = 'pending' | 'skipped' | 'succeeded' | 'failed';

export type PublicCommentOptionStatus = {
  distinguish?: SideEffectStatus;
  sticky?: SideEffectStatus;
  lock?: SideEffectStatus;
};

export type SideEffects = {
  publicComment: SideEffectStatus;
  publicCommentOptions?: PublicCommentOptionStatus;
  remove: SideEffectStatus;
  markNsfw: SideEffectStatus;
  modNote: SideEffectStatus;
  userNotice: SideEffectStatus;
  reversalModNote: SideEffectStatus;
  reversalUserNotice: SideEffectStatus;
};

export type RulePointOverrides = Partial<Record<StrikeAction, number>>;

export type RuleConfig = {
  id: string;
  label: string;
  publicTemplate?: string;
  internalNoteTemplate?: string;
  pointOverrides?: RulePointOverrides;
  enabled: boolean;
};

export type ActionPointDefaults = Record<StrikeAction, number>;

export type CommentStickySettings = Record<StrikeAction, boolean>;

export type StrikeLedgerConfig = {
  schemaVersion: typeof SCHEMA_VERSION;
  revision: number;
  rules: RuleConfig[];
  actionPoints: ActionPointDefaults;
  decayAmount: number;
  decayIntervalDays: number;
  postScoreWindowDays: number;
  defaultPublicCommentTemplate: string;
  defaultPrivateUserNoticeTemplate: string;
  defaultZeroPointPrivateUserNoticeTemplate: string;
  defaultNativeModNoteTemplate: string;
  defaultZeroPointNativeModNoteTemplate: string;
  userNoticesEnabled: boolean;
  distinguishAppComments: boolean;
  stickyAppComments: CommentStickySettings;
  lockAppComments: boolean;
  nativeModNotesEnabled: boolean;
  reversalNativeModNotesEnabled: boolean;
};

export type LedgerEntry = {
  schemaVersion: typeof SCHEMA_VERSION;
  entryId: string;
  subredditName: string;
  userId?: string;
  username: string;
  userKey: string;
  targetId: string;
  targetKind: TargetKind;
  targetPermalink: string;
  action: StrikeAction;
  ruleId: string;
  ruleLabel: string;
  publicCommentOverrideUsed: boolean;
  originalPoints: number;
  moderatorUsername: string;
  createdAtMs: number;
  status: LedgerStatus;
  duplicateKey: string;
  moderatorRetryKey: string;
  idempotencyInputs: Record<string, string | number | boolean>;
  formNonce: string;
  sideEffects: SideEffects;
  publicCommentId?: string;
  publicCorrectionCommentId?: string;
  modNoteId?: string;
  userNoticeId?: string;
  reversalModNoteId?: string;
  reversalUserNoticeId?: string;
  moderatorNote?: string;
  reversedAtMs?: number;
  reversedBy?: string;
  reversalReason?: string;
  reversalNote?: string;
};

export const ACTION_LABELS: Record<StrikeAction, string> = {
  warn: 'Warn',
  warn_remove: 'Warn and remove',
  warn_nsfw: 'Warn and mark NSFW',
};

export const EMPTY_SIDE_EFFECTS: SideEffects = {
  publicComment: 'pending',
  remove: 'skipped',
  markNsfw: 'skipped',
  modNote: 'skipped',
  userNotice: 'skipped',
  reversalModNote: 'skipped',
  reversalUserNotice: 'skipped',
};
