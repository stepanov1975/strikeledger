export const normalizeUsername = (username: string): string =>
  username.trim().replace(/^u\//i, '').toLowerCase();

const REDDIT_USER_ID_PATTERN = /^t2_.+$/;

const normalizeRedditUserId = (userId: string | undefined): string | null => {
  const trimmed = userId?.trim();
  return trimmed && REDDIT_USER_ID_PATTERN.test(trimmed) ? trimmed : null;
};

export const getUserKey = (identity: {
  userId?: string;
  username?: string;
}): string | null => {
  const userId = normalizeRedditUserId(identity.userId);
  if (userId) {
    return `id:${userId}`;
  }

  return null;
};

export const getTargetAuthorUserKey = (identity: {
  userKey?: string;
  authorId?: string;
  authorName?: string;
}): string | null => {
  const userKey = identity.userKey?.trim();
  if (userKey?.startsWith('id:')) {
    return getUserKey({ userId: userKey.slice(3) });
  }

  return getUserKey({
    ...(identity.authorId !== undefined ? { userId: identity.authorId } : {}),
  });
};
