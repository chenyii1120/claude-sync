'use strict';

// Runs one of the hooks/*.js scripts as a real child process, the way
// Claude Code itself invokes them. Both hooks currently read
// process.env.HOME directly (not CLAUDE_SYNC_HOME — that refactor is out of
// scope for F-01/C-08), so we point HOME at an isolated tmpdir for the
// child and strip CLAUDE_SYNC_HOME so it can't leak in from a parent test
// that used loadEngine() and leave the child resolving a different path
// than the fixture it was given.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function runHook(hookRelPath, homeDir, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, HOME: homeDir };
  delete env.CLAUDE_SYNC_HOME;
  return spawnSync(process.execPath, [path.join(REPO_ROOT, hookRelPath)], {
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
}

module.exports = { runHook, REPO_ROOT };
