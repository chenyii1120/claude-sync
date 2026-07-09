'use strict';

// Fix F#1 (Codex, High, empirically confirmed exfiltration): C-09 added
// entry.isSymbolicLink() skips to copyDirSync/removeStalePaths/
// listFilesRecursive only. It never covered syncDirReportChanges() (A-02),
// which is what importUserConfig()/importPluginData() actually call to pull
// changes from the repo into CLAUDE_HOME. A malicious remote committing a
// symlink (e.g. user-config/commands/leak -> ~/.ssh/id_rsa) was FOLLOWED on
// pull: fs.readFileSync/fs.copyFileSync copied the LINK TARGET's content
// into CLAUDE_HOME as a regular file, and the next push exported+uploaded
// it -- arbitrary local-file exfiltration to a shared remote.
//
// This file covers the five remaining sites hardened by that fix:
//   1. syncDirReportChanges() -- both readdir loops (additions is the
//      exfiltration-critical one; deletions mirrors removeStalePaths).
//   2. computeDirChanges() -- the read-only preview twin, kept consistent.
//   3. pruneByDeleteSet() -- statSync -> lstatSync so a dest symlink-to-dir
//      is a leaf, never a recursion point.
//   4/5. exportPluginData() / createBackup() -- top-level plugin-data walk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { syncDirReportChanges, computeDirChanges } = require('../../lib/sync-engine.js');
const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

// Attempts to create a symlink; returns false (instead of throwing) if the
// platform refuses symlink creation (e.g. EPERM on Windows without
// dev-mode/admin), so callers can t.skip gracefully.
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

// --- 1. syncDirReportChanges: the exfiltration-critical additions loop ----

test('syncDirReportChanges: a repo-side symlink to a secret file is NOT copied into dest, its content is NOT read into CLAUDE_HOME, and a warning is emitted (F#1 exfiltration guard)', (t) => {
  const root = mkTmpDir('claude-sync-f1-exfil-');
  try {
    const secretFile = path.join(root, 'secret.txt');
    fs.writeFileSync(secretFile, 'TOP-SECRET-PRIVATE-KEY-CONTENTS');

    const src = path.join(root, 'repo-commands');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'normal.md'), 'hello');

    const ok = trySymlink(secretFile, path.join(src, 'leak'));
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const dest = path.join(root, 'dest-commands');
    let changes;
    const warnings = captureWarnings(() => {
      changes = syncDirReportChanges(src, dest);
    });

    // The normal file is imported as usual.
    assert.equal(fs.readFileSync(path.join(dest, 'normal.md'), 'utf8'), 'hello');
    // The symlink is skipped entirely -- not present in dest at all, as a
    // symlink OR (critically) as a regular file holding the target's bytes.
    assert.equal(fs.existsSync(path.join(dest, 'leak')), false);
    assert.deepEqual(fs.readdirSync(dest).sort(), ['normal.md']);
    // Not reported as an imported change.
    assert.deepEqual(changes, ['normal.md']);
    // A warning was emitted for the skipped symlink.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /skipping symlink/);
    assert.match(warnings[0], /leak/);
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: a dest-side symlink is left alone (not deleted) when it has no src counterpart, while a genuinely stale regular file is still swept', (t) => {
  const root = mkTmpDir('claude-sync-f1-delete-loop-');
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

    let changes;
    const warnings = captureWarnings(() => {
      changes = syncDirReportChanges(src, dest);
    });

    assert.deepEqual(changes.sort(), ['link-target.md', 'stale.md']);
    assert.equal(fs.existsSync(path.join(dest, 'stale.md')), false);
    // The symlink itself is untouched by the sweep.
    assert.equal(fs.lstatSync(path.join(dest, 'link.md')).isSymbolicLink(), true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /skipping symlink/);
  } finally {
    rmDir(root);
  }
});

// --- 2. computeDirChanges: read-only preview stays consistent with import -

test('computeDirChanges: a repo-side symlink is not reported as a pending change, consistent with syncDirReportChanges skipping it (F#1)', (t) => {
  const root = mkTmpDir('claude-sync-f1-preview-');
  try {
    const secretFile = path.join(root, 'secret.txt');
    fs.writeFileSync(secretFile, 'TOP-SECRET-PRIVATE-KEY-CONTENTS');

    const src = path.join(root, 'repo-commands');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'normal.md'), 'hello');

    const ok = trySymlink(secretFile, path.join(src, 'leak'));
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const dest = path.join(root, 'dest-commands'); // does not exist yet -- pure preview
    let changes;
    assert.doesNotThrow(() => {
      changes = computeDirChanges(src, dest);
    });

    assert.deepEqual(changes, ['normal.md']);
  } finally {
    rmDir(root);
  }
});

