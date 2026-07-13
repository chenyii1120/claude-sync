'use strict';

// Phase 1C (sync-pin): setPinnedRef() re-pins a marketplace to a specific git
// ref (tag/branch/sha) -- the upgrade primitive behind `/sync-pin set`.
// Resolves the ref to a commit sha in a local clone of the marketplace's
// origin url (fetching first so a newly-created tag/branch is reachable),
// then delegates to pinMarketplaceToCommit() for the actual
// clone/register/reinstall mechanics (already covered by
// migrate-marketplace.test.js / apply-plugin-lock.test.js).
//
// The `claude plugin` CLI mutates GLOBAL plugin state, so every test below
// passes a spy `runPlugin` that records the argv it would have run and
// returns success, without ever invoking the real `claude` binary.
// setPinnedRef itself runs real git against local repos used as marketplace
// "remotes" (same pattern as migrate-marketplace.test.js).

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

// Seeds a fake ~/.claude with a sync/config.json and (optionally) a
// sync/repo/global/plugins.lock.json -- same shape as migrate-marketplace.test.js.
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

test('setPinnedRef: invalid name returns invalid-name without touching the CLI', () => {
  const root = mkTmpDir('claude-sync-set-pinned-ref-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedHome(claudeHome);

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.setPinnedRef('../nope', 'v1.0.0', { runPlugin });

    assert.deepEqual(result, { name: '../nope', status: 'invalid-name' });
    assert.deepEqual(calls, []);
  } finally {
    rmDir(root);
  }
});

test('setPinnedRef: no url (no lock, no known marketplace) returns no-url without touching the CLI', () => {
  const root = mkTmpDir('claude-sync-set-pinned-ref-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedHome(claudeHome, { knownMarketplaces: {} });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.setPinnedRef('mp', 'v1.0.0', { runPlugin });

    assert.deepEqual(result, { name: 'mp', status: 'no-url' });
    assert.deepEqual(calls, []);
  } finally {
    rmDir(root);
  }
});

test('setPinnedRef: rejects an unsafe/invalid url from the lockfile and never touches the CLI', () => {
  const root = mkTmpDir('claude-sync-set-pinned-ref-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedHome(claudeHome, {
      lock: {
        version: 1,
        marketplaces: { mp: { url: "ext::sh -c x", pinnedCommit: 'f'.repeat(40) } },
        plugins: {},
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.setPinnedRef('mp', 'v1.0.0', { runPlugin });

    assert.deepEqual(result, { name: 'mp', status: 'invalid-url' });
    assert.deepEqual(calls, []);
  } finally {
    rmDir(root);
  }
});

test('setPinnedRef: a ref that does not exist returns bad-ref and touches no plugin state', () => {
  const root = mkTmpDir('claude-sync-set-pinned-ref-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');

    seedHome(claudeHome, {
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: 'f'.repeat(40) } },
        plugins: {},
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.setPinnedRef('mp', 'nope-9.9.9', { runPlugin });

    assert.deepEqual(result, { name: 'mp', status: 'bad-ref', ref: 'nope-9.9.9' });
    // A bad ref must be resolved BEFORE any pinMarketplaceToCommit call, so
    // it touches no install/uninstall/marketplace state.
    assert.deepEqual(calls.filter(c => /^(install|uninstall|marketplace)/.test(c)), []);
  } finally {
    rmDir(root);
  }
});

test('setPinnedRef: resolves a BRANCH ref to the fetched remote tip, not a stale local ref', () => {
  const root = mkTmpDir('claude-sync-set-pinned-ref-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commit1 = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneDir = path.join(claudeHome, 'sync', 'pinned-marketplaces', 'mp');

    seedHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: { 'foo@mp': [{ version: '1.0.0' }] },
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: commit1 } },
        plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    // Pre-create the pinned clone, checked out detached at commit1 -- same
    // shape a real prior pin leaves behind. The clone's local `main` branch
    // is therefore also stuck at commit1.
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    git(root, ['clone', sourceDir, cloneDir]);
    git(cloneDir, ['checkout', '--detach', commit1]);

    // Source repo's `main` advances AFTER the clone was made.
    writeAndCommit(sourceDir, 'file.txt', 'world', 'second commit');
    const commit2 = git(sourceDir, ['rev-parse', 'HEAD']);

    const engine = loadEngine(claudeHome);
    const { runPlugin } = makeSpy();

    const result = engine.setPinnedRef('mp', 'main', { runPlugin });

    assert.equal(result.status, 'applied');
    assert.equal(result.commit, commit2, 'branch ref must resolve to the fetched remote tip, not the stale local branch');
    assert.equal(result.ref, 'main');
  } finally {
    rmDir(root);
  }
});

test('setPinnedRef: happy path resolves a tag, clones, and delegates to pinMarketplaceToCommit', () => {
  const root = mkTmpDir('claude-sync-set-pinned-ref-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);
    git(sourceDir, ['tag', 'v1.0.0']);
    // A later commit, not covered by the tag -- proves we resolved the TAG,
    // not just HEAD.
    writeAndCommit(sourceDir, 'file.txt', 'world', 'second commit');

    const expectedCloneDir = path.join(claudeHome, 'sync', 'pinned-marketplaces', 'mp');

    seedHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: { 'foo@mp': [{ version: '1.0.0' }] },
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } },
        plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.setPinnedRef('mp', 'v1.0.0', { runPlugin });

    assert.deepEqual(calls, [
      `marketplace add ${expectedCloneDir}`,
      'marketplace update mp',
      'uninstall foo@mp',
      'install foo@mp',
    ]);
    assert.equal(result.status, 'applied');
    assert.equal(result.commit, commitX);
    assert.equal(result.ref, 'v1.0.0');
    assert.ok(fs.existsSync(expectedCloneDir));
    assert.equal(git(expectedCloneDir, ['rev-parse', 'HEAD']), commitX);
  } finally {
    rmDir(root);
  }
});
