'use strict';

// Phase 2 (sync-pin): exportPluginVendorBundles() protects a vendored
// marketplace against upstream history rewrites. For each name the user
// opted into via config.vendorMarketplaces, it git-bundles the pinned
// commit's full reachable history into
// REPO_DIR/global/plugin-vendor/<name>/<commit>.bundle -- the bundle file's
// PRESENCE is itself the "this marketplace is vendored" signal, there is no
// lockfile flag. Bundle names are commit-named (not marketplace-named) so
// re-running with an unchanged pin is a no-op (git bundles aren't
// byte-deterministic across runs), and any bundle left over from a
// previously-pinned commit is pruned so only the current commit's survives.
//
// A bare commit sha is refused by `git bundle create` ("Refusing to create
// empty bundle") since it is not a ref -- verified empirically. The working
// form is: create a temporary tag at the commit, bundle that tag, then
// delete the tag. This works regardless of what the source repo's HEAD
// currently points at.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { git, setIdentity, writeAndCommit } = require('../helpers/git.js');

// Builds a plain local git repo at `dir` with commits, suitable for use as a
// marketplace "origin" -- same pattern as prepare-pinned-clone.test.js.
function makeSourceRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  setIdentity(dir);
  return dir;
}

// Seeds sync/config.json + (optionally) sync/repo/global/plugins.lock.json
// under a tmp CLAUDE_HOME, mirroring the shape exportPluginVendorBundles()
// reads.
function seedHome(claudeHome, opts = {}) {
  const syncDir = path.join(claudeHome, 'sync');
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(
    path.join(syncDir, 'config.json'),
    JSON.stringify({
      repo: 'git@example.com:me/sync.git',
      branch: 'main',
      vendorMarketplaces: opts.vendorMarketplaces || [],
    }, null, 2),
  );
  if (opts.lock) {
    const repoGlobalDir = path.join(syncDir, 'repo', 'global');
    fs.mkdirSync(repoGlobalDir, { recursive: true });
    fs.writeFileSync(path.join(repoGlobalDir, 'plugins.lock.json'), JSON.stringify(opts.lock, null, 2));
  }
}

function vendorDir(claudeHome, name) {
  return path.join(claudeHome, 'sync', 'repo', 'global', 'plugin-vendor', name);
}

test('exportPluginVendorBundles: creates a restorable commit-named bundle', () => {
  const root = mkTmpDir('claude-sync-vendor-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const engine = loadEngine(claudeHome);
    seedHome(claudeHome, {
      vendorMarketplaces: ['mp'],
      lock: { version: 1, marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } }, plugins: {} },
    });
    // Pin mp locally so the export has a source clone that has the commit --
    // reuses preparePinnedClone(), the same mechanism a real pin would use.
    const cloneRoot = path.join(claudeHome, 'sync', 'pinned-marketplaces');
    const prep = engine.preparePinnedClone('mp', sourceDir, commitX, { cloneRoot });
    assert.equal(prep.status, 'ready');

    const result = engine.exportPluginVendorBundles();

    assert.deepEqual(result, { vendored: [{ name: 'mp', commit: commitX, status: 'vendored' }], skipped: [] });

    const bundleFile = path.join(vendorDir(claudeHome, 'mp'), `${commitX}.bundle`);
    assert.ok(fs.existsSync(bundleFile), 'bundle file should exist');

    // Restorability: clone the bundle into a fresh dir and confirm the
    // pinned commit is actually present there.
    const restoreDir = path.join(root, 'restored');
    execFileSync('git', ['clone', bundleFile, restoreDir], { stdio: 'pipe' });
    assert.doesNotThrow(() => {
      execFileSync('git', ['-C', restoreDir, 'cat-file', '-e', `${commitX}^{commit}`], { stdio: 'pipe' });
    });
  } finally {
    rmDir(root);
  }
});

test('exportPluginVendorBundles: idempotent -- second call does not change the bundle bytes', () => {
  const root = mkTmpDir('claude-sync-vendor-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const engine = loadEngine(claudeHome);
    seedHome(claudeHome, {
      vendorMarketplaces: ['mp'],
      lock: { version: 1, marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } }, plugins: {} },
    });
    const cloneRoot = path.join(claudeHome, 'sync', 'pinned-marketplaces');
    engine.preparePinnedClone('mp', sourceDir, commitX, { cloneRoot });

    engine.exportPluginVendorBundles();
    const bundleFile = path.join(vendorDir(claudeHome, 'mp'), `${commitX}.bundle`);
    const first = fs.readFileSync(bundleFile);

    engine.exportPluginVendorBundles();
    const second = fs.readFileSync(bundleFile);

    assert.ok(first.equals(second), 'unchanged pin must not regenerate the bundle bytes');
  } finally {
    rmDir(root);
  }
});

