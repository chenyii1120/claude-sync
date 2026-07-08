'use strict';

// C-02 TDD scenario 2: init() cleans up REPO_DIR when a post-clone step
// fails, so a retry doesn't get stuck on `git clone`'s "destination path
// already exists" error.
//
// Failure simulation: after `git clone` succeeds (read-only, so it tolerates
// an unwritable remote fine), the bare remote directory tree is chmod'd to
// read+execute only (0o555, recursively). This makes the receive side of
// `git push` fail (it needs to write new loose objects/refs into the bare
// repo), which is exactly the "clone succeeded but a later init() step
// failed" case B-01/C-02 targets (a real-world network drop between clone
// and push would look the same to init(): clone worked, the next git command
// didn't). Permissions are restored in `finally` so cleanup (rmDir) can run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

function chmodRecursive(dir, mode) {
  execFileSync('chmod', ['-R', mode, dir], { stdio: 'pipe' });
}

test('init(): cleans up REPO_DIR when a post-clone step fails (unwritable remote), so a retry against a working remote succeeds without manual rm -rf (C-02)', () => {
  const root = mkTmpDir('claude-sync-init-cleanup-');
  const remoteDir = path.join(root, 'remote.git');
  try {
    initBareRepo(remoteDir);

    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);

    // Simulate a failure AFTER validateRemoteUrl()/git clone succeed: the
    // remote becomes unwritable (stands in for a network drop / permission
    // error during the initial push of an empty repo).
    chmodRecursive(remoteDir, '555');

    assert.throws(() => engine.init(remoteDir));

    // REPO_DIR must be cleaned up -- not left behind as residue that would
    // make a retry's `git clone` fail with "destination path already exists".
    assert.equal(fs.existsSync(engine.REPO_DIR), false);
    assert.equal(engine.isInitialized(), false);
    // CONFIG_PATH must not exist either (saveConfig() never ran).
    assert.equal(fs.existsSync(engine.CONFIG_PATH), false);

    // Restore write access and retry against the now-working remote.
    chmodRecursive(remoteDir, '755');
    const result = engine.init(remoteDir);
    assert.equal(result.hasContent, false);
    assert.equal(engine.isInitialized(), true);
    assert.deepEqual(engine.loadConfig(), { repo: remoteDir, branch: 'main', autoPull: false, autoPush: false });
  } finally {
    // Ensure the remote is writable again before rmDir tries to delete it.
    try { chmodRecursive(remoteDir, '755'); } catch {}
    rmDir(root);
  }
});

test('init(): clears stale REPO_DIR residue (no CONFIG_PATH next to it) left by a previously-failed init before cloning (C-02)', () => {
  const root = mkTmpDir('claude-sync-init-stale-residue-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);

    // Manually recreate what a previously-failed init() would have left
    // behind: REPO_DIR exists (as SOME directory -- not even a real git repo,
    // to prove init() doesn't merely `git pull` into it) but CONFIG_PATH does
    // not.
    fs.mkdirSync(engine.REPO_DIR, { recursive: true });
    fs.writeFileSync(path.join(engine.REPO_DIR, 'leftover-junk.txt'), 'stale');
    assert.equal(engine.isInitialized(), false);

    const result = engine.init(remoteDir);
    assert.equal(result.hasContent, false);
    assert.equal(engine.isInitialized(), true);
    // The stale junk file must be gone -- REPO_DIR is now a real, fresh clone.
    assert.equal(fs.existsSync(path.join(engine.REPO_DIR, 'leftover-junk.txt')), false);
    assert.equal(fs.existsSync(path.join(engine.REPO_DIR, '.git')), true);
  } finally {
    rmDir(root);
  }
});
