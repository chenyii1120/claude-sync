'use strict';

// Phase 1B (sync-pin): applyPluginLock() reproduces the plugin versions
// recorded in plugins.lock.json on THIS machine -- for each marketplace it
// prepares a pinned local clone (preparePinnedClone, already tested in
// prepare-pinned-clone.test.js), registers it as a path-source marketplace,
// and reinstalls the plugins at the pinned commit.
//
// The `claude plugin` CLI mutates GLOBAL plugin state, so it's the one thing
// that MUST be injected: every test below passes a spy `runPlugin` that
// records the argv it would have run and returns success, without ever
// invoking the real `claude` binary. preparePinnedClone itself is exercised
// for real, against local git repos used as marketplace "remotes" (same
// pattern as prepare-pinned-clone.test.js).

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

// Seeds a fake ~/.claude with settings.enabledPlugins, plugins/*.json, a
// sync/config.json, and (optionally) a sync/repo/global/plugins.lock.json.
function seedHome(claudeHome, opts = {}) {
  const pluginsDir = path.join(claudeHome, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const syncDir = path.join(claudeHome, 'sync');
  fs.mkdirSync(syncDir, { recursive: true });

  fs.writeFileSync(
    path.join(claudeHome, 'settings.json'),
    JSON.stringify({ enabledPlugins: opts.enabledPlugins || {} }, null, 2),
  );
  fs.writeFileSync(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 1, plugins: opts.installedPlugins || {} }, null, 2),
  );
  fs.writeFileSync(
    path.join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify(opts.knownMarketplaces || {}, null, 2),
  );
  fs.writeFileSync(
    path.join(syncDir, 'config.json'),
    JSON.stringify({ repo: 'git@example.com:me/sync.git', branch: 'main', ...(opts.config || {}) }, null, 2),
  );

  if (opts.lock) {
    const globalDir = path.join(syncDir, 'repo', 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'plugins.lock.json'), JSON.stringify(opts.lock, null, 2));
  }
}

function makeSpy() {
  const calls = [];
  const runPlugin = (args) => { calls.push(args.join(' ')); return ''; };
  return { calls, runPlugin };
}

test('applyPluginLock: pinPlugins:false skips without calling the CLI', () => {
  const root = mkTmpDir('claude-sync-apl-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedHome(claudeHome, { config: { pinPlugins: false } });
    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.applyPluginLock({ runPlugin });

    assert.deepEqual(result, { skipped: 'disabled', results: [], unreproducible: [] });
    assert.deepEqual(calls, []);
  } finally {
    rmDir(root);
  }
});

test('applyPluginLock: no lockfile skips without calling the CLI', () => {
  const root = mkTmpDir('claude-sync-apl-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedHome(claudeHome, {}); // no `lock` -- no plugins.lock.json written
    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.applyPluginLock({ runPlugin });

    assert.deepEqual(result, { skipped: 'no-lock', results: [], unreproducible: [] });
    assert.deepEqual(calls, []);
  } finally {
    rmDir(root);
  }
});

test('applyPluginLock: happy path re-registers a differently-sourced marketplace and reinstalls its locked plugin', () => {
  const root = mkTmpDir('claude-sync-apl-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const expectedCloneDir = path.join(cloneRoot, 'mp');

    seedHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: { 'foo@mp': [{ version: '1.0.0' }] },
      knownMarketplaces: {
        // Registered from somewhere OTHER than the pinned clone dir --
        // simulates the plugin having originally come from a github source.
        mp: { installLocation: path.join(claudeHome, 'plugins', 'marketplaces', 'mp') },
      },
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } },
        plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.applyPluginLock({ runPlugin, prepareOpts: { cloneRoot } });

    assert.deepEqual(calls, [
      'marketplace remove mp',
      `marketplace add ${expectedCloneDir}`,
      'marketplace update mp',
      'uninstall foo@mp',
      'install foo@mp',
    ]);
    assert.deepEqual(result, {
      skipped: false,
      results: [{ name: 'mp', status: 'applied', commit: commitX, reinstalled: ['foo@mp'], disabled: [] }],
      unreproducible: [],
    });
  } finally {
    rmDir(root);
  }
});

test('applyPluginLock: no prior registration skips marketplace remove but still adds, updates, and reinstalls', () => {
  const root = mkTmpDir('claude-sync-apl-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const expectedCloneDir = path.join(cloneRoot, 'mp');

    seedHome(claudeHome, {
      installedPlugins: {},
      knownMarketplaces: {}, // mp not previously registered at all
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } },
        plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    engine.applyPluginLock({ runPlugin, prepareOpts: { cloneRoot } });

    assert.deepEqual(calls, [
      `marketplace add ${expectedCloneDir}`,
      'marketplace update mp',
      'uninstall foo@mp',
      'install foo@mp',
    ]);
  } finally {
    rmDir(root);
  }
});

test('applyPluginLock: unreproducible commit is reported and leaves installs untouched', () => {
  const root = mkTmpDir('claude-sync-apl-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const bogusCommit = 'f'.repeat(40);

    const cloneRoot = path.join(root, 'pinned-marketplaces');

    seedHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: { 'foo@mp': [{ version: '1.0.0' }] },
      knownMarketplaces: { mp: { installLocation: path.join(claudeHome, 'plugins', 'marketplaces', 'mp') } },
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: bogusCommit } },
        plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.applyPluginLock({ runPlugin, prepareOpts: { cloneRoot } });

    assert.deepEqual(result.results, [{ name: 'mp', status: 'unreproducible' }]);
    assert.deepEqual(result.unreproducible, ['mp']);
    assert.deepEqual(calls, [], 'the CLI must not be touched for a marketplace that could not be prepared');
  } finally {
    rmDir(root);
  }
});

test('applyPluginLock: a plugin disabled before pinning is re-disabled after reinstall', () => {
  const root = mkTmpDir('claude-sync-apl-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');

    seedHome(claudeHome, {
      enabledPlugins: { 'x@mp': false },
      installedPlugins: { 'x@mp': [{ version: '1.0.0' }] },
      knownMarketplaces: {},
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } },
        plugins: { 'x@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.applyPluginLock({ runPlugin, prepareOpts: { cloneRoot } });

    assert.deepEqual(calls[calls.length - 1], 'disable x@mp');
    assert.deepEqual(result.results[0].disabled, ['x@mp']);
  } finally {
    rmDir(root);
  }
});

test('applyPluginLock: a plugin installed locally but absent from the lock is still reinstalled (not orphaned)', () => {
  const root = mkTmpDir('claude-sync-apl-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');

    seedHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true, 'orphan@mp': true },
      installedPlugins: {
        'foo@mp': [{ version: '1.0.0' }],
        'orphan@mp': [{ version: '0.5.0' }], // locally installed, NOT in the lock below
      },
      knownMarketplaces: {},
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } },
        plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.applyPluginLock({ runPlugin, prepareOpts: { cloneRoot } });

    assert.deepEqual(result.results[0].reinstalled, ['foo@mp', 'orphan@mp']);
    assert.ok(calls.includes('uninstall orphan@mp'));
    assert.ok(calls.includes('install orphan@mp'));
  } finally {
    rmDir(root);
  }
});
