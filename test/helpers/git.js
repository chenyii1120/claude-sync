'use strict';

// Minimal git helpers for integration tests. Every repo we touch directly
// (i.e. not through sync-engine's own ensureGitIdentity()) gets an explicit
// local user.name/user.email so tests pass on machines with no global git
// config.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

function setIdentity(cwd, name, email) {
  git(cwd, ['config', 'user.name', name || 'Test User']);
  git(cwd, ['config', 'user.email', email || 'test@example.com']);
}

// Create a local bare repo (acts as the "remote" in every test — no network
// involved). `branch` defaults to 'main'; C-02 branch-detection tests pass
// an explicit alternate name (e.g. 'master') so the scenario is deterministic
// regardless of the test machine's own git config (init.defaultBranch etc.).
function initBareRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--bare', '-b', branch || 'main']);
  return dir;
}

// Clone `remoteDir` into `dir` and configure a local identity.
function cloneWithIdentity(remoteDir, dir) {
  execFileSync('git', ['clone', remoteDir, dir], { stdio: 'pipe' });
  setIdentity(dir);
  return dir;
}

// Write `relPath` (creating parent dirs) inside `repoDir`, then add+commit.
function writeAndCommit(repoDir, relPath, content, message) {
  const full = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', message || `add ${relPath}`]);
}

// C-02: writes an isolated global gitconfig file (containing only the given
// key/value entries) and returns its path. Tests that need to simulate a
// particular `git config --global ...` value (e.g. init.defaultBranch)
// should point GIT_CONFIG_GLOBAL (git >= 2.32) at this file for the duration
// of the git operations that must observe it, instead of ever touching the
// developer's real ~/.gitconfig.
function isolatedGlobalGitConfig(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'isolated-gitconfig');
  fs.writeFileSync(configPath, '');
  for (const [key, value] of Object.entries(entries)) {
    execFileSync('git', ['config', '--file', configPath, key, value], { stdio: 'pipe' });
  }
  return configPath;
}

module.exports = {
  git, setIdentity, initBareRepo, cloneWithIdentity, writeAndCommit, isolatedGlobalGitConfig,
};
