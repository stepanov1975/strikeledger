import assert from 'node:assert/strict';
import test from 'node:test';

test('runs verification and one versioned publish through Node', async () => {
  let runLaunch;
  try {
    ({ runLaunch } = await import('./launch-runner.mjs'));
  } catch {
    assert.fail('launch runner module is missing');
  }

  const calls = [];
  runLaunch({
    executeFile: (file, args, options) => {
      calls.push({ file, args, options });
    },
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    npmCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    devvitCliPath: 'C:\\repo\\node_modules\\devvit\\bin\\devvit.js',
    version: '1.3.3',
  });

  assert.deepEqual(
    calls.map(({ file, args }) => ({ file, args })),
    [
      {
        file: 'C:\\Program Files\\nodejs\\node.exe',
        args: [
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
          'run',
          'type-check',
        ],
      },
      {
        file: 'C:\\Program Files\\nodejs\\node.exe',
        args: [
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
          'run',
          'lint',
        ],
      },
      {
        file: 'C:\\Program Files\\nodejs\\node.exe',
        args: [
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
          'run',
          'test',
        ],
      },
      {
        file: 'C:\\Program Files\\nodejs\\node.exe',
        args: [
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
          'run',
          'build',
        ],
      },
      {
        file: 'C:\\Program Files\\nodejs\\node.exe',
        args: [
          'C:\\repo\\node_modules\\devvit\\bin\\devvit.js',
          'publish',
          '--version',
          '1.3.3',
        ],
      },
    ]
  );
  assert.ok(calls.every(({ options }) => options.shell === undefined));
  assert.equal(
    calls.filter(({ args }) => args.includes('publish')).length,
    1
  );
  assert.ok(
    calls.every(
      ({ args }) => !args.includes('upload') && !args.includes('deploy')
    )
  );
});
