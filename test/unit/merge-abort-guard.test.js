'use strict';

// C-07: performSmartMerge()'s git-merge-of-non-JSON-files block used to
// (a) call `git merge --abort` unconditionally in its catch, even when the
//     first merge failed for a reason OTHER than a conflict (so no merge was
//     ever started) -- that abort call itself throws "fatal: There is no
//     merge to abort", masking the real failure; and
// (b) on fallback-merge failure, throw the raw execFileSync error, whose
//     `.message` is just "Command failed: git ..." -- git's actual stderr
//     (the useful part) lives on `.stderr`, not `.message`.
//
// The deterministic real-repo trigger for "first merge fails WITHOUT a merge
// in progress" is the classic "untracked working tree files would be
// overwritten by merge" condition: a path that has NEVER been tracked in the
// local branch's history exists as an untracked file in the working tree,
// and the incoming merge wants to create that same path. Since the file was
// never tracked, `git merge --abort` afterwards has nothing to abort.
//
// performSmartMerge() isn't reachable this way through push() -- push()
// always does `git add -A` + commit on REPO_DIR before it ever calls
// performSmartMerge(), which would sweep a stray untracked file into the
// commit and defeat the scenario. So this test drives performSmartMerge()
// directly against a real REPO_DIR clone (exported from sync-engine.js for
// exactly this purpose), per the C-07 decisions doc.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, writeAndCommit, git } = require('../helpers/git.js');
const { seedMinimalHome, writeJson } = require('../helpers/claude-home.js');

test('performSmartMerge(): untracked-file collision does not throw the masking abort error, and the unrecoverable-merge error is readable', () => {
  const root = mkTmpDir('claude-sync-merge-abort-guard-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A initializes against the empty remote -- REPO_DIR's HEAD never
    // contains x.txt.
    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);
    const branch = engineA.getBranch();

    // A second clone advances the remote by ADDING x.txt -- a path that
    // engineA's REPO_DIR has never tracked.
    const seedDir = cloneWithIdentity(remoteDir, path.join(root, 'seed'));
    writeAndCommit(seedDir, 'x.txt', 'remote x content\n', 'remote adds x.txt');
    git(seedDir, ['push', 'origin', branch]);

    // In engineA's REPO_DIR, create x.txt as a brand-new, never-tracked,
    // untracked file whose content differs from the remote's version.
    fs.writeFileSync(path.join(engineA.REPO_DIR, 'x.txt'), 'local untracked content\n');

    // Fetch so origin/<branch> in REPO_DIR points at the remote's x.txt commit.
    engineA.gitExecFile(['fetch', 'origin', branch]);

    // Drive the merge path directly. The first `git merge` fails on the
    // untracked-file collision (no merge in progress afterwards); the
    // fallback `-X ours` merge fails on the SAME collision (untracked files
    // are never resolved by a merge strategy option).
    assert.throws(
      () => engineA.performSmartMerge('local', 'ours'),
      (err) => {
        assert.ok(err instanceof Error, 'must throw an Error');
        // Must NOT be the masking abort failure.
        assert.ok(
          !/no merge to abort/i.test(err.message),
          `must not surface the masked "no merge to abort" error, got: ${err.message}`,
        );
        // Must surface git's own stderr wording.
        assert.match(err.message, /untracked|overwritten|merge/i);
        // Must point the user at manual repair.
        assert.match(err.message, /manual repair/i);
        return true;
      },
    );
  } finally {
    rmDir(root);
  }
});

test('push(): a normal push-retry merge (conflicting settings.json edits on two machines) still succeeds', () => {
  const root = mkTmpDir('claude-sync-merge-abort-guard-happy-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();

    // Both machines change the SAME field independently, without pulling
    // each other's change first, so A's push is rejected on the first
    // attempt and must fetch + smart-merge + retry (the exact path this
    // fix touches, including a normal, successful `merge --abort`).
    writeJson(path.join(homeB, 'settings.json'), { theme: 'blue' });
    assert.equal(engineB.push().pushed, true);

    const engineAReload = loadEngine(homeA);
    writeJson(path.join(homeA, 'settings.json'), { theme: 'red' });
    const pushA = engineAReload.push();

    assert.equal(pushA.pushed, true);
    assert.ok(Array.isArray(pushA.mergeConflicts));
    assert.equal(pushA.mergeConflicts.length, 1);
    assert.equal(pushA.mergeConflicts[0].key, 'theme');

    // preference='local' on push()'s retry -- A's value wins.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8')),
      { theme: 'red' },
    );
  } finally {
    rmDir(root);
  }
});
