'use strict';

// F-01 integration scenario: safe pull refuses to clobber unpushed local
// changes, and pull({ mode: 'merge' }) then reconciles both sides via the
// 3-way JSON merge (mergeJsonFields) instead of a git-level merge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('pull(): safe mode refuses when local has unpushed changes; merge mode reconciles both sides', () => {
  const root = mkTmpDir('claude-sync-safe-pull-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A creates the repo with an initial settings.json.
    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark', model: 'sonnet' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    // Machine B joins, first-pulls, then changes a DIFFERENT key and pushes.
    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark', model: 'sonnet' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();
    fs.writeFileSync(path.join(homeB, 'settings.json'), JSON.stringify({ theme: 'dark', model: 'opus' }, null, 2));
    const pushB = engineB.push();
    assert.equal(pushB.pushed, true);

    // Back on A: make an unpushed local edit to a different key before pulling.
    const engineAReload = loadEngine(homeA);
    fs.writeFileSync(path.join(homeA, 'settings.json'), JSON.stringify({ theme: 'light', model: 'sonnet' }, null, 2));

    const safeResult = engineAReload.pull({ mode: 'safe' });
    assert.equal(safeResult.pulled, false);
    assert.equal(safeResult.reason, 'local-changes-pending');
    // D-02: a refused safe pull imports nothing, so it must NOT take a backup.
    assert.equal(safeResult.backupPath, null, 'a refused safe pull must not take a backup');
    assert.ok(safeResult.localDelta.settingsKeys.includes('theme'));

    // Local file must be untouched by the refused safe pull.
    const settingsAfterSafe = JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8'));
    assert.deepEqual(settingsAfterSafe, { theme: 'light', model: 'sonnet' });

    // Now retry with mode: 'merge' — A's theme change and B's model change
    // touch different keys, so both survive with no real conflict.
    const mergeResult = engineAReload.pull({ mode: 'merge' });
    assert.equal(mergeResult.pulled, true);
    assert.equal(mergeResult.mode, 'merge');

    const settingsAfterMerge = JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8'));
    assert.deepEqual(settingsAfterMerge, { theme: 'light', model: 'opus' });
  } finally {
    rmDir(root);
  }
});
