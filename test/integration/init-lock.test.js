'use strict';

// C-02 review, finding 2: init() performs destructive fs.rmSync(REPO_DIR)
// cleanup (pre-clone residue removal, and catch-block cleanup on post-clone
// failure). Unlike push()/pull()/applyPendingDirs()/discardPendingDirs()/
// uninstall(), init() previously took no lock, so a concurrent init() (or an
// init() racing a running push/pull) could delete another operation's
// REPO_DIR mid-flight. init() must now hold the sync lock across its
// destructive work, and must fail fast -- without touching REPO_DIR -- when
// the lock is already held.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('init(): throws "Another sync operation is in progress." and does not delete an existing REPO_DIR when the sync lock is already held (C-02 review)', () => {
  const root = mkTmpDir('claude-sync-init-lock-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);

    // Set up REPO_DIR residue the way a previously-failed init() would leave
    // it, so we can prove the locked-out init() doesn't touch it.
    fs.mkdirSync(engine.REPO_DIR, { recursive: true });
    fs.writeFileSync(path.join(engine.REPO_DIR, 'leftover-junk.txt'), 'stale');

    // Simulate a concurrent sync operation by taking the lock ourselves.
    assert.equal(engine.acquireLock(), true);
    try {
      assert.throws(
        () => engine.init(remoteDir),
        /Another sync operation is in progress\./
      );

      // The other operation's REPO_DIR must survive untouched -- init() must
      // not have entered its destructive cleanup/clone path at all.
      assert.equal(fs.existsSync(engine.REPO_DIR), true);
      assert.equal(
        fs.existsSync(path.join(engine.REPO_DIR, 'leftover-junk.txt')),
        true
      );
      assert.equal(engine.isInitialized(), false);
    } finally {
      engine.releaseLock();
    }

    // Sanity check: with the lock free, init() proceeds normally (and, in
    // doing so, clears the stale residue as covered by
    // init-failure-cleanup.test.js).
    const result = engine.init(remoteDir);
    assert.equal(result.hasContent, false);
    assert.equal(engine.isInitialized(), true);
  } finally {
    rmDir(root);
  }
});
