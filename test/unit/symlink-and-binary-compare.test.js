'use strict';

// C-09: two independent fixes bundled in one task because they touch the
// same helpers.
//
// Part A -- copyDirSync/removeStalePaths/listFilesRecursive previously used
// entry.isDirectory() and otherwise treated every entry as a regular file.
// A symlink therefore got copyFileSync'd: following the link (copies the
// TARGET's content), throwing EISDIR for a dir-symlink, or throwing ENOENT
// for a broken symlink and aborting the whole export/import. All three
// helpers now skip symlinks (with a console.warn) instead.
//
// Part B -- three content-compare sites (diffUserConfig, diffPluginData,
// getLocalDelta) read a LOCAL file as a utf8 string and compared it against
// git-side content (also utf8, via safeGitShow). A binary file (e.g. an
// image under skills/) decodes invalid byte sequences to the same U+FFFD
// replacement character on both sides, so two DIFFERENT binaries could
// falsely compare equal. Fixed via safeGitShowBuffer() + Buffer.equals().

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { copyDirSync, removeStalePaths, listFilesRecursive } = require('../../lib/sync-engine.js');
const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

// Attempts to create the three symlinks a test needs; returns false (instead
// of throwing) if the platform refuses symlink creation (e.g. EPERM on
// Windows without dev-mode/admin), so those tests can skip gracefully.
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return false;
    throw err;
  }
}

function captureWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

// --- Part A: symlink skip -------------------------------------------------

test('copyDirSync: skips symlinks (file-target, dir-target, and broken) without throwing, copies the regular file/dir, and warns once per skipped symlink (C-09)', (t) => {
  const root = mkTmpDir('claude-sync-symlink-copy-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'regular.md'), 'hello');
    fs.mkdirSync(path.join(src, 'realdir'), { recursive: true });
    fs.writeFileSync(path.join(src, 'realdir', 'inner.md'), 'inner');

    const ok = trySymlink(path.join(src, 'regular.md'), path.join(src, 'link-to-file.md'))
      && trySymlink(path.join(src, 'realdir'), path.join(src, 'link-to-dir'))
      && trySymlink(path.join(src, 'does-not-exist.md'), path.join(src, 'broken-link.md'));
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    let warnings;
    assert.doesNotThrow(() => {
      warnings = captureWarnings(() => copyDirSync(src, dest));
    });

    // Regular content is copied normally.
    assert.equal(fs.readFileSync(path.join(dest, 'regular.md'), 'utf8'), 'hello');
    assert.equal(fs.readFileSync(path.join(dest, 'realdir', 'inner.md'), 'utf8'), 'inner');
    // All three symlinks are skipped -- none exist in dest.
    assert.equal(fs.existsSync(path.join(dest, 'link-to-file.md')), false);
    assert.equal(fs.existsSync(path.join(dest, 'link-to-dir')), false);
    assert.equal(fs.existsSync(path.join(dest, 'broken-link.md')), false);
    // One warning per skipped symlink.
    assert.equal(warnings.length, 3);
  } finally {
    rmDir(root);
  }
});

test('listFilesRecursive: omits symlinks (file-target, dir-target, and broken) from the listing (C-09)', (t) => {
  const root = mkTmpDir('claude-sync-symlink-list-');
  try {
    fs.writeFileSync(path.join(root, 'regular.md'), 'hello');
    fs.mkdirSync(path.join(root, 'realdir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'realdir', 'inner.md'), 'inner');

    const ok = trySymlink(path.join(root, 'regular.md'), path.join(root, 'link-to-file.md'))
      && trySymlink(path.join(root, 'realdir'), path.join(root, 'link-to-dir'))
      && trySymlink(path.join(root, 'does-not-exist.md'), path.join(root, 'broken-link.md'));
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const result = listFilesRecursive(root);
    assert.deepEqual([...result].sort(), ['realdir/inner.md', 'regular.md']);
  } finally {
    rmDir(root);
  }
});

test('removeStalePaths: leaves a dest symlink alone instead of deleting it as stale, and still sweeps a genuinely stale regular file (C-09)', (t) => {
  const root = mkTmpDir('claude-sync-symlink-stale-');
  try {
    const src = path.join(root, 'src'); // empty -- nothing has a src counterpart
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'stale.md'), 'gone');
    fs.writeFileSync(path.join(dest, 'link-target.md'), 'x');

    const ok = trySymlink(path.join(dest, 'link-target.md'), path.join(dest, 'link.md'));
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    removeStalePaths(src, dest);

    // No src counterpart and not a symlink -- swept as stale, same as before.
    assert.equal(fs.existsSync(path.join(dest, 'stale.md')), false);
    // A symlink is left alone even with no src counterpart.
    assert.equal(fs.lstatSync(path.join(dest, 'link.md')).isSymbolicLink(), true);
  } finally {
    rmDir(root);
  }
});

// --- Part B: binary-safe content compare -----------------------------------
//
// 0xFF and 0xFE are each, on their own, invalid UTF-8 byte sequences, so
// Buffer.from([0xff]).toString('utf8') and Buffer.from([0xfe]).toString('utf8')
// both decode to the SAME single replacement character (U+FFFD) even though
// the underlying bytes are different. A utf8-string compare would (wrongly)
// call these two files equal; a Buffer compare correctly calls them different.

test('diffUserConfig(): binary files that decode to the same utf8 string but differ in bytes are reported modified (C-09)', () => {
  assert.equal(
    Buffer.from([0xff]).toString('utf8'),
    Buffer.from([0xfe]).toString('utf8'),
  );

  const root = mkTmpDir('claude-sync-binary-diff-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome);
    fs.mkdirSync(path.join(claudeHome, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'rules', 'img.bin'), Buffer.from([0xff]));

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir); // pushes rules/img.bin = 0xff as the initial commit

    // Change the LOCAL byte -- utf8-decodes identically to the pushed byte,
    // but is a genuinely different file.
    fs.writeFileSync(path.join(claudeHome, 'rules', 'img.bin'), Buffer.from([0xfe]));

    const diffs = engine.diffUserConfig();
    assert.deepEqual(diffs, [{ dir: 'rules', file: 'img.bin', status: 'modified' }]);
  } finally {
    rmDir(root);
  }
});

test('diffUserConfig(): identical binary content is reported unchanged (C-09)', () => {
  const root = mkTmpDir('claude-sync-binary-diff-same-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome);
    fs.mkdirSync(path.join(claudeHome, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'rules', 'img.bin'), Buffer.from([0xff]));

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    // No local edit after init -- local and pushed content are identical.
    const diffs = engine.diffUserConfig();
    assert.deepEqual(diffs, []);
  } finally {
    rmDir(root);
  }
});

test('getLocalDelta(): binary commands/ file that decodes to the same utf8 string but differs in bytes is reported changed (C-09)', () => {
  const root = mkTmpDir('claude-sync-binary-delta-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome);
    fs.mkdirSync(path.join(claudeHome, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'commands', 'icon.bin'), Buffer.from([0xff]));

    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);
    const lastSync = engine.loadLastSync();

    fs.writeFileSync(path.join(claudeHome, 'commands', 'icon.bin'), Buffer.from([0xfe]));

    const delta = engine.getLocalDelta(lastSync.commitHash);
    assert.deepEqual(delta.userConfigFiles, [{ dir: 'commands', file: 'icon.bin' }]);
  } finally {
    rmDir(root);
  }
});
