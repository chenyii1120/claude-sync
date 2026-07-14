'use strict';

// Phase 2 (sync-pin): vendor-bundle restore fallback in preparePinnedClone().
// exportPluginVendorBundles() (already merged) stashes a `git bundle` of a
// vendored marketplace's pinned commit at
// REPO_DIR/global/plugin-vendor/<name>/<commit>.bundle. This is the RESTORE
// side: when the pinned commit can no longer be fetched from the upstream
// origin (history rewritten, force-pushed away), preparePinnedClone() falls
// back to the bundle -- either by fetching its refs into an existing clone,
// or by cloning directly FROM the bundle when the origin clone itself fails.
//
// opts.vendorBundle is OPTIONAL and additive: every existing
// prepare-pinned-clone.test.js scenario (no vendorBundle) must behave
// byte-identically to before this change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { git, setIdentity, writeAndCommit } = require('../helpers/git.js');

function makeSourceRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  setIdentity(dir);
  return dir;
}

// Bundles `commit`'s full reachable history out of `sourceDir`, the same
// tag-then-bundle-then-untag dance exportPluginVendorBundles() uses (a bare
// commit sha isn't a ref, so `git bundle create` refuses it directly).
function makeBundle(sourceDir, commit, bundleFile) {
  fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
  git(sourceDir, ['tag', 'vendor-tmp', commit]);
  git(sourceDir, ['bundle', 'create', bundleFile, 'vendor-tmp']);
  git(sourceDir, ['tag', '-d', 'vendor-tmp']);
}

test('preparePinnedClone: restores a commit missing from origin via bundle fetch', () => {
  const root = mkTmpDir('claude-sync-vr-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);

    // origin: a valid repo that does NOT contain commit X (simulates a
    // force-push that rewrote X away upstream).
    const originDir = makeSourceRepo(path.join(root, 'origin'));
    writeAndCommit(originDir, 'origin.txt', 'origin content', 'origin commit');

    // vendor source: a separate repo whose commit X is what got pinned.
    const vendorSrc = makeSourceRepo(path.join(root, 'vendor-src'));
    writeAndCommit(vendorSrc, 'vendor.txt', 'vendor content', 'vendor commit');
    const commitX = git(vendorSrc, ['rev-parse', 'HEAD']);

    const bundleFile = path.join(root, 'vendor', `${commitX}.bundle`);
    makeBundle(vendorSrc, commitX, bundleFile);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const result = engine.preparePinnedClone('mp', originDir, commitX, { cloneRoot, vendorBundle: bundleFile });

    assert.equal(result.status, 'ready');
    assert.equal(git(result.cloneDir, ['rev-parse', 'HEAD']), commitX);
  } finally {
    rmDir(root);
  }
});

test('preparePinnedClone: restores by cloning directly from the bundle when the origin clone fails', () => {
  const root = mkTmpDir('claude-sync-vr-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);

    // origin: an existing directory that is NOT a git repo -- passes
    // validateRemoteUrl (existing local dir) but `git clone` against it fails.
    const originUrl = path.join(root, 'not-a-repo');
    fs.mkdirSync(originUrl, { recursive: true });

    const vendorSrc = makeSourceRepo(path.join(root, 'vendor-src'));
    writeAndCommit(vendorSrc, 'vendor.txt', 'vendor content', 'vendor commit');
    const commitX = git(vendorSrc, ['rev-parse', 'HEAD']);

    const bundleFile = path.join(root, 'vendor', `${commitX}.bundle`);
    makeBundle(vendorSrc, commitX, bundleFile);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const result = engine.preparePinnedClone('mp', originUrl, commitX, { cloneRoot, vendorBundle: bundleFile });

    assert.equal(result.status, 'ready');
    assert.equal(git(result.cloneDir, ['rev-parse', 'HEAD']), commitX);
  } finally {
    rmDir(root);
  }
});

test('preparePinnedClone: still unreproducible without a bundle (regression)', () => {
  const root = mkTmpDir('claude-sync-vr-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);

    const originDir = makeSourceRepo(path.join(root, 'origin'));
    writeAndCommit(originDir, 'origin.txt', 'origin content', 'origin commit');

    const vendorSrc = makeSourceRepo(path.join(root, 'vendor-src'));
    writeAndCommit(vendorSrc, 'vendor.txt', 'vendor content', 'vendor commit');
    const commitX = git(vendorSrc, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');

    // No vendorBundle at all.
    const withoutOpt = engine.preparePinnedClone('mp', originDir, commitX, { cloneRoot });
    assert.deepEqual(withoutOpt, { status: 'unreproducible', commit: commitX });

    // vendorBundle pointing at a path that doesn't exist -- same result.
    const bogusBundle = path.join(root, 'vendor', `${commitX}.bundle`);
    const cloneRoot2 = path.join(root, 'pinned-marketplaces-2');
    const withMissingBundle = engine.preparePinnedClone('mp', originDir, commitX, { cloneRoot: cloneRoot2, vendorBundle: bogusBundle });
    assert.deepEqual(withMissingBundle, { status: 'unreproducible', commit: commitX });
  } finally {
    rmDir(root);
  }
});

test('pinMarketplaceToCommit: auto-discovers the conventional vendor bundle path and restores through it', () => {
  const root = mkTmpDir('claude-sync-vr-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const pluginsDir = path.join(claudeHome, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });

    // origin lacks commit X (upstream rewritten).
    const originDir = makeSourceRepo(path.join(root, 'origin'));
    writeAndCommit(originDir, 'origin.txt', 'origin content', 'origin commit');

    const vendorSrc = makeSourceRepo(path.join(root, 'vendor-src'));
    writeAndCommit(vendorSrc, 'vendor.txt', 'vendor content', 'vendor commit');
    const commitX = git(vendorSrc, ['rev-parse', 'HEAD']);

    const engine = loadEngine(claudeHome);

    // Seed REPO_DIR/global/plugin-vendor/mp/<commitX>.bundle at the
    // conventional path pinMarketplaceToCommit() must discover on its own.
    const bundleFile = path.join(claudeHome, 'sync', 'repo', 'global', 'plugin-vendor', 'mp', `${commitX}.bundle`);
    makeBundle(vendorSrc, commitX, bundleFile);

    fs.writeFileSync(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ version: 1, plugins: { 'foo@mp': [{ version: '1.0.0' }] } }, null, 2),
    );
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'foo@mp': true } }, null, 2));
    fs.writeFileSync(path.join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({}, null, 2));

    const calls = [];
    const runPlugin = (args) => { calls.push(args.join(' ')); return ''; };

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const result = engine.pinMarketplaceToCommit('mp', originDir, commitX, { runPlugin, prepareOpts: { cloneRoot } });

    assert.equal(result.status, 'applied');
    const cloneDir = path.join(cloneRoot, 'mp');
    assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), commitX);
    assert.ok(calls.includes(`marketplace add ${cloneDir}`));
  } finally {
    rmDir(root);
  }
});
