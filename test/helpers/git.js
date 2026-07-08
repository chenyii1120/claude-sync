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
// involved).
function initBareRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--bare', '-b', 'main']);
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

module.exports = { git, setIdentity, initBareRepo, cloneWithIdentity, writeAndCommit };
