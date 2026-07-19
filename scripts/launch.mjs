import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runLaunch } from './launch-runner.mjs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error('StrikeLedger launch must be run with npm run launch.');
}

runLaunch({
  executeFile: execFileSync,
  nodePath: process.execPath,
  npmCliPath,
  devvitCliPath: fileURLToPath(import.meta.resolve('devvit/bin/devvit')),
  version,
});
