'use strict';

// Runs one of the hooks/*.js scripts as a real child process, the way
// Claude Code itself invokes them. Hooks resolve their home directory via
// os.homedir() (falling back from CLAUDE_SYNC_HOME when set) — os.homedir()
// reads $HOME on POSIX, so pointing HOME at an isolated tmpdir for the child
// isolates it correctly. We also strip CLAUDE_SYNC_HOME so it can't leak in
// from a parent test that used loadEngine() and leave the child resolving a
// different path than the fixture it was given.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function runHook(hookRelPath, homeDir, extraEnv = {}, options = {}) {
  const env = { ...process.env, ...extraEnv, HOME: homeDir };
  delete env.CLAUDE_SYNC_HOME;
  return spawnSync(process.execPath, [path.join(REPO_ROOT, hookRelPath)], {
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 15000,
  });
}

module.exports = { runHook, REPO_ROOT };
