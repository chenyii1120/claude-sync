'use strict';

// C-06: getStatus()'s local-change probe (and the shared computeLocalChanges()
// helper it now delegates to) must be read-only from the caller's perspective:
// no working-tree pollution, no race with a concurrent push/pull (guarded by
// the sync lock -- busy means "skip the check", not "run it unlocked"), and
// no destructive blanket `clean -fd` that could delete an unrelated untracked
// artifact (e.g. an interrupted merge's leftovers). The session-end worker's
// best-effort branch (hooks/session-end-worker.js, non-autoPush) delegates to
// the same helper and is covered here too (it previously had no lock and no
// clean at all, leaking export artifacts into the working tree).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');
const { runHook } = require('../helpers/run-hook.js');

function repoStatus(engine) {
  return engine.gitExecFile(['status', '--porcelain']);
}

test('getStatus(): does not pollute the repo working tree (git status --porcelain identical before/after)', () => {
  const root = mkTmpDir('claude-sync-status-ro-clean-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir); // empty remote -> init() pushes immediately, repo now matches local exactly

    const before = repoStatus(engine);
    assert.equal(before, ''); // fixture is clean right after init()/push

    const status = engine.getStatus();

    const after = repoStatus(engine);
    assert.equal(after, before);
    assert.equal(status.localChanges, false);
    assert.deepEqual(status.warnings, []);
  } finally {
    rmDir(root);
  }
});

test('getStatus(): detects a real local change, and still leaves the working tree clean afterward', () => {
  const root = mkTmpDir('claude-sync-status-ro-dirty-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    // Unpushed local edit.
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));

    const status = engine.getStatus();
    assert.equal(status.localChanges, true);

    // The probe must have fully reverted its own working-tree export.
    assert.equal(repoStatus(engine), '');
    // The local file itself (what the probe is reporting on) must be untouched.
    const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { theme: 'light' });
  } finally {
    rmDir(root);
  }
});

test('getStatus(): busy (lock held by another op) returns localChanges:false with a warning, and never touches the working tree', () => {
  const root = mkTmpDir('claude-sync-status-ro-busy-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    // A real local change exists, but the lock is held by "another operation"
    // -- computeLocalChanges() must bail out before even looking at it.
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));

    const before = repoStatus(engine);

    assert.equal(engine.acquireLock(), true);
    try {
      const status = engine.getStatus();
      assert.equal(status.localChanges, false);
      assert.ok(
        status.warnings.some(w => /sync in progress/.test(w)),
        `expected a "sync in progress" warning, got: ${JSON.stringify(status.warnings)}`
      );

      // Busy path must never enter the try -- the working tree is untouched.
      assert.equal(repoStatus(engine), before);
    } finally {
      engine.releaseLock();
    }
  } finally {
    rmDir(root);
  }
});

test('computeLocalChanges(): scoped clean preserves an unrelated untracked file at the repo root (regression guard: no bare `clean -fd`)', () => {
  const root = mkTmpDir('claude-sync-status-ro-scoped-clean-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    // Simulate a stray artifact left behind by some other interrupted
    // operation (e.g. a half-finished merge) sitting at the repo root,
    // OUTSIDE the global/plugin-data/user-config dirs exportAll() writes to.
    // A bare `clean -fd` would delete this; the scoped clean must not.
    const strayPath = path.join(engine.REPO_DIR, 'STRAY-merge-artifact');
    fs.writeFileSync(strayPath, 'leftover from an interrupted operation\n');

    const probe = engine.computeLocalChanges();
    assert.equal(probe.busy, false);

    assert.equal(
      fs.existsSync(strayPath),
      true,
      'scoped clean must not delete untracked files outside global/plugin-data/user-config'
    );
  } finally {
    rmDir(root);
  }
});

test('session-end-worker.js best-effort path: reports unpushed changes and leaves no untracked leak in the repo', () => {
  const root = mkTmpDir('claude-sync-status-ro-worker-');
  const homeDir = mkTmpDir('claude-sync-status-ro-worker-home-');
  const claudeHome = path.join(homeDir, '.claude');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir); // config defaults to autoPush:false

    // Add a brand-new user-config file that was never part of the pushed
    // base -- exporting it creates a genuinely NEW untracked file in the
    // repo (unlike editing settings.json, which only modifies an already
    // tracked file). The old checkout-only best-effort path left files like
    // this behind; the fix's scoped clean must remove it.
    const newCommandPath = path.join(claudeHome, 'commands', 'new-command.md');
    fs.mkdirSync(path.dirname(newCommandPath), { recursive: true });
    fs.writeFileSync(newCommandPath, '# a new command\n');

    const result = runHook('hooks/session-end-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /\/sync-push/);

    // No leaked untracked export artifact in the repo working tree.
    assert.equal(repoStatus(engine), '');
    // The local file itself must be untouched.
    assert.equal(fs.readFileSync(newCommandPath, 'utf8'), '# a new command\n');
  } finally {
    rmDir(root);
    rmDir(homeDir);
  }
});
