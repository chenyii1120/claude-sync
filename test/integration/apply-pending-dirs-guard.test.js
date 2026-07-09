'use strict';

// Codex F#5/F#6 review of applyPendingDirs() (lib/sync-engine.js).
//
// F#6: `applyPendingDirs([])` used to fall back to "apply everything pending"
// because `(dirs && dirs.length) ? dirs : state.dirs` treats an empty array
// as falsy. That means "the user approved none of the deferred dirs" could
// still import all of them. Fixed to treat an explicit array (including [])
// literally via Array.isArray(), and to make an empty toApply set a true
// no-op: it must not write anything, advance last-sync, or touch the
// pending-apply state file.
//
// F#5: applyPendingDirs() used to call loadPendingApply() (and the `!state`
// null check) BEFORE acquireLock(), a TOCTOU window where a concurrent
// discardPendingDirs() could clear the pending state between the read and
// the lock. The load now happens under the lock. This is tested
// best-effort here: with the lock already held, applyPendingDirs() must
// throw the lock-busy error and must not have acted on pending state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedFullHome } = require('../helpers/claude-home.js');

function twoConvergedHomes(root) {
  const remoteDir = initBareRepo(path.join(root, 'remote.git'));

  const homeA = path.join(root, 'home-a');
  seedFullHome(homeA, { settings: { theme: 'dark' }, ruleContent: '# style\n' });
  const engineA = loadEngine(homeA);
  engineA.init(remoteDir);

  const homeB = path.join(root, 'home-b');
  seedFullHome(homeB, { settings: { theme: 'dark' }, ruleContent: '# style\n' });
  const engineB = loadEngine(homeB);
  engineB.init(remoteDir);
  engineB.pull(); // first-pull: converge

  return { remoteDir, homeA, engineA, homeB, engineB };
}

// Builds a pending-apply state on B with two deferred dirs: hooks and
// skills. Returns the converged fixture plus the pre-pull last-sync hash so
// callers can assert it stays put.
function deferHooksAndSkills(root) {
  const fixture = twoConvergedHomes(root);
  const { homeA, engineA, engineB } = fixture;

  const baseBefore = engineB.loadLastSync().commitHash;

  fs.mkdirSync(path.join(homeA, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(homeA, 'hooks', 'new-hook.js'), 'console.log("hook")\n');
  fs.mkdirSync(path.join(homeA, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(homeA, 'skills', 'new-skill.md'), '# skill\n');
  engineA.push();

  const pullB = engineB.pull();
  assert.ok(pullB.pendingConfirmation.some(p => p.dir === 'hooks'));
  assert.ok(pullB.pendingConfirmation.some(p => p.dir === 'skills'));
  assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), true);

  return { ...fixture, baseBefore };
}

test('F#6: applyPendingDirs([]) applies none, leaves last-sync and pending state untouched', () => {
  const root = mkTmpDir('claude-sync-apply-none-');
  try {
    const { homeB, engineB, baseBefore } = deferHooksAndSkills(root);

    const pendingBefore = JSON.parse(fs.readFileSync(engineB.PENDING_APPLY_PATH, 'utf8'));

    const result = engineB.applyPendingDirs([]);

    assert.equal(result.applied, true);
    assert.deepEqual(result.dirs, [], 'an explicit [] must apply nothing');
    assert.deepEqual(result.configChanges, []);
    assert.deepEqual(
      result.remainingDirs.slice().sort(),
      ['hooks', 'skills'],
      'both dirs must still be reported as pending',
    );

    // Nothing landed in ~/.claude.
    assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'new-hook.js')), false);
    assert.equal(fs.existsSync(path.join(homeB, 'skills', 'new-skill.md')), false);

    // last-sync did not advance, and the pending state file is untouched.
    assert.equal(engineB.loadLastSync().commitHash, baseBefore, 'applyPendingDirs([]) must not advance last-sync');
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), true, 'pending-apply state must survive an apply-none call');
    const pendingAfter = JSON.parse(fs.readFileSync(engineB.PENDING_APPLY_PATH, 'utf8'));
    assert.deepEqual(pendingAfter, pendingBefore, 'pending-apply state must be byte-for-byte unchanged');
  } finally {
    rmDir(root);
  }
});

test('F#6: applyPendingDirs(undefined) applies ALL pending dirs', () => {
  const root = mkTmpDir('claude-sync-apply-all-');
  try {
    const { homeB, engineB } = deferHooksAndSkills(root);

    const remoteHead = engineB.gitExecFile(['rev-parse', 'origin/main']);
    const result = engineB.applyPendingDirs();

    assert.equal(result.applied, true);
    assert.deepEqual(result.dirs.slice().sort(), ['hooks', 'skills']);
    assert.deepEqual(result.remainingDirs, []);

    assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'new-hook.js')), true);
    assert.equal(fs.existsSync(path.join(homeB, 'skills', 'new-skill.md')), true);

    assert.equal(engineB.loadLastSync().commitHash, remoteHead, 'last-sync advances when everything pending is applied');
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), false, 'pending-apply state cleared once nothing remains pending');
  } finally {
    rmDir(root);
  }
});

test('F#6: applyPendingDirs(["hooks"]) applies only hooks, leaves skills pending', () => {
  const root = mkTmpDir('claude-sync-apply-partial-');
  try {
    const { homeB, engineB } = deferHooksAndSkills(root);

    const result = engineB.applyPendingDirs(['hooks']);

    assert.equal(result.applied, true);
    assert.deepEqual(result.dirs, ['hooks']);
    assert.deepEqual(result.remainingDirs, ['skills']);

    assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'new-hook.js')), true);
    assert.equal(fs.existsSync(path.join(homeB, 'skills', 'new-skill.md')), false);

    // Partial apply still advances last-sync (matches pre-existing Fix 3
    // partial-apply behavior) and leaves a pending-apply file for 'skills'.
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), true);
    const pendingAfter = JSON.parse(fs.readFileSync(engineB.PENDING_APPLY_PATH, 'utf8'));
    assert.deepEqual(pendingAfter.dirs, ['skills']);
  } finally {
    rmDir(root);
  }
});

test('F#5: applyPendingDirs() throws the lock-busy error and does not act on pending state while the lock is held', () => {
  const root = mkTmpDir('claude-sync-apply-lock-');
  try {
    const { homeB, engineB, baseBefore } = deferHooksAndSkills(root);

    const pendingBefore = JSON.parse(fs.readFileSync(engineB.PENDING_APPLY_PATH, 'utf8'));

    // Simulate a concurrent sync operation (e.g. discardPendingDirs()) by
    // taking the lock ourselves before calling applyPendingDirs().
    assert.equal(engineB.acquireLock(), true);
    try {
      assert.throws(
        () => engineB.applyPendingDirs(['hooks']),
        /Another sync operation is in progress\./,
      );

      // Nothing must have been written or advanced: the load-under-lock
      // fix means applyPendingDirs() never even reached loadPendingApply().
      assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'new-hook.js')), false);
      assert.equal(engineB.loadLastSync().commitHash, baseBefore);
      assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), true);
      const pendingAfter = JSON.parse(fs.readFileSync(engineB.PENDING_APPLY_PATH, 'utf8'));
      assert.deepEqual(pendingAfter, pendingBefore, 'pending-apply state must be untouched while the lock is held');
    } finally {
      engineB.releaseLock();
    }

    // Sanity check: with the lock free, applyPendingDirs() proceeds normally.
    const result = engineB.applyPendingDirs(['hooks']);
    assert.equal(result.applied, true);
    assert.deepEqual(result.dirs, ['hooks']);
  } finally {
    rmDir(root);
  }
});
