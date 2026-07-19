export const runLaunch = ({
  executeFile,
  nodePath,
  npmCliPath,
  devvitCliPath,
  version,
}) => {
  for (const script of ['type-check', 'lint', 'test', 'build']) {
    executeFile(nodePath, [npmCliPath, 'run', script], { stdio: 'inherit' });
  }

  executeFile(
    nodePath,
    [devvitCliPath, 'publish', '--version', version],
    { stdio: 'inherit' }
  );
};
