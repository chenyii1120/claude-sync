'use strict';

// D-04 integration scenario: resolvePushConflicts() applies the user's chosen
// values for push-time field conflicts to the repo's settings.json (including
// dot-paths for nested-object conflicts), commits, pushes, and advances
// last-sync -- closing the gap where the old sync-push.md inline snippet
// hand-edited the repo but never called saveLastSync(), leaving
// last-sync.json's commitHash behind the new HEAD (next status/preview
// falsely reported "remote has updates").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

// Shared setup: init a fresh engine against an empty bare remote so init()
// itself pushes the seeded settings as the first commit -- gives every test
// a repo/global/settings.json plus a last-sync already equal to HEAD/origin
// HEAD to start from.
function initWithSettings(root, settings) {
  const remoteDir = initBareRepo(path.join(root, 'remote.git'));
  const claudeHome = path.join(root, 'claude-home');
  seedMinimalHome(claudeHome, settings);
  const engine = loadEngine(claudeHome);
  const initResult = engine.init(remoteDir);
  assert.equal(initResult.hasContent, false);
  return { engine, remoteDir };
}

function repoSettings(engine) {
  const fp = path.join(engine.REPO_DIR, 'global', 'settings.json');
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

test('resolvePushConflicts(): applies chosen value, commits+pushes, and advances last-sync to === repo HEAD === origin HEAD', () => {
  const root = mkTmpDir('claude-sync-resolve-push-conflicts-');
  try {
    const { engine } = initWithSettings(root, { theme: 'dark' });

    const result = engine.resolvePushConflicts({ theme: 'light' });
    assert.equal(result.pushed, true);
    assert.match(result.commitHash, /^[0-9a-f]{40}$/);

    assert.deepEqual(repoSettings(engine), { theme: 'light' });

    const repoHead = engine.gitExecFile(['rev-parse', 'HEAD']);
    const originHead = engine.gitExecFile(['rev-parse', `origin/${engine.getBranch()}`]);
    assert.equal(repoHead, result.commitHash);
    assert.equal(originHead, result.commitHash);

    // The core fix: last-sync now matches the new HEAD (the old inline
    // snippet left this pointing at the commit BEFORE the conflict-resolution
    // commit, so the next status/preview falsely saw "remote has updates").
    const lastSync = engine.loadLastSync();
    assert.equal(lastSync.commitHash, repoHead);
    assert.equal(lastSync.action, 'push');
    assert.equal(lastSync.firstPullPending, false);
  } finally {
    rmDir(root);
  }
});

test('resolvePushConflicts(): sets nested dot-path values and preserves sibling keys', () => {
  const root = mkTmpDir('claude-sync-resolve-push-conflicts-dotpath-');
  try {
    const { engine } = initWithSettings(root, {
      theme: 'dark',
      env: { API_KEY: 'key-abc', OTHER: 'unchanged' },
    });

    const result = engine.resolvePushConflicts({ 'env.API_KEY': 'key-xyz' });
    assert.equal(result.pushed, true);

    const settings = repoSettings(engine);
    assert.equal(settings.env.API_KEY, 'key-xyz');
    assert.equal(settings.env.OTHER, 'unchanged');
    assert.equal(settings.theme, 'dark');
  } finally {
    rmDir(root);
  }
});

test('resolvePushConflicts(): no-op when chosen values already match repo settings -- no new commit', () => {
  const root = mkTmpDir('claude-sync-resolve-push-conflicts-noop-');
  try {
    const { engine } = initWithSettings(root, { theme: 'dark' });
    const headBefore = engine.gitExecFile(['rev-parse', 'HEAD']);

    const result = engine.resolvePushConflicts({ theme: 'dark' });
    assert.deepEqual(result, { pushed: false, reason: 'no-changes' });

    const headAfter = engine.gitExecFile(['rev-parse', 'HEAD']);
    assert.equal(headAfter, headBefore);
  } finally {
    rmDir(root);
  }
});
