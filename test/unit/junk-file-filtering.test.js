'use strict';

// D-01: copyDirSync previously filtered nothing, so an OS junk file like
// macOS's `.DS_Store` got exported into the repo and committed the moment
// someone opened the synced dir in Finder -- producing a perpetual false
// "local changes" / session-end nag, and disagreeing with listFilesRecursive
// (which already skipped `.DS_Store`) about what actually changed.
//
// Fix: a shared IGNORED_FILES constant (`.DS_Store`, `Thumbs.db`,
// `.localized`) applied consistently by copyDirSync, removeStalePaths, and
// listFilesRecursive, plus a `.gitignore` written into a freshly-initialized
// (empty) repo so residue can't get re-added by accident either.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { copyDirSync, removeStalePaths, listFilesRecursive } = require('../../lib/sync-engine.js');
const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, writeAndCommit, git } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

// --- Pure unit coverage of the three shared helpers ------------------------

test('copyDirSync: filters .DS_Store, Thumbs.db, and .localized (D-01)', () => {
  const root = mkTmpDir('claude-sync-junk-copy-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'keep.md'), 'k');
    fs.writeFileSync(path.join(src, '.DS_Store'), '');
    fs.writeFileSync(path.join(src, 'Thumbs.db'), '');
    fs.writeFileSync(path.join(src, '.localized'), '');

    copyDirSync(src, dest);

    assert.equal(fs.existsSync(path.join(dest, 'keep.md')), true);
    assert.equal(fs.existsSync(path.join(dest, '.DS_Store')), false);
    assert.equal(fs.existsSync(path.join(dest, 'Thumbs.db')), false);
    assert.equal(fs.existsSync(path.join(dest, '.localized')), false);
  } finally {
    rmDir(root);
  }
});

test('removeStalePaths: ignores IGNORED_FILES entries in dest instead of treating them as stale (D-01)', () => {
  const root = mkTmpDir('claude-sync-junk-stale-');
  try {
    const src = path.join(root, 'src'); // empty -- nothing has a src counterpart
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, '.DS_Store'), '');
    fs.writeFileSync(path.join(dest, 'stale.md'), 'gone');

    removeStalePaths(src, dest);

    // .DS_Store is simply left alone (not "stale", just ignored).
    assert.equal(fs.existsSync(path.join(dest, '.DS_Store')), true);
    // A genuinely stale regular file is still swept.
    assert.equal(fs.existsSync(path.join(dest, 'stale.md')), false);
  } finally {
    rmDir(root);
  }
});

test('listFilesRecursive: omits all OS junk files (.DS_Store, Thumbs.db, .localized), not just .DS_Store (D-01)', () => {
  const root = mkTmpDir('claude-sync-junk-list-');
  try {
    fs.writeFileSync(path.join(root, 'keep.md'), 'k');
    fs.writeFileSync(path.join(root, '.DS_Store'), '');
    fs.writeFileSync(path.join(root, 'Thumbs.db'), '');
    fs.writeFileSync(path.join(root, '.localized'), '');

    const result = listFilesRecursive(root);
    assert.deepEqual([...result], ['keep.md']);
  } finally {
    rmDir(root);
  }
});

// --- End-to-end: junk files never make it into the synced repo -------------

test('.DS_Store in a synced dir is not exported into the repo, and hasLocalChanges() stays false across a push (D-01)', () => {
  const root = mkTmpDir('claude-sync-dsstore-e2e-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome);
    fs.mkdirSync(path.join(claudeHome, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'rules', 'style.md'), '# style\n');
    fs.writeFileSync(path.join(claudeHome, 'rules', '.DS_Store'), 'junk');

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir); // empty repo -> auto-pushes exportAll() as the initial commit

    const repoRulesDir = path.join(engine.REPO_DIR, 'user-config', 'rules');
    assert.equal(fs.existsSync(path.join(repoRulesDir, 'style.md')), true);
    assert.equal(fs.existsSync(path.join(repoRulesDir, '.DS_Store')), false);
    assert.equal(engine.hasLocalChanges(), false);

    // Opening the dir in Finder "touches" .DS_Store again -- must still not
    // surface as a local change on the next push.
    fs.writeFileSync(path.join(claudeHome, 'rules', '.DS_Store'), 'junk-again');
    const pushResult = engine.push();
    assert.equal(pushResult.pushed, false);
    assert.equal(pushResult.reason, 'no-changes');
  } finally {
    rmDir(root);
  }
});

test('init(): writes a .gitignore for OS junk files into a freshly-initialized (empty) repo (D-01)', () => {
  const root = mkTmpDir('claude-sync-gitignore-fresh-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome);

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    const checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone'));
    const gitignore = fs.readFileSync(path.join(checkClone, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.DS_Store$/m);
    assert.match(gitignore, /^Thumbs\.db$/m);
    assert.match(gitignore, /^\.localized$/m);
  } finally {
    rmDir(root);
  }
});

test('init(): does NOT retro-write a .gitignore into an already-initialized (non-empty) repo (D-01)', () => {
  const root = mkTmpDir('claude-sync-gitignore-existing-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const seedClone = cloneWithIdentity(remoteDir, path.join(root, 'seed-clone'));
    writeAndCommit(
      seedClone,
      'global/settings.json',
      JSON.stringify({ theme: 'dark' }, null, 2),
      'seed initial settings',
    );
    git(seedClone, ['push', 'origin', 'main']);

    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome);
    const engine = loadEngine(claudeHome);
    const result = engine.init(remoteDir); // hasContent=true -> no auto-push, no .gitignore write

    assert.equal(result.hasContent, true);
    assert.equal(fs.existsSync(path.join(engine.REPO_DIR, '.gitignore')), false);
  } finally {
    rmDir(root);
  }
});
