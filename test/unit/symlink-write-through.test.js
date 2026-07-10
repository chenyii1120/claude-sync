'use strict';

// F#9 (surfaced by the F#1 review, same class): the F#1 fixes guard the IMPORT
// side (repo -> ~/.claude), but the EXPORT/MERGE side writes to REPO_DIR managed
// paths with a plain writeFileSync/copyFileSync. A malicious remote can commit a
// symlink at such a path (e.g. global/settings.json); `reset --hard` materializes
// it, and the next exportSettings()/exportPluginConfigs()/exportPluginData()/
// performSmartMerge() would then write THROUGH the link to its target -- an
// arbitrary local-file overwrite with (constrained) content. unlinkIfSymlink()
// drops the link immediately before each such write, so a fresh regular file is
// written to the managed path and the link target is left untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

// Attempts to create a symlink; returns false (instead of throwing) if the
// platform refuses symlink creation (e.g. EPERM on Windows without admin).
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return false;
    throw err;
  }
}

test('exportSettings: a symlink planted at REPO_DIR/global/settings.json is neutralized -- the link target is NOT overwritten and settings.json becomes a regular file (F#9)', (t) => {
  const root = mkTmpDir('claude-sync-f9-settings-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark', model: 'sonnet' });

    // An external "victim" file the attacker's symlink points at.
    const victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'VICTIM-ORIGINAL-CONTENT');

    // Plant the symlink at the managed repo dest (what `reset --hard` on a
    // malicious remote commit would materialize before export runs).
    const repoGlobal = path.join(claudeHome, 'sync', 'repo', 'global');
    fs.mkdirSync(repoGlobal, { recursive: true });
    const outPath = path.join(repoGlobal, 'settings.json');
    const ok = trySymlink(victim, outPath);
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const engine = loadEngine(claudeHome);
    engine.exportSettings();

    // The victim file must be UNCHANGED -- the write did not follow the link.
    assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM-ORIGINAL-CONTENT', 'export must not write through the planted symlink to its target');

    // The managed path is now a regular file holding the exported settings.
    assert.equal(fs.lstatSync(outPath).isSymbolicLink(), false, 'settings.json must be a regular file, not the symlink');
    const exported = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(exported.theme, 'dark');
    assert.equal(exported.model, 'sonnet');
  } finally {
    rmDir(root);
  }
});

test('exportPluginConfigs: a symlink planted at REPO_DIR/global/installed_plugins.json is neutralized -- the link target is NOT overwritten (F#9)', (t) => {
  const root = mkTmpDir('claude-sync-f9-plugincfg-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    // Source plugin config that export reads and pushes.
    const pluginsDir = path.join(claudeHome, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ plugins: {} }));

    const victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'VICTIM-ORIGINAL-CONTENT');

    const repoGlobal = path.join(claudeHome, 'sync', 'repo', 'global');
    fs.mkdirSync(repoGlobal, { recursive: true });
    const outPath = path.join(repoGlobal, 'installed_plugins.json');
    const ok = trySymlink(victim, outPath);
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const engine = loadEngine(claudeHome);
    engine.exportPluginConfigs();

    assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM-ORIGINAL-CONTENT', 'export must not write through the planted symlink to its target');
    assert.equal(fs.lstatSync(outPath).isSymbolicLink(), false, 'installed_plugins.json must be a regular file, not the symlink');
    assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), { plugins: {} });
  } finally {
    rmDir(root);
  }
});

test('exportPluginData: a symlink planted at REPO_DIR/global/plugin-data/<name> (a DIR entry) is neutralized -- no write-through into the link target and the dest becomes a real directory (F#9 review)', (t) => {
  const root = mkTmpDir('claude-sync-f9-plugindata-dir-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });

    // Local plugin-data DIRECTORY that export copies (a dir entry -> copyDirSync
    // branch). The name is NOT in PLUGIN_DATA_EXCLUDE, so it IS exported.
    const pluginName = 'some-plugin';
    const srcDir = path.join(claudeHome, 'plugins', pluginName);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'data.json'), '{"exported":true}');

    // External "victim" directory with a known file the attacker's symlink targets.
    const victimDir = path.join(root, 'victim');
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, 'secret.txt'), 'VICTIM-ORIGINAL-CONTENT');

    // Plant a symlink at the managed dest dir root (what `reset --hard` on a
    // malicious remote commit would materialize before export runs). removeStalePaths
    // leaves dest symlinks in place, and copyDirSync's symlink skip is SOURCE-side
    // only -- so without the fix the export writes THROUGH the link into victimDir.
    const outDir = path.join(claudeHome, 'sync', 'repo', 'global', 'plugin-data');
    fs.mkdirSync(outDir, { recursive: true });
    const destPath = path.join(outDir, pluginName);
    const ok = trySymlink(victimDir, destPath);
    if (!ok) {
      t.skip('platform does not allow creating symlinks');
      return;
    }

    const engine = loadEngine(claudeHome);
    engine.exportPluginData();

    // (a) No write-through: the victim dir's file is unchanged and NO exported
    // plugin-data file leaked into the symlink target directory.
    assert.equal(fs.readFileSync(path.join(victimDir, 'secret.txt'), 'utf8'), 'VICTIM-ORIGINAL-CONTENT', 'export must not write through the planted dir symlink to its target');
    assert.equal(fs.existsSync(path.join(victimDir, 'data.json')), false, 'no plugin-data file may leak into the symlink target directory');

    // (b) The managed dest is now a REAL directory holding the exported file
    // (the link was unlinked -- only the link, not its target).
    assert.equal(fs.lstatSync(destPath).isSymbolicLink(), false, 'the dest dir root must be a real directory, not the planted symlink');
    assert.equal(fs.statSync(destPath).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(destPath, 'data.json'), 'utf8'), '{"exported":true}');
  } finally {
    rmDir(root);
  }
});
