'use strict';

// Codex F#7: scanForSecrets (B-04) used to run AFTER commit+push, so
// secretWarnings reported a key that was ALREADY in remote history. The user
// decided secrets should still be allowed to sync (e.g. a private repo) BUT
// the push must be GATED -- scan BEFORE committing/pushing, and require an
// explicit confirmSecrets to proceed. Mirrors push-pull-roundtrip.test.js's
// single-machine push setup and push-secret-warning.test.js's secret-flagging
// scenarios, but asserts the PRE-push gate itself: nothing reaches the remote
// (or even gets committed locally) without confirmation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, git } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');
const { runHook } = require('../helpers/run-hook.js');

test('push(): gates on a suspected secret -- returns secrets-detected and pushes/commits nothing', () => {
  const root = mkTmpDir('claude-sync-secretgate-blocked-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const claudeHome = path.join(root, 'home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir); // first machine: init pushes the initial commit.

    const localRepoDir = path.join(claudeHome, 'sync', 'repo');
    const remoteHeadBefore = git(remoteDir, ['rev-parse', 'HEAD']);
    const localHeadBefore = git(localRepoDir, ['rev-parse', 'HEAD']);

    // A real change that also introduces a likely-secret env entry.
    const settingsPath = path.join(claudeHome, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'light', env: { ANTHROPIC_API_KEY: 'sk-xxxx' } }, null, 2),
    );

    const result = engine.push();
    assert.equal(result.pushed, false);
    assert.equal(result.reason, 'secrets-detected');
    assert.ok(Array.isArray(result.secretWarnings));
    assert.ok(result.secretWarnings.some((w) => w.path === 'env.ANTHROPIC_API_KEY'));

    // Nothing was pushed: the bare remote has no new commit...
    const remoteHeadAfter = git(remoteDir, ['rev-parse', 'HEAD']);
    assert.equal(remoteHeadAfter, remoteHeadBefore, 'remote HEAD must be unchanged -- nothing was pushed');

    // ...and nothing was even committed locally (gate runs before add/commit).
    const localHeadAfter = git(localRepoDir, ['rev-parse', 'HEAD']);
    assert.equal(localHeadAfter, localHeadBefore, 'local repo must have no new commit -- gate runs before commit');
  } finally {
    rmDir(root);
  }
});

test('push({ confirmSecrets: true }): proceeds despite a suspected secret -- pushes and advances the remote', () => {
  const root = mkTmpDir('claude-sync-secretgate-confirmed-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const claudeHome = path.join(root, 'home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    const remoteHeadBefore = git(remoteDir, ['rev-parse', 'HEAD']);

    const settingsPath = path.join(claudeHome, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'light', env: { ANTHROPIC_API_KEY: 'sk-xxxx' } }, null, 2),
    );

    const result = engine.push({ confirmSecrets: true });
    assert.equal(result.pushed, true);
    assert.ok(Array.isArray(result.secretWarnings));
    assert.ok(result.secretWarnings.some((w) => w.path === 'env.ANTHROPIC_API_KEY'));

    const remoteHeadAfter = git(remoteDir, ['rev-parse', 'HEAD']);
    assert.notEqual(remoteHeadAfter, remoteHeadBefore, 'remote HEAD must advance once confirmed');
  } finally {
    rmDir(root);
  }
});

test('push(): no secret-looking env -- pushes normally with empty secretWarnings (unchanged behavior)', () => {
  const root = mkTmpDir('claude-sync-secretgate-clean-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const claudeHome = path.join(root, 'home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    const remoteHeadBefore = git(remoteDir, ['rev-parse', 'HEAD']);

    const settingsPath = path.join(claudeHome, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'light', env: { EDITOR: 'vim' } }, null, 2),
    );

    const result = engine.push();
    assert.equal(result.pushed, true);
    assert.deepEqual(result.secretWarnings, []);

    const remoteHeadAfter = git(remoteDir, ['rev-parse', 'HEAD']);
    assert.notEqual(remoteHeadAfter, remoteHeadBefore, 'a normal push still advances the remote');
  } finally {
    rmDir(root);
  }
});

test('session-end-worker.js: autoPush respects the secrets gate -- does not auto-confirm, notices instead', () => {
  const root = mkTmpDir('claude-sync-secretgate-worker-');
  const bareHomeDir = mkTmpDir('claude-sync-secretgate-worker-home-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const syncHome = path.join(root, 'sync-home', '.claude');
    seedMinimalHome(syncHome, { theme: 'dark' });
    const engine = loadEngine(syncHome);
    engine.init(remoteDir);
    engine.saveConfig({ ...engine.loadConfig(), autoPush: true });

    const remoteHeadBefore = git(remoteDir, ['rev-parse', 'HEAD']);

    // A local change that looks like a secret -- autoPush must NOT push this
    // without an interactive confirmation, which the worker never supplies.
    fs.writeFileSync(
      path.join(syncHome, 'settings.json'),
      JSON.stringify({ theme: 'light', env: { ANTHROPIC_API_KEY: 'sk-xxxx' } }, null, 2),
    );

    const result = runHook(
      'hooks/session-end-check.js',
      bareHomeDir,
      { CLAUDE_SYNC_HOME: syncHome },
    );

    assert.equal(result.status, 0);
    assert.match(result.stderr, /自動推送暫停/, 'worker must report the paused auto-push, not push silently');
    assert.match(result.stderr, /env\.ANTHROPIC_API_KEY/, 'worker notice should name the flagged path');

    const remoteHeadAfter = git(remoteDir, ['rev-parse', 'HEAD']);
    assert.equal(remoteHeadAfter, remoteHeadBefore, 'autoPush must not push when the secrets gate trips');
  } finally {
    rmDir(root);
    rmDir(bareHomeDir);
  }
});
