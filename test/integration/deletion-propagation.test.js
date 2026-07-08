'use strict';

// A-01 + A-06 regression scenarios: local deletions of user-config files,
// CLAUDE.md, and settings.json must propagate to the sync repo on push, and
// must NOT resurrect on a subsequent pull. Before the fix, exportUserConfig()
// only ever added/overwrote files (copyDirSync with no stale sweep) and
// exportSettings() no-op'd when settings.json was missing, so repo-side
// files never got removed and importUserConfig()'s mirror sweep would copy
// the "deleted" file straight back on pull.
//
// Each scenario follows the brief's exact verification recipe: init -> push
// with content -> delete locally -> push -> assert repo file is gone ->
// pull -> assert file did not resurrect locally. We inspect real file state
// (a fresh clone of the bare remote, and the local ~/.claude tmpdir) rather
// than relying on push()/pull()'s returned change lists, since A-02 (pull
// always reports changes) is a separate, not-yet-fixed bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity } = require('../helpers/git.js');
const { writeJson } = require('../helpers/claude-home.js');

test('A-01: deleting a file from an allow-listed user-config dir (rules/) propagates on push and does not resurrect on pull', () => {
  const root = mkTmpDir('claude-sync-del-rules-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    writeJson(path.join(claudeHome, 'settings.json'), { theme: 'dark' });
    fs.mkdirSync(path.join(claudeHome, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'rules', 'keep.md'), '# keep\n');
    fs.writeFileSync(path.join(claudeHome, 'rules', 'gone.md'), '# gone\n');

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir); // empty remote -> pushes initial state

    // Sanity: both files landed in the repo.
    let checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone-1'));
    assert.equal(fs.existsSync(path.join(checkClone, 'user-config', 'rules', 'keep.md')), true);
    assert.equal(fs.existsSync(path.join(checkClone, 'user-config', 'rules', 'gone.md')), true);

    // Delete one file locally, push.
    fs.rmSync(path.join(claudeHome, 'rules', 'gone.md'));
    const pushResult = engine.push();
    assert.equal(pushResult.pushed, true);

    // The deleted file must be gone from the remote repo.
    checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone-2'));
    assert.equal(fs.existsSync(path.join(checkClone, 'user-config', 'rules', 'gone.md')), false);
    assert.equal(fs.existsSync(path.join(checkClone, 'user-config', 'rules', 'keep.md')), true);

    // Pull must not resurrect the deleted file locally.
    engine.pull();
    assert.equal(fs.existsSync(path.join(claudeHome, 'rules', 'gone.md')), false);
    assert.equal(fs.existsSync(path.join(claudeHome, 'rules', 'keep.md')), true);
  } finally {
    rmDir(root);
  }
});

test('A-01 edge case: removing an allow-listed dir entirely from local clears its repo-side contents and does not resurrect on pull', () => {
  const root = mkTmpDir('claude-sync-del-dir-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    writeJson(path.join(claudeHome, 'settings.json'), { theme: 'dark' });
    fs.mkdirSync(path.join(claudeHome, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'rules', 'style.md'), '# style\n');

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    let checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone-1'));
    assert.equal(fs.existsSync(path.join(checkClone, 'user-config', 'rules', 'style.md')), true);

    // Remove the whole rules/ dir locally (not just a file in it).
    fs.rmSync(path.join(claudeHome, 'rules'), { recursive: true, force: true });
    const pushResult = engine.push();
    assert.equal(pushResult.pushed, true);

    // Repo-side rules/ must no longer contain style.md (dir treated as empty).
    checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone-2'));
    assert.equal(fs.existsSync(path.join(checkClone, 'user-config', 'rules', 'style.md')), false);

    engine.pull();
    assert.equal(fs.existsSync(path.join(claudeHome, 'rules', 'style.md')), false);
  } finally {
    rmDir(root);
  }
});

test('A-06: deleting local CLAUDE.md propagates on push and does not resurrect on pull', () => {
  const root = mkTmpDir('claude-sync-del-claudemd-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    writeJson(path.join(claudeHome, 'settings.json'), { theme: 'dark' });
    fs.writeFileSync(path.join(claudeHome, 'CLAUDE.md'), '# my instructions\n');

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    let checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone-1'));
    assert.equal(fs.existsSync(path.join(checkClone, 'user-config', 'CLAUDE.md')), true);

    fs.rmSync(path.join(claudeHome, 'CLAUDE.md'));
    const pushResult = engine.push();
    assert.equal(pushResult.pushed, true);

    checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone-2'));
    assert.equal(fs.existsSync(path.join(checkClone, 'user-config', 'CLAUDE.md')), false);

    engine.pull();
    assert.equal(fs.existsSync(path.join(claudeHome, 'CLAUDE.md')), false);
  } finally {
    rmDir(root);
  }
});

test('A-06: deleting local settings.json propagates on push and does not resurrect on pull', () => {
  const root = mkTmpDir('claude-sync-del-settings-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    writeJson(path.join(claudeHome, 'settings.json'), { theme: 'dark' });
    // Need at least one other tracked file so the repo isn't totally empty
    // and push() has something else to diff against.
    fs.mkdirSync(path.join(claudeHome, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'rules', 'style.md'), '# style\n');

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    let checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone-1'));
    assert.equal(fs.existsSync(path.join(checkClone, 'global', 'settings.json')), true);

    fs.rmSync(path.join(claudeHome, 'settings.json'));
    const pushResult = engine.push();
    assert.equal(pushResult.pushed, true);

    checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone-2'));
    assert.equal(fs.existsSync(path.join(checkClone, 'global', 'settings.json')), false);

    engine.pull();
    assert.equal(fs.existsSync(path.join(claudeHome, 'settings.json')), false);
  } finally {
    rmDir(root);
  }
});
