'use strict';

// F#4 (Codex review): git has no empty directories, so when the remote deletes
// the LAST file in a synced user-config dir (e.g. commands/), the whole dir
// vanishes from the tree. getSyncDirsForImport() lists only CURRENT repo dirs,
// so importUserConfig() never saw the dir and left machine B's stale local
// copy in place (which a later push could then resurrect on the remote). Fix:
// pruneRemotelyDeletedUserDirs(baseCommit, ...) -- for an allow-listed dir that
// was in the last-sync BASE but is now absent from the repo, delete the files
// that were in the base (the ones the remote removed), preserving any local-only
// additions. Mirrors the A-03 base-aware plugin-data deletion.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { writeJson } = require('../helpers/claude-home.js');

// Build two machines (A/B) converged on a repo whose commands/ dir has one
// file. B first-pulls to hydrate commands/foo.md and record the base commit.
function twoConvergedHomesWithCommands(root) {
  const remoteDir = initBareRepo(path.join(root, 'remote.git'));

  const homeA = path.join(root, 'home-a');
  fs.mkdirSync(homeA, { recursive: true });
  writeJson(path.join(homeA, 'settings.json'), { theme: 'dark' });
  fs.mkdirSync(path.join(homeA, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(homeA, 'commands', 'foo.md'), '# foo\n');
  const engineA = loadEngine(homeA);
  engineA.init(remoteDir);

  const homeB = path.join(root, 'home-b');
  fs.mkdirSync(homeB, { recursive: true });
  writeJson(path.join(homeB, 'settings.json'), { theme: 'dark' });
  const engineB = loadEngine(homeB);
  engineB.init(remoteDir);
  engineB.pull(); // first-pull: hydrate commands/foo.md, set base

  return { remoteDir, homeA, engineA, homeB, engineB };
}

test('F#4: a whole synced dir the remote deleted is pruned from local on pull (not left stale)', () => {
  const root = mkTmpDir('claude-sync-f4-whole-dir-');
  try {
    const { homeA, engineA, homeB, engineB } = twoConvergedHomesWithCommands(root);

    // Sanity: B hydrated commands/foo.md from the first pull.
    assert.equal(fs.existsSync(path.join(homeB, 'commands', 'foo.md')), true);

    // A deletes the ONLY file in commands/ and pushes -> git drops the dir.
    fs.rmSync(path.join(homeA, 'commands', 'foo.md'));
    assert.equal(engineA.push().pushed, true);

    // B pulls in safe mode: local == base (no divergence), so it fast-forwards
    // and the base-aware prune removes the now-absent dir's stale local file.
    const pullB = engineB.pull({ mode: 'safe' });
    assert.notEqual(pullB.reason, 'local-changes-pending');
    assert.equal(
      fs.existsSync(path.join(homeB, 'commands', 'foo.md')),
      false,
      'a remotely-deleted whole dir must be pruned from local, not left stale',
    );
  } finally {
    rmDir(root);
  }
});

test('F#4: a B-local-only addition to the deleted dir survives the prune (only base files removed)', () => {
  const root = mkTmpDir('claude-sync-f4-preserve-local-');
  try {
    const { homeA, engineA, homeB, engineB } = twoConvergedHomesWithCommands(root);

    // B adds a local-only file to commands/ (added AFTER base, never pushed).
    fs.writeFileSync(path.join(homeB, 'commands', 'bar.md'), '# bar (local only)\n');

    // A deletes the base file and pushes -> repo commands/ dir gone.
    fs.rmSync(path.join(homeA, 'commands', 'foo.md'));
    assert.equal(engineA.push().pushed, true);

    // The local-only bar.md makes getLocalDelta dirty (F#3 union walk), so safe
    // pull is refused -- the user opts into merge mode.
    const safe = engineB.pull({ mode: 'safe' });
    assert.equal(safe.pulled, false);
    assert.equal(safe.reason, 'local-changes-pending');

    const merge = engineB.pull({ mode: 'merge' });
    assert.equal(merge.pulled, true);

    // The base file the remote removed is pruned...
    assert.equal(
      fs.existsSync(path.join(homeB, 'commands', 'foo.md')),
      false,
      'the base file removed on the remote must be pruned locally',
    );
    // ...but the local-only addition (never in base) is preserved.
    assert.equal(
      fs.existsSync(path.join(homeB, 'commands', 'bar.md')),
      true,
      'a local-only addition must survive the base-aware prune',
    );
    assert.equal(fs.readFileSync(path.join(homeB, 'commands', 'bar.md'), 'utf8'), '# bar (local only)\n');
  } finally {
    rmDir(root);
  }
});
