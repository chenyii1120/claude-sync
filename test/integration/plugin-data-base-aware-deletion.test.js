'use strict';

// A-03: safe pull must not silently delete local-only plugin-data.
//
// Before this fix, importPluginData() mirror-imported (syncDirReportChanges
// with full-mirror deletion) while getLocalDelta() deliberately excludes
// plugin-data from its "has local changes?" check (see the comment on
// getLocalDelta -- large/binary plugin-data is excluded to avoid false
// positives from machine-local plugin caches). The combination meant: a
// plugin-data file written locally AFTER the last push/pull (e.g. a
// blocklist entry, learned data) made safe pull think "local is clean" and
// then mirror-deleted the file with zero warning, because it had no
// counterpart in the freshly-fetched remote tree.
//
// Fix: importPluginData() is now base-aware (3-way-ish), not a mirror. A
// local file is only deleted when it existed at the last-sync BASE commit
// and is absent from the current remote -- i.e. the remote side explicitly
// deleted it. A file with no base entry (added locally after the last sync)
// is never a deletion candidate.
//
// Verification recipe (from the task brief): push -> add a new non-excluded
// file under ~/.claude/plugins/ locally -> push an unrelated change from
// another machine -> pull -> the new file must still exist. A second test
// covers the flip side: an explicit remote deletion of a file that WAS in
// base must still propagate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome, writeJson } = require('../helpers/claude-home.js');

test('A-03: a plugin-data file added locally after push survives a safe pull that only carries an unrelated remote change', () => {
  const root = mkTmpDir('claude-sync-a03-preserve-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A: seed settings + one plugin-data file, init() pushes it all
    // as the initial commit. lastSync.commitHash now == this base commit.
    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    writeJson(path.join(homeA, 'plugins', 'myplugin', 'data.json'), { count: 1 });
    const engineA = loadEngine(homeA);
    const initA = engineA.init(remoteDir);
    assert.equal(initA.hasContent, false);

    // Machine B joins the populated repo and pulls (first pull).
    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();

    // Back on A: write a NEW plugin-data file locally, AFTER the push that
    // established the base commit. This file has no counterpart at base.
    const newFilePath = path.join(homeA, 'plugins', 'myplugin', 'newfile.json');
    writeJson(newFilePath, { learned: true });
    assert.equal(fs.existsSync(newFilePath), true);

    // Machine B pushes an UNRELATED change (does not touch plugin-data at
    // all) -- this is the remote update A is about to pull.
    fs.writeFileSync(path.join(homeB, 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));
    const pushB = engineB.push();
    assert.equal(pushB.pushed, true);

    // A pulls in safe mode. getLocalDelta() excludes plugin-data by design,
    // so this must NOT be refused as 'local-changes-pending'.
    const engineAReload = loadEngine(homeA);
    const pullResult = engineAReload.pull({ mode: 'safe' });
    assert.notEqual(pullResult.reason, 'local-changes-pending');

    // The locally-added file must survive -- this is the core A-03 assertion.
    assert.equal(fs.existsSync(newFilePath), true, 'A-03 regression: local-only plugin-data file must survive a safe pull');
    assert.deepEqual(JSON.parse(fs.readFileSync(newFilePath, 'utf8')), { learned: true });

    // The unrelated remote change must still have been applied.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8')),
      { theme: 'light' },
    );

    // The pre-existing (base) plugin-data file is untouched too.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(homeA, 'plugins', 'myplugin', 'data.json'), 'utf8')),
      { count: 1 },
    );
  } finally {
    rmDir(root);
  }
});

test('A-03: an explicit remote deletion of a plugin-data file that WAS in base still propagates on pull', () => {
  const root = mkTmpDir('claude-sync-a03-explicit-delete-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    writeJson(path.join(homeA, 'plugins', 'myplugin', 'data.json'), { count: 1 });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir); // base commit includes myplugin/data.json

    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull(); // B now has myplugin/data.json too, same base

    // B deletes the plugin-data file that WAS in base, and pushes.
    fs.rmSync(path.join(homeB, 'plugins', 'myplugin', 'data.json'));
    const pushB = engineB.push();
    assert.equal(pushB.pushed, true);

    // A pulls -- the explicit remote deletion must propagate locally.
    const engineAReload = loadEngine(homeA);
    const pullResult = engineAReload.pull({ mode: 'safe' });
    assert.notEqual(pullResult.reason, 'local-changes-pending');
    assert.equal(
      fs.existsSync(path.join(homeA, 'plugins', 'myplugin', 'data.json')),
      false,
      'A-03: a file that existed at base and was deleted remotely must be removed locally',
    );
  } finally {
    rmDir(root);
  }
});

test('A-03: with no base commit (first pull), plugin-data import deletes nothing and reports a warning', () => {
  const root = mkTmpDir('claude-sync-a03-nobase-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    writeJson(path.join(homeA, 'plugins', 'myplugin', 'data.json'), { count: 1 });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    // Machine B joins an existing (non-empty) repo -- firstPullPending is
    // true until its first pull() call, so importPluginData sees
    // baseCommit=null (forceRemote first-pull path).
    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    // A local-only plugin-data file that predates sync-init entirely (e.g.
    // a fresh Claude install already had plugin state before this machine
    // ever joined the sync repo). It has no base at all.
    writeJson(path.join(homeB, 'plugins', 'otherplugin', 'preexisting.json'), { local: true });
    const engineB = loadEngine(homeB);
    const initB = engineB.init(remoteDir);
    assert.equal(initB.hasContent, true);

    const pullResult = engineB.pull();
    assert.equal(pullResult.mode, 'first-pull');

    // Nothing local-only was deleted.
    assert.equal(
      fs.existsSync(path.join(homeB, 'plugins', 'otherplugin', 'preexisting.json')),
      true,
      'A-03: first pull (no base) must never delete local-only plugin-data',
    );
    // Remote content was still brought down.
    assert.equal(
      fs.existsSync(path.join(homeB, 'plugins', 'myplugin', 'data.json')),
      true,
    );
    // The no-base fallback must be surfaced as a warning, not thrown.
    assert.ok(Array.isArray(pullResult.warnings));
    assert.ok(
      pullResult.warnings.some(w => /plugin-data/i.test(w) && /base/i.test(w)),
      `expected a plugin-data/no-base warning, got: ${JSON.stringify(pullResult.warnings)}`,
    );
  } finally {
    rmDir(root);
  }
});
