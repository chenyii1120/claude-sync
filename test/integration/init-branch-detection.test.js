'use strict';

// C-02 TDD scenario 1 + 3: init() detects the remote's actual default branch
// instead of assuming 'main', and every engine call site (push/pull/diff/
// getStatus, including the fetch+merge push-retry path) uses that detected
// branch consistently. Also covers back-compat for configs written before
// this task (no `branch` field).
//
// Branch-detection has two paths in detectBranch():
//   1. PRIMARY: `git symbolic-ref refs/remotes/origin/HEAD --short` resolves
//      cleanly whenever the remote already has at least one commit (its HEAD
//      is a real, advertisable ref).
//   2. FALLBACK: a brand-new EMPTY remote has no HEAD to advertise, so (1)
//      throws; the fallback reads the machine's own `git config --global
//      init.defaultBranch`. This matches the original bug report exactly
//      ("空 repo + 使用者 git init.defaultBranch=master"), so the test
//      isolates a fake global gitconfig via GIT_CONFIG_GLOBAL (git >= 2.32)
//      instead of ever touching the developer's real ~/.gitconfig.
//
// Machine A below exercises the FALLBACK path (joins an empty 'master' bare
// repo); machine B exercises the PRIMARY path (joins after A has pushed, so
// origin/HEAD is a real ref by then).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, git, isolatedGlobalGitConfig } = require('../helpers/git.js');
const { seedMinimalHome, writeJson } = require('../helpers/claude-home.js');

test('init(): detects a non-"main" default branch (empty-repo fallback + primary path) and push()/pull() round-trip entirely on that branch, including the merge-retry path (C-02)', () => {
  const root = mkTmpDir('claude-sync-branch-master-');
  const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'), 'master');

    // Machine A joins a brand-new EMPTY 'master' remote. detectBranch()'s
    // primary path (symbolic-ref) throws for an empty repo, so this exercises
    // the fallback: git config --global init.defaultBranch, isolated here to
    // an env-scoped config file so the test never touches the real
    // ~/.gitconfig and is deterministic regardless of the test machine's own
    // git config.
    const isolatedConfig = isolatedGlobalGitConfig(path.join(root, 'git-home'), {
      'init.defaultBranch': 'master',
    });
    process.env.GIT_CONFIG_GLOBAL = isolatedConfig;

    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    const engineA = loadEngine(homeA);
    const initA = engineA.init(remoteDir);

    assert.equal(initA.hasContent, false);
    assert.equal(initA.branch, 'master');
    assert.equal(engineA.loadConfig().branch, 'master');

    // Sanity: the branch that actually landed on the remote is 'master' (not
    // 'main') -- clone fresh and check directly.
    const checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone'));
    assert.equal(git(checkClone, ['branch', '--show-current']), 'master');
    assert.equal(git(checkClone, ['log', '-1', '--format=%s']), 'Initial sync from first machine');

    // Machine B joins the now-populated 'master' remote -- this hits the
    // PRIMARY symbolic-ref path (origin/HEAD is a real ref by now), no
    // isolated config needed. Unset it first to prove B doesn't rely on it.
    delete process.env.GIT_CONFIG_GLOBAL;

    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    const initB = engineB.init(remoteDir);
    assert.equal(initB.hasContent, true);
    assert.equal(initB.branch, 'master');
    const pullB = engineB.pull();
    assert.equal(pullB.mode, 'first-pull');

    // B changes a setting and pushes -- must push to origin/master, not
    // origin/main (which does not exist on this remote).
    writeJson(path.join(homeB, 'settings.json'), { theme: 'light' });
    const pushB = engineB.push();
    assert.equal(pushB.pushed, true);

    // A pulls -- fast-forward on master.
    const engineAReload = loadEngine(homeA);
    const pullA1 = engineAReload.pull();
    assert.equal(pullA1.pulled, true);
    assert.equal(pullA1.mode, 'fast-forward');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8')),
      { theme: 'light' },
    );

    // diffSettings()/getStatus() also default to origin/<branch>, not
    // origin/main.
    assert.deepEqual(engineAReload.diffSettings(), []);
    const status = engineAReload.getStatus();
    assert.equal(status.initialized, true);
    assert.equal(status.remoteUpdates, 0);

    // Push-retry (fetch + smart-merge + push) path on a non-'main' branch:
    // B and A both change the SAME field independently without pulling each
    // other's change first, so A's push is rejected on the first attempt and
    // must fetch/merge/retry against origin/master.
    writeJson(path.join(homeB, 'settings.json'), { theme: 'blue' });
    assert.equal(engineB.push().pushed, true);

    writeJson(path.join(homeA, 'settings.json'), { theme: 'red' });
    const pushA = engineAReload.push();
    assert.equal(pushA.pushed, true);
    assert.ok(Array.isArray(pushA.mergeConflicts));
    assert.equal(pushA.mergeConflicts.length, 1);
    assert.equal(pushA.mergeConflicts[0].key, 'theme');

    // The merge landed on the remote's master branch (not a stray 'main').
    const finalClone = cloneWithIdentity(remoteDir, path.join(root, 'final-clone'));
    assert.equal(git(finalClone, ['branch', '--show-current']), 'master');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(finalClone, 'global', 'settings.json'), 'utf8')),
      { theme: 'red' }, // preference='local' on push()'s retry -- A's value wins
    );
  } finally {
    if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    rmDir(root);
  }
});

test('getBranch(): defaults to "main" for a config.json written before branch detection existed, and push()/pull() keep working (C-02 back-compat)', () => {
  const root = mkTmpDir('claude-sync-branch-backcompat-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git')); // default 'main'

    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    // Simulate an install from before this task: strip the `branch` field
    // that init() just wrote, exactly like a pre-C-02 config.json would look.
    const config = engineA.loadConfig();
    assert.equal(config.branch, 'main');
    delete config.branch;
    engineA.saveConfig(config);
    assert.equal(engineA.getBranch(), 'main');

    // A second machine, also running with no `branch` field of its own,
    // still round-trips correctly against the real 'main' remote.
    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    const initB = engineB.init(remoteDir);
    assert.equal(initB.hasContent, true);
    const configB = engineB.loadConfig();
    delete configB.branch;
    engineB.saveConfig(configB);

    const pullB = engineB.pull();
    assert.equal(pullB.mode, 'first-pull');

    writeJson(path.join(homeB, 'settings.json'), { theme: 'light' });
    assert.equal(engineB.push().pushed, true);

    const engineAReload = loadEngine(homeA);
    const pullA = engineAReload.pull();
    assert.equal(pullA.pulled, true);
    assert.equal(pullA.mode, 'fast-forward');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8')),
      { theme: 'light' },
    );
  } finally {
    rmDir(root);
  }
});
