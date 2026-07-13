'use strict';

// Phase 1C (sync-pin): migrateMarketplaceToPinned() pins a machine's CURRENT
// github-source marketplace to its CURRENT commit ("pin what you have now"),
// and reverseMigrateMarketplace() undoes a pin -- converts a claude-sync-
// managed path-source marketplace back to its original github source,
// reinstalling at latest, so a pin never becomes a permanent "zombie".
//
// Both share pinMarketplaceToCommit() (extracted from applyPluginLock() in
// this same change -- see apply-plugin-lock.test.js for its regression
// coverage) for the actual clone/register/reinstall mechanics.
//
// The `claude plugin` CLI mutates GLOBAL plugin state, so every test below
// passes a spy `runPlugin` that records the argv it would have run and
// returns success, without ever invoking the real `claude` binary.
// preparePinnedClone itself runs for real, against local git repos used as
// marketplace "remotes" (same pattern as apply-plugin-lock.test.js).

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

// ---------------------------------------------------------------------------
// migrateMarketplaceToPinned
// ---------------------------------------------------------------------------

test('migrateMarketplaceToPinned: happy path pins the marketplace at its installLocation HEAD', () => {
  const root = mkTmpDir('claude-sync-migrate-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    // known[name].installLocation IS the "github" clone -- a real git repo at
    // commit X -- so migrateMarketplaceToPinned() can read its HEAD directly.
    const installLocation = makeSourceRepo(path.join(root, 'github-clone'));
    writeAndCommit(installLocation, 'file.txt', 'hello', 'first commit');
    const commitX = git(installLocation, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const expectedCloneDir = path.join(cloneRoot, 'mp');

    seedHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: { 'foo@mp': [{ version: '1.0.0' }] },
      knownMarketplaces: {
        mp: {
          installLocation,
          source: { source: 'other', url: installLocation },
        },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.migrateMarketplaceToPinned('mp', { runPlugin, prepareOpts: { cloneRoot } });

    assert.deepEqual(calls, [
      'marketplace remove mp',
      `marketplace add ${expectedCloneDir}`,
      'marketplace update mp',
      'uninstall foo@mp',
      'install foo@mp',
    ]);
    assert.deepEqual(result, {
      name: 'mp',
      status: 'applied',
      commit: commitX,
      reinstalled: ['foo@mp'],
      disabled: [],
    });
    // The pinned clone was actually created and checked out at commitX.
    assert.ok(fs.existsSync(expectedCloneDir));
    assert.equal(git(expectedCloneDir, ['rev-parse', 'HEAD']), commitX);
  } finally {
    rmDir(root);
  }
});

test('migrateMarketplaceToPinned: falls back to an installed plugin gitCommitSha when installLocation is not a git repo', () => {
  const root = mkTmpDir('claude-sync-migrate-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const expectedCloneDir = path.join(cloneRoot, 'mp');

    // installLocation points at a plain (non-git) dir, forcing the fallback
    // to the installed plugin's recorded gitCommitSha. source is non-github
    // with an explicit url, so it resolves deterministically to sourceDir.
    const notAGitRepo = path.join(root, 'not-a-repo');
    fs.mkdirSync(notAGitRepo, { recursive: true });

    seedHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: { 'foo@mp': [{ version: '1.0.0', gitCommitSha: commitX }] },
      knownMarketplaces: {
        mp: {
          installLocation: notAGitRepo,
          source: { source: 'other', url: sourceDir },
        },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.migrateMarketplaceToPinned('mp', { runPlugin, prepareOpts: { cloneRoot } });

    assert.deepEqual(calls, [
      'marketplace remove mp',
      `marketplace add ${expectedCloneDir}`,
      'marketplace update mp',
      'uninstall foo@mp',
      'install foo@mp',
    ]);
    assert.equal(result.status, 'applied');
    assert.equal(result.commit, commitX);
  } finally {
    rmDir(root);
  }
});

test('migrateMarketplaceToPinned: unknown marketplace returns unknown-marketplace without calling the CLI', () => {
  const root = mkTmpDir('claude-sync-migrate-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedHome(claudeHome, { knownMarketplaces: {} });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.migrateMarketplaceToPinned('mp', { runPlugin });

    assert.deepEqual(result, { name: 'mp', status: 'unknown-marketplace' });
    assert.deepEqual(calls, []);
  } finally {
    rmDir(root);
  }
});

test('migrateMarketplaceToPinned: no url on the known marketplace returns no-url without calling the CLI', () => {
  const root = mkTmpDir('claude-sync-migrate-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedHome(claudeHome, {
      knownMarketplaces: { mp: { installLocation: '/nowhere', source: { source: 'other' } } },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.migrateMarketplaceToPinned('mp', { runPlugin });

    assert.deepEqual(result, { name: 'mp', status: 'no-url' });
    assert.deepEqual(calls, []);
  } finally {
    rmDir(root);
  }
});

// ---------------------------------------------------------------------------
// reverseMigrateMarketplace
// ---------------------------------------------------------------------------

test('reverseMigrateMarketplace: happy path re-adds the original github url and reinstalls at latest', () => {
  const root = mkTmpDir('claude-sync-reverse-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const managedCloneDir = path.join(claudeHome, 'sync', 'pinned-marketplaces', 'mp');
    fs.mkdirSync(managedCloneDir, { recursive: true });
    fs.writeFileSync(path.join(managedCloneDir, 'marker.txt'), 'managed clone');

    seedHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: { 'foo@mp': [{ version: '1.0.0', gitCommitSha: commitX }] },
      knownMarketplaces: { mp: { installLocation: managedCloneDir } },
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } },
        plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.reverseMigrateMarketplace('mp', { runPlugin });

    assert.deepEqual(calls, [
      'marketplace remove mp',
      `marketplace add ${sourceDir}`,
      'marketplace update mp',
      'uninstall foo@mp',
      'install foo@mp',
    ]);
    assert.deepEqual(result, {
      name: 'mp',
      status: 'unpinned',
      reinstalled: ['foo@mp'],
      disabled: [],
    });
    // The managed clone dir is removed so it can't be silently re-registered.
    assert.ok(!fs.existsSync(managedCloneDir));
  } finally {
    rmDir(root);
  }
});

test('reverseMigrateMarketplace: no origin url anywhere returns no-origin-url without calling the CLI', () => {
  const root = mkTmpDir('claude-sync-reverse-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedHome(claudeHome, {
      knownMarketplaces: { mp: { installLocation: path.join(claudeHome, 'sync', 'pinned-marketplaces', 'mp') } },
      // no `lock` written -- no plugins.lock.json, and known[mp] has no source.url either
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.reverseMigrateMarketplace('mp', { runPlugin });

    assert.deepEqual(result, { name: 'mp', status: 'no-origin-url' });
    assert.deepEqual(calls, []);
  } finally {
    rmDir(root);
  }
});

test('reverseMigrateMarketplace: rejects an unsafe/invalid origin url from the lockfile and never touches the CLI', () => {
  const root = mkTmpDir('claude-sync-reverse-');
  const unsafeUrls = ["ext::sh -c 'touch /tmp/pwned'", '--upload-pack=x'];
  try {
    for (const unsafeUrl of unsafeUrls) {
      const claudeHome = path.join(root, `claude-home-${unsafeUrls.indexOf(unsafeUrl)}`);
      seedHome(claudeHome, {
        installedPlugins: { 'foo@mp': [{ version: '1.0.0' }] },
        knownMarketplaces: { mp: { installLocation: path.join(claudeHome, 'sync', 'pinned-marketplaces', 'mp') } },
        lock: {
          version: 1,
          marketplaces: { mp: { url: unsafeUrl, pinnedCommit: 'f'.repeat(40) } },
          plugins: {},
        },
      });

      const engine = loadEngine(claudeHome);
      const { calls, runPlugin } = makeSpy();

      const result = engine.reverseMigrateMarketplace('mp', { runPlugin });

      assert.deepEqual(result, { name: 'mp', status: 'invalid-origin-url' });
      assert.deepEqual(calls, [], `CLI must not be touched for unsafe url: ${unsafeUrl}`);
    }
  } finally {
    rmDir(root);
  }
});

test('reverseMigrateMarketplace: falls back to known_marketplaces.json source url when there is no lock', () => {
  const root = mkTmpDir('claude-sync-reverse-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');

    seedHome(claudeHome, {
      installedPlugins: {},
      knownMarketplaces: {
        mp: {
          installLocation: path.join(claudeHome, 'sync', 'pinned-marketplaces', 'mp'),
          source: { source: 'other', url: sourceDir },
        },
      },
      // no `lock` written
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.reverseMigrateMarketplace('mp', { runPlugin });

    assert.deepEqual(calls, [
      'marketplace remove mp',
      `marketplace add ${sourceDir}`,
      'marketplace update mp',
    ]);
    assert.equal(result.status, 'unpinned');
  } finally {
    rmDir(root);
  }
});

test('reverseMigrateMarketplace: re-disables a plugin that was disabled before unpinning', () => {
  const root = mkTmpDir('claude-sync-reverse-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    seedHome(claudeHome, {
      enabledPlugins: { 'x@mp': false },
      installedPlugins: { 'x@mp': [{ version: '1.0.0', gitCommitSha: commitX }] },
      knownMarketplaces: { mp: { installLocation: path.join(claudeHome, 'sync', 'pinned-marketplaces', 'mp') } },
      lock: {
        version: 1,
        marketplaces: { mp: { url: sourceDir, pinnedCommit: commitX } },
        plugins: { 'x@mp': { marketplace: 'mp', version: '1.0.0' } },
      },
    });

    const engine = loadEngine(claudeHome);
    const { calls, runPlugin } = makeSpy();

    const result = engine.reverseMigrateMarketplace('mp', { runPlugin });

    assert.deepEqual(calls[calls.length - 1], 'disable x@mp');
    assert.deepEqual(result.disabled, ['x@mp']);
  } finally {
    rmDir(root);
  }
});
