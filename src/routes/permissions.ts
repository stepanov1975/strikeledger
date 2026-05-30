import { reddit } from '@devvit/web/server';

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

  return {
    username: user.username,
    canRead: canManage || permissions.length > 0,
    canEnforce: canManage || permissions.includes('posts'),
    canManage,
  };
};
