import type { RedisStore } from './redisStore';

export const POST_SCORE_LOOKUP_LIMIT = 1000;
export const POST_SCORE_PAGE_SIZE = 100;
export const POST_SCORE_SUMMARY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const POST_SCORE_CACHE_SCHEMA_VERSION = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PostScoreSummary = {
  averagePostScore: number | null;
  postScorePostCount: number;
  postScoreWindowDays: number;
};

type PostScorePost = {
  subredditName: string;
  createdAt: Date;
  score: number;
};

export type PostScoreClient = {
  getPostsByUser(options: {
    username: string;
    sort: 'new';
    limit: number;
    pageSize: number;
  }): AsyncIterable<PostScorePost>;
};

type StoredPostScoreSummary = {
  schemaVersion: typeof POST_SCORE_CACHE_SCHEMA_VERSION;
  subredditName: string;
  username: string;
  calculatedAtMs: number;
  expiresAtMs: number;
  summary: PostScoreSummary;
};

type PostScoreLookupFailureHandler = (error: unknown) => void;

const normalizeSubredditName = (subredditName: string): string =>
  subredditName.trim().toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const emptyPostScoreSummary = (windowDays: number): PostScoreSummary => ({
  averagePostScore: null,
  postScorePostCount: 0,
  postScoreWindowDays: windowDays,
});

export const getPostScoreSummaryKey = (userKey: string): string =>
  `user:${userKey}:post_score_summary`;

export const getPostRateKey = (userKey: string): string =>
  `user:${userKey}:post_rate`;

const isPostScoreSummary = (value: unknown): value is PostScoreSummary => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (typeof value.averagePostScore === 'number' ||
      value.averagePostScore === null) &&
    typeof value.postScorePostCount === 'number' &&
    Number.isInteger(value.postScorePostCount) &&
    value.postScorePostCount >= 0 &&
    typeof value.postScoreWindowDays === 'number' &&
    Number.isInteger(value.postScoreWindowDays)
  );
};

const parseStoredPostScoreSummary = (
  raw: string
): StoredPostScoreSummary | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !isPostScoreSummary(parsed.summary)) {
    return null;
  }

  if (
    parsed.schemaVersion !== POST_SCORE_CACHE_SCHEMA_VERSION ||
    typeof parsed.subredditName !== 'string' ||
    typeof parsed.username !== 'string' ||
    typeof parsed.calculatedAtMs !== 'number' ||
    typeof parsed.expiresAtMs !== 'number'
  ) {
    return null;
  }

  return {
    schemaVersion: POST_SCORE_CACHE_SCHEMA_VERSION,
    subredditName: parsed.subredditName,
    username: parsed.username,
    calculatedAtMs: parsed.calculatedAtMs,
    expiresAtMs: parsed.expiresAtMs,
    summary: parsed.summary,
  };
};

export const readCachedPostScoreSummary = async (
  store: RedisStore,
  userKey: string,
  subredditName: string,
  windowDays: number,
  nowMs: number
): Promise<PostScoreSummary | null> => {
  const raw = await store.get(getPostScoreSummaryKey(userKey));
  if (raw === null) {
    return null;
  }

  const stored = parseStoredPostScoreSummary(raw);
  if (!stored) {
    return null;
  }

  if (
    normalizeSubredditName(stored.subredditName) !==
      normalizeSubredditName(subredditName) ||
    stored.summary.postScoreWindowDays !== windowDays ||
    stored.expiresAtMs <= nowMs
  ) {
    return null;
  }

  return stored.summary;
};

export const savePostScoreSummary = async (
  store: RedisStore,
  userKey: string,
  subredditName: string,
  username: string,
  summary: PostScoreSummary,
  nowMs: number
): Promise<void> => {
  const expiresAtMs = nowMs + POST_SCORE_SUMMARY_CACHE_TTL_MS;
  const record: StoredPostScoreSummary = {
    schemaVersion: POST_SCORE_CACHE_SCHEMA_VERSION,
    subredditName,
    username,
    calculatedAtMs: nowMs,
    expiresAtMs,
    summary,
  };

  await store.set(getPostScoreSummaryKey(userKey), JSON.stringify(record), {
    expiresAtMs,
  });
};

export const summarizeUserPostScores = async (
  client: PostScoreClient,
  subredditName: string,
  username: string,
  windowDays: number,
  nowMs: number
): Promise<PostScoreSummary> => {
  const cutoffMs = nowMs - windowDays * MS_PER_DAY;
  let totalScore = 0;
  let postCount = 0;

  const posts = client.getPostsByUser({
    username,
    sort: 'new',
    limit: POST_SCORE_LOOKUP_LIMIT,
    pageSize: POST_SCORE_PAGE_SIZE,
  });

  for await (const post of posts) {
    if (post.createdAt.getTime() < cutoffMs) {
      break;
    }

    if (
      normalizeSubredditName(post.subredditName) !==
      normalizeSubredditName(subredditName)
    ) {
      continue;
    }

    totalScore += post.score;
    postCount += 1;
  }

  return {
    averagePostScore: postCount > 0 ? totalScore / postCount : null,
    postScorePostCount: postCount,
    postScoreWindowDays: windowDays,
  };
};

export const refreshPostScoreSummary = async (options: {
  store: RedisStore;
  client: PostScoreClient;
  userKey: string;
  username: string | null;
  subredditName: string;
  windowDays: number;
  nowMs: number;
}): Promise<PostScoreSummary> => {
  if (!options.username) {
    return emptyPostScoreSummary(options.windowDays);
  }

  const summary = await summarizeUserPostScores(
    options.client,
    options.subredditName,
    options.username,
    options.windowDays,
    options.nowMs
  );
  await savePostScoreSummary(
    options.store,
    options.userKey,
    options.subredditName,
    options.username,
    summary,
    options.nowMs
  );

  return summary;
};

export const getCachedOrLivePostScoreSummary = async (options: {
  store: RedisStore;
  client: PostScoreClient;
  userKey: string;
  username: string | null;
  subredditName: string;
  windowDays: number;
  nowMs: number;
  onLookupFailure?: PostScoreLookupFailureHandler;
}): Promise<PostScoreSummary> => {
  if (!options.username) {
    return emptyPostScoreSummary(options.windowDays);
  }

  const cachedSummary = await readCachedPostScoreSummary(
    options.store,
    options.userKey,
    options.subredditName,
    options.windowDays,
    options.nowMs
  );
  if (cachedSummary) {
    return cachedSummary;
  }

  try {
    return await refreshPostScoreSummary(options);
  } catch (error) {
    options.onLookupFailure?.(error);
    return emptyPostScoreSummary(options.windowDays);
  }
};

export const recordPostSubmission = async (
  store: RedisStore,
  userKey: string,
  postId: string,
  submittedAtMs: number
): Promise<void> => {
  await store.zAdd(getPostRateKey(userKey), {
    member: postId,
    score: submittedAtMs,
  });
};