// --- 3. pruneByDeleteSet (exercised via syncDirReportChanges' deleteSet) --
//
// A top-level dest symlink is already caught by syncDirReportChanges' own
// deletion-loop skip (test above), so to exercise pruneByDeleteSet's own
// lstatSync fix specifically, the symlink must be NESTED inside a directory
// that has no src counterpart at all -- that subtree is walked by
// pruneByDeleteSet's own internal recursion, not the outer readdir loop.

test('pruneByDeleteSet: a nested dest symlink-to-dir is treated as a leaf -- not recursed into, not deleted, when its rel is NOT in the deleteSet', (t) => {
  const root = mkTmpDir('claude-sync-f1-prune-keep-');
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true }); // no 'staleDir' counterpart at all

    const dest = path.join(root, 'dest');
    const staleDir = path.join(dest, 'staleDir');
    fs.mkdirSync(staleDir, { recursive: true });

    const targetDir = path.join(root, 'external-target');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'inside.txt'), 'external target content');

    const ok = trySymlink(targetDir, path.join(staleDir, 'linkdir'));
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const deleteSet = new Set(); // 'staleDir/linkdir' is NOT a member
    const changes = syncDirReportChanges(src, dest, undefined, undefined, deleteSet);

    assert.deepEqual(changes, []);
    // The symlink itself survives, untouched.
    assert.equal(fs.lstatSync(path.join(staleDir, 'linkdir')).isSymbolicLink(), true);
    // staleDir survives too (not empty -- still holds the symlink).
    assert.equal(fs.existsSync(staleDir), true);
    // Critically: the external target was never walked into or touched.
    assert.equal(
      fs.readFileSync(path.join(targetDir, 'inside.txt'), 'utf8'),
      'external target content',
    );
  } finally {
    rmDir(root);
  }
});

test('pruneByDeleteSet: a nested dest symlink-to-dir is removed (the link only) when its rel IS in the deleteSet, and its target directory survives on disk', (t) => {
  const root = mkTmpDir('claude-sync-f1-prune-delete-');
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true });

    const dest = path.join(root, 'dest');
    const staleDir = path.join(dest, 'staleDir');
    fs.mkdirSync(staleDir, { recursive: true });

    const targetDir = path.join(root, 'external-target');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'inside.txt'), 'external target content');

    const ok = trySymlink(targetDir, path.join(staleDir, 'linkdir'));
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const deleteSet = new Set(['staleDir/linkdir']);
    const changes = syncDirReportChanges(src, dest, undefined, undefined, deleteSet);

    assert.deepEqual(changes, ['staleDir/linkdir']);
    // The symlink entry is gone...
    assert.equal(fs.existsSync(path.join(staleDir, 'linkdir')), false);
    // staleDir itself is now empty and swept too (same as the non-symlink
    // empty-directory-after-pruning behaviour).
    assert.equal(fs.existsSync(staleDir), false);
    // ...but the TARGET directory and its content were never touched --
    // only the link was removed, never anything reached through it.
    assert.equal(fs.existsSync(targetDir), true);
    assert.equal(
      fs.readFileSync(path.join(targetDir, 'inside.txt'), 'utf8'),
      'external target content',
    );
  } finally {
    rmDir(root);
  }
});

// --- 4/5. exportPluginData / createBackup: top-level plugin-data walk -----

test('exportPluginData / createBackup: a top-level plugins/ symlink is skipped (not copied into the repo or the backup), normal plugin data is still copied, and a warning is emitted (F#1)', (t) => {
  const root = mkTmpDir('claude-sync-f1-plugin-data-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome);

    const pluginsDir = path.join(claudeHome, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(path.join(pluginsDir, 'normal-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'normal-plugin', 'data.json'), '{}');

    const secretFile = path.join(root, 'plugin-secret.txt');
    fs.writeFileSync(secretFile, 'PLUGIN-SECRET-CONTENT');
    const ok = trySymlink(secretFile, path.join(pluginsDir, 'leak-link'));
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const engine = loadEngine(claudeHome);

    // exportPluginData() -- push side (repo).
    const exportWarnings = captureWarnings(() => engine.exportPluginData());
    const outDir = path.join(engine.REPO_DIR, 'global', 'plugin-data');
    assert.equal(fs.existsSync(path.join(outDir, 'leak-link')), false);
    assert.equal(
      fs.readFileSync(path.join(outDir, 'normal-plugin', 'data.json'), 'utf8'),
      '{}',
    );
    assert.ok(exportWarnings.some(w => /skipping symlink/.test(w) && w.includes('leak-link')));

    // createBackup() -- local backup side.
    let backupPath;
    const backupWarnings = captureWarnings(() => {
      backupPath = engine.createBackup();
    });
    assert.equal(fs.existsSync(path.join(backupPath, 'plugin-data', 'leak-link')), false);
    assert.equal(
      fs.readFileSync(path.join(backupPath, 'plugin-data', 'normal-plugin', 'data.json'), 'utf8'),
      '{}',
    );
    assert.ok(backupWarnings.some(w => /skipping symlink/.test(w) && w.includes('leak-link')));
  } finally {
    rmDir(root);
  }
});
