'use strict';

// F-01 integration scenario: a second machine joins a sync repo that
// already has content pushed by a first machine. init() should NOT push
// (repo already has content), and the following pull() should be a
// "first-pull" overlay: remote wins, and fields missing locally are NOT
// treated as deletions (see firstPullPending handling in pull()).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, writeAndCommit, git } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('init() on an existing repo does not push, and the first pull() overlays remote without deleting local-only keys', () => {
  const root = mkTmpDir('claude-sync-first-pull-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Seed the bare repo with content from a "first machine" — done with
    // plain git, not through the engine, to keep this test focused on the
    // second machine's init+pull behaviour.
    const seedClone = cloneWithIdentity(remoteDir, path.join(root, 'seed-clone'));
    writeAndCommit(
      seedClone,
      'global/settings.json',
      JSON.stringify({ theme: 'dark', model: 'sonnet' }, null, 2),
      'seed initial settings',
    );
    git(seedClone, ['push', 'origin', 'main']);

    // Second machine: local ~/.claude already has a machine-local-only key
    // that must survive the first pull (forceRemote keeps local-only keys).
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { localOnly: true });

    const engine = loadEngine(claudeHome);
    const initResult = engine.init(remoteDir);

    assert.equal(initResult.hasContent, true, 'remote already had content, so init must not auto-push');
    const lastSyncAfterInit = engine.loadLastSync();
    assert.equal(lastSyncAfterInit.firstPullPending, true);

    const pullResult = engine.pull();

    assert.equal(pullResult.pulled, true);
    assert.equal(pullResult.mode, 'first-pull');
    assert.equal(pullResult.settingsResult.changed, true);

    const mergedSettings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    assert.deepEqual(mergedSettings, { theme: 'dark', model: 'sonnet', localOnly: true });

    const lastSyncAfterPull = engine.loadLastSync();
    assert.equal(lastSyncAfterPull.firstPullPending, false);
    assert.equal(lastSyncAfterPull.action, 'pull');
  } finally {
    rmDir(root);
  }
});
