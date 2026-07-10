'use strict';

// C-04: regression coverage for the JSON.parse hardening in
// lib/sync-engine.js. Two scenarios, mirroring push-pull-roundtrip.test.js's
// two-machine setup:
//
//   1. Data-loss regression (the important one): a corrupt LOCAL
//      settings.json must make push() throw a path-naming error and must
//      NEVER push an empty/{} settings.json to the repo -- a corrupt file
//      silently read as {} would look like "the user deleted every setting"
//      to every other machine that pulls afterwards.
//   2. Auxiliary regression: a corrupt last-sync.json must NOT crash pull()
//      -- it falls back to the safe no-base overlay path and the pull result
//      reports a warning instead of losing the corruption silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, git } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('push(): corrupt local settings.json throws a path-naming error and never pushes {} to the repo', () => {
  const root = mkTmpDir('claude-sync-corrupt-push-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A is first to init: empty repo, so init() pushes the valid
    // seed settings immediately (this must succeed normally).
    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark', model: 'sonnet' });
    const engineA = loadEngine(homeA);
    const initA = engineA.init(remoteDir);
    assert.equal(initA.hasContent, false);
    const branch = engineA.getBranch();

    // Sanity: the valid settings actually made it to the remote.
    const settingsBeforeCorruption = git(remoteDir, ['show', `${branch}:global/settings.json`]);
    assert.deepEqual(JSON.parse(settingsBeforeCorruption), { theme: 'dark', model: 'sonnet' });

    // Now corrupt local settings.json (e.g. a crashed editor, a bad manual
    // edit) and attempt a push.
    const settingsPathA = path.join(homeA, 'settings.json');
    fs.writeFileSync(settingsPathA, '{ "theme": "dark", oops this is not json');

    assert.throws(
      () => engineA.push(),
      (err) => err instanceof Error && err.message.includes(settingsPathA),
      'push() must throw an Error whose message names the corrupt file path',
    );

    // The remote must still hold the last GOOD settings -- never an empty
    // object, and never the corrupt content.
    const settingsAfterCorruption = git(remoteDir, ['show', `${branch}:global/settings.json`]);
    const parsedAfter = JSON.parse(settingsAfterCorruption);
    assert.deepEqual(parsedAfter, { theme: 'dark', model: 'sonnet' });
    assert.notDeepEqual(parsedAfter, {});

    // And the working tree of the sync repo clone was never overwritten with
    // an empty settings.json either (exportSettings() must bail out before
    // any write happens).
    const repoWorkingCopy = JSON.parse(
      fs.readFileSync(path.join(engineA.REPO_DIR, 'global', 'settings.json'), 'utf8'),
    );
    assert.deepEqual(repoWorkingCopy, { theme: 'dark', model: 'sonnet' });
  } finally {
    rmDir(root);
  }
});

test('pull(): corrupt last-sync.json falls back to the safe overlay path and reports a warning instead of crashing', () => {
  const root = mkTmpDir('claude-sync-corrupt-lastsync-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A creates the repo.
    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    // Machine B joins, first-pulls, then changes a setting and pushes so
    // there is something new for A to pull.
    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();
    fs.writeFileSync(path.join(homeB, 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));
    const pushB = engineB.push();
    assert.equal(pushB.pushed, true);

    // Back on A: corrupt last-sync.json before pulling B's change.
    const engineAReload = loadEngine(homeA);
    fs.writeFileSync(engineAReload.LAST_SYNC_PATH, '{ this is not json');

    const pullResult = engineAReload.pull();

    // Must NOT throw, must proceed (safe no-base overlay path), and must
    // report a warning about the corruption instead of losing it silently.
    assert.equal(pullResult.pulled, true);
    assert.ok(Array.isArray(pullResult.warnings));
    assert.ok(
      pullResult.warnings.some((w) => /malformed json/i.test(w) && w.includes(engineAReload.LAST_SYNC_PATH)),
      `expected a warning naming ${engineAReload.LAST_SYNC_PATH}, got: ${JSON.stringify(pullResult.warnings)}`,
    );

    // The remote change was still picked up despite the corrupt base.
    const settingsA = JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8'));
    assert.deepEqual(settingsA, { theme: 'light' });
  } finally {
    rmDir(root);
  }
});
