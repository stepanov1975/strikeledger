import { reddit } from '@devvit/web/server';
import type { User } from '@devvit/web/server';
import { logError } from '../core/logging';

export type ModeratorAccess = {
  username: string;
  canRead: boolean;
  canEnforce: boolean;
  canManage: boolean;
};

export const getModeratorAccess = async (
  subredditName: string
): Promise<ModeratorAccess | null> => {
  const user = await reddit.getCurrentUser();
  if (!user) {
    return null;
  }

  const permissions = await user.getModPermissionsForSubreddit(subredditName);
  const canManage = permissions.includes('all');
  const isModerator =
    permissions.length > 0 || (await isListedModerator(subredditName, user));

  return {
    username: user.username,
    canRead: canManage || isModerator,
    canEnforce: canManage || permissions.includes('posts'),
    canManage,
  };
};

const isListedModerator = async (
  subredditName: string,
  user: User
): Promise<boolean> => {
  try {
    const moderators = await reddit
      .getModerators({ subredditName, username: user.username })
      .all();

    return moderators.some(
      (moderator) =>
        moderator.username.toLowerCase() === user.username.toLowerCase()
    );
  } catch (error) {
    logError(
      'permission.moderator_lookup_failed',
      {
        subredditName,
        moderatorUsername: user.username,
      },
      error
    );
    return false;
  }
};
