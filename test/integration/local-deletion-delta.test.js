'use strict';

// F#3 (Codex review): getLocalDelta()'s user-config loop used to walk only
// listFilesRecursive(localDir) -- files that still exist locally -- so a
// file that was deleted locally (but never pushed) was invisible to the
// delta. isLocalDeltaEmpty() then read as "nothing local changed", pull()
// would run in safe/fast-forward mode, and importUserConfig()'s mirror copy
// would silently RESTORE the file the user deleted. Fix: union base-side
// files (listFilesAtRef(baseCommit, ...)) with local files and compare by
// presence AND content, so a local deletion counts as a divergence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('getLocalDelta(): a local deletion of a base-tracked user-config file is detected as divergence, and safe pull refuses to restore it (F#3)', () => {
  const root = mkTmpDir('claude-sync-f3-delete-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    fs.mkdirSync(path.join(claudeHome, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'commands', 'foo.md'), '# foo\n');
    fs.writeFileSync(path.join(claudeHome, 'commands', 'keep.md'), '# keep\n');

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir); // empty remote -> pushes initial state, sets last-sync base
    const lastSync = engine.loadLastSync();

    // Sanity: an unchanged tree must still report an empty delta (no
    // spurious deletions from the union-walk).
    const emptyDelta = engine.getLocalDelta(lastSync.commitHash);
    assert.deepEqual(emptyDelta.userConfigFiles, []);
    assert.equal(engine.isLocalDeltaEmpty(emptyDelta), true);

    // Delete a base-tracked file locally, WITHOUT pushing.
    fs.rmSync(path.join(claudeHome, 'commands', 'foo.md'));

    const delta = engine.getLocalDelta(lastSync.commitHash);
    assert.deepEqual(delta.userConfigFiles, [{ dir: 'commands', file: 'foo.md' }]);
    assert.equal(engine.isLocalDeltaEmpty(delta), false);

    // End-to-end: a safe pull must be REFUSED, not silently restore foo.md.
    const safeResult = engine.pull({ mode: 'safe' });
    assert.equal(safeResult.pulled, false);
    assert.equal(safeResult.reason, 'local-changes-pending');
    assert.equal(fs.existsSync(path.join(claudeHome, 'commands', 'foo.md')), false, 'safe pull must not resurrect the locally-deleted file');
    assert.equal(fs.existsSync(path.join(claudeHome, 'commands', 'keep.md')), true);
  } finally {
    rmDir(root);
  }
});

test('getLocalDelta(): a local content edit to a user-config file is still detected (no regression, F#3)', () => {
  const root = mkTmpDir('claude-sync-f3-edit-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    fs.mkdirSync(path.join(claudeHome, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'commands', 'foo.md'), '# foo\n');

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);
    const lastSync = engine.loadLastSync();

    fs.writeFileSync(path.join(claudeHome, 'commands', 'foo.md'), '# foo edited\n');

    const delta = engine.getLocalDelta(lastSync.commitHash);
    assert.deepEqual(delta.userConfigFiles, [{ dir: 'commands', file: 'foo.md' }]);
    assert.equal(engine.isLocalDeltaEmpty(delta), false);
  } finally {
    rmDir(root);
  }
});
