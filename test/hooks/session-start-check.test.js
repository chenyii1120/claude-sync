'use strict';

// F-01 hook smoke tests: run hooks/session-start-check.js as a real
// subprocess and check its stdout contract + silent-failure behavior.
// These hooks still read process.env.HOME directly (C-08 refactor for the
// hooks themselves is a later task) so setup here manipulates HOME, not
// CLAUDE_SYNC_HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, writeAndCommit, git } = require('../helpers/git.js');
const { runHook } = require('../helpers/run-hook.js');

function claudeSyncDirs(homeDir) {
  return {
    claudeDir: path.join(homeDir, '.claude'),
    syncDir: path.join(homeDir, '.claude', 'sync'),
    repoDir: path.join(homeDir, '.claude', 'sync', 'repo'),
    configPath: path.join(homeDir, '.claude', 'sync', 'config.json'),
  };
}

test('session-start-check.js: exits silently when sync is not initialized', () => {
  const homeDir = mkTmpDir('claude-sync-hook-start-uninit-');
  try {
    const result = runHook('hooks/session-start-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    rmDir(homeDir);
  }
});

test('session-start-check.js: prints nothing when local is already up to date with origin/main', () => {
  const root = mkTmpDir('claude-sync-hook-start-uptodate-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const seed = cloneWithIdentity(remoteDir, path.join(root, 'seed'));
    writeAndCommit(seed, 'global/settings.json', '{}', 'seed');
    git(seed, ['push', 'origin', 'main']);

    const homeDir = path.join(root, 'home');
    const { repoDir, configPath } = claudeSyncDirs(homeDir);
    cloneWithIdentity(remoteDir, repoDir);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ repo: remoteDir }));

    const result = runHook('hooks/session-start-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally {
    rmDir(root);
  }
});

test('session-start-check.js: reports the remote update count as SessionStart hook JSON when behind', () => {
  const root = mkTmpDir('claude-sync-hook-start-behind-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const seed = cloneWithIdentity(remoteDir, path.join(root, 'seed'));
    writeAndCommit(seed, 'global/settings.json', '{}', 'first');
    git(seed, ['push', 'origin', 'main']);

    const homeDir = path.join(root, 'home');
    const { repoDir, configPath } = claudeSyncDirs(homeDir);
    cloneWithIdentity(remoteDir, repoDir); // local sits at "first"

    // Advance the remote by two more commits after the local clone was made.
    writeAndCommit(seed, 'global/settings.json', '{"a":1}', 'second');
    writeAndCommit(seed, 'global/settings.json', '{"a":2}', 'third');
    git(seed, ['push', 'origin', 'main']);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ repo: remoteDir }));

    const result = runHook('hooks/session-start-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.notEqual(result.stdout, '');

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(parsed.hookSpecificOutput.additionalContext, /2 個更新/);
  } finally {
    rmDir(root);
  }
});

test('session-start-check.js: fails silently (exit 0, no output) when sync/repo is not a valid git repo', () => {
  const homeDir = mkTmpDir('claude-sync-hook-start-corrupt-');
  try {
    const { repoDir, configPath } = claudeSyncDirs(homeDir);
    fs.mkdirSync(repoDir, { recursive: true }); // exists, but no .git inside
    fs.writeFileSync(path.join(repoDir, 'not-a-repo.txt'), 'oops');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ repo: 'file:///nonexistent' }));

    const result = runHook('hooks/session-start-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally {
    rmDir(homeDir);
  }
});
