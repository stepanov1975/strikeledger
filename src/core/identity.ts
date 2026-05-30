export const normalizeUsername = (username: string): string =>
  username.trim().replace(/^u\//i, '').toLowerCase();

export const getUserKey = (identity: {
  userId?: string;
  username?: string;
}): string | null => {
  if (identity.userId?.trim()) {
    return `id:${identity.userId.trim()}`;
  }

  if (!identity.username) {
    return null;
  }

  const username = normalizeUsername(identity.username);
  if (!username || username === '[deleted]') {
    return null;
  }

  return `name:${username}`;
};
