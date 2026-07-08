'use strict';

// C-02 TDD scenario 4: hooks/session-start-check.js must read config.json's
// `branch` field and use it for its fetch/rev-list calls -- previously it
// always ran `git fetch origin main`, which fails outright (silently, since
// the whole script is wrapped in try/catch) against a repo whose default
// branch isn't 'main', meaning the hook would NEVER report updates for such
// a repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, writeAndCommit, git } = require('../helpers/git.js');
const { runHook } = require('../helpers/run-hook.js');

function claudeSyncDirs(homeDir) {
  return {
    repoDir: path.join(homeDir, '.claude', 'sync', 'repo'),
    configPath: path.join(homeDir, '.claude', 'sync', 'config.json'),
  };
}

test('session-start-check.js: reports remote updates on a "master"-default repo by reading config.json\'s branch field (C-02)', () => {
  const root = mkTmpDir('claude-sync-hook-branch-master-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'), 'master');
    const seed = cloneWithIdentity(remoteDir, path.join(root, 'seed'));
    writeAndCommit(seed, 'global/settings.json', '{}', 'first');
    git(seed, ['push', 'origin', 'master']);

    const homeDir = path.join(root, 'home');
    const { repoDir, configPath } = claudeSyncDirs(homeDir);
    cloneWithIdentity(remoteDir, repoDir); // local sits at "first"

    // Advance the remote by two more commits after the local clone was made.
    writeAndCommit(seed, 'global/settings.json', '{"a":1}', 'second');
    writeAndCommit(seed, 'global/settings.json', '{"a":2}', 'third');
    git(seed, ['push', 'origin', 'master']);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ repo: remoteDir, branch: 'master' }));

    const result = runHook('hooks/session-start-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.notEqual(result.stdout, '', 'hook must not silently no-op just because the branch is not "main"');

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(parsed.hookSpecificOutput.additionalContext, /2 個更新/);
  } finally {
    rmDir(root);
  }
});

test('session-start-check.js: falls back to "main" (and does not crash) when config.json has no branch field, on a real "main" repo (C-02 back-compat)', () => {
  const root = mkTmpDir('claude-sync-hook-branch-backcompat-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git')); // default 'main'
    const seed = cloneWithIdentity(remoteDir, path.join(root, 'seed'));
    writeAndCommit(seed, 'global/settings.json', '{}', 'first');
    git(seed, ['push', 'origin', 'main']);

    const homeDir = path.join(root, 'home');
    const { repoDir, configPath } = claudeSyncDirs(homeDir);
    cloneWithIdentity(remoteDir, repoDir);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // No `branch` field -- exactly what a pre-C-02 config.json looks like.
    fs.writeFileSync(configPath, JSON.stringify({ repo: remoteDir }));

    const result = runHook('hooks/session-start-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally {
    rmDir(root);
  }
});

test('session-start-check.js: ignores a malformed branch value in config.json and falls back to "main" instead of shell-splicing it (C-02 hardening)', () => {
  const root = mkTmpDir('claude-sync-hook-branch-malformed-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git')); // default 'main'
    const seed = cloneWithIdentity(remoteDir, path.join(root, 'seed'));
    writeAndCommit(seed, 'global/settings.json', '{}', 'first');
    git(seed, ['push', 'origin', 'main']);

    const homeDir = path.join(root, 'home');
    const { repoDir, configPath } = claudeSyncDirs(homeDir);
    cloneWithIdentity(remoteDir, repoDir);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // A branch value with shell metacharacters must never reach execSync's
    // command string -- the conservative charset check must reject it and
    // fall back to 'main', which is the repo's real branch here, so the hook
    // still succeeds silently (exit 0, no output since nothing is behind).
    fs.writeFileSync(configPath, JSON.stringify({ repo: remoteDir, branch: 'main; touch pwned' }));

    const result = runHook('hooks/session-start-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(homeDir, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false);
  } finally {
    rmDir(root);
  }
});