test('exportPluginVendorBundles: prunes a stale bundle left over from a previously-pinned commit', () => {
  const root = mkTmpDir('claude-sync-vendor-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const engine = loadEngine(claudeHome);
    seedHome(claudeHome, {
      vendorMarketplaces: ['mp'],
      lock: { version: 1, marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } }, plugins: {} },
    });
    const cloneRoot = path.join(claudeHome, 'sync', 'pinned-marketplaces');
    engine.preparePinnedClone('mp', sourceDir, commitX, { cloneRoot });

    // Pre-plant a bundle for a commit that is no longer the pin.
    const dir = vendorDir(claudeHome, 'mp');
    fs.mkdirSync(dir, { recursive: true });
    const oldCommit = 'f'.repeat(40);
    fs.writeFileSync(path.join(dir, `${oldCommit}.bundle`), 'stale');

    engine.exportPluginVendorBundles();

    const entries = fs.readdirSync(dir);
    assert.deepEqual(entries, [`${commitX}.bundle`]);
  } finally {
    rmDir(root);
  }
});

test('exportPluginVendorBundles: prunes the bundle dir for a marketplace removed from config.vendorMarketplaces', () => {
  const root = mkTmpDir('claude-sync-vendor-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const engine = loadEngine(claudeHome);
    seedHome(claudeHome, {
      // 'oldmp' is no longer in the list -- only 'mp' is still vendored.
      vendorMarketplaces: ['mp'],
      lock: { version: 1, marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } }, plugins: {} },
    });
    const cloneRoot = path.join(claudeHome, 'sync', 'pinned-marketplaces');
    engine.preparePinnedClone('mp', sourceDir, commitX, { cloneRoot });

    // Pre-plant a leftover bundle dir for a marketplace no longer vendored.
    const oldDir = vendorDir(claudeHome, 'oldmp');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, `${'f'.repeat(40)}.bundle`), 'stale');

    engine.exportPluginVendorBundles();

    assert.equal(fs.existsSync(oldDir), false, 'de-vendored marketplace bundle dir must be pruned');
    const mpBundle = path.join(vendorDir(claudeHome, 'mp'), `${commitX}.bundle`);
    assert.ok(fs.existsSync(mpBundle), 'still-vendored marketplace bundle must remain');
  } finally {
    rmDir(root);
  }
});

test('exportPluginVendorBundles: empty config.vendorMarketplaces is a no-op', () => {
  const root = mkTmpDir('claude-sync-vendor-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const engine = loadEngine(claudeHome);
    seedHome(claudeHome, { vendorMarketplaces: [] });

    const result = engine.exportPluginVendorBundles();

    assert.deepEqual(result, { vendored: [], skipped: [] });
    assert.equal(fs.existsSync(path.join(claudeHome, 'sync', 'repo', 'global', 'plugin-vendor')), false);
  } finally {
    rmDir(root);
  }
});

test('exportPluginVendorBundles: no local source has the pinned commit -> skipped, no bundle written', () => {
  const root = mkTmpDir('claude-sync-vendor-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const engine = loadEngine(claudeHome);
    const commitX = 'a'.repeat(40);
    seedHome(claudeHome, {
      vendorMarketplaces: ['mp'],
      lock: { version: 1, marketplaces: { mp: { url: 'https://example.com/mp.git', pinnedCommit: commitX } }, plugins: {} },
    });
    // No pinned-marketplaces/mp clone, no known_marketplaces.json -- nothing
    // locally has the commit.

    const result = engine.exportPluginVendorBundles();

    assert.deepEqual(result, { vendored: [], skipped: [{ name: 'mp', status: 'no-source' }] });
    assert.equal(fs.existsSync(vendorDir(claudeHome, 'mp')), false);
  } finally {
    rmDir(root);
  }
});

test('exportAll: still returns an object containing unlockable (regression)', () => {
  const root = mkTmpDir('claude-sync-vendor-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    const engine = loadEngine(claudeHome);
    seedHome(claudeHome, { vendorMarketplaces: [] });

    const result = engine.exportAll();

    assert.ok(Object.prototype.hasOwnProperty.call(result, 'unlockable'));
    assert.deepEqual(result.unlockable, []);
  } finally {
    rmDir(root);
  }
});
