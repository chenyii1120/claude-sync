'use strict';

// Phase 1A: exportPluginLock() snapshots the versions of every ENABLED plugin
// into sync repo `global/plugins.lock.json`, so another machine can reproduce
// the exact same plugin versions on pull. The commit truth source is the
// `gitCommitSha` the CLI records per plugin in installed_plugins.json at
// install time (falls back to the marketplace clone HEAD). Design:
// docs/plans/2026-07-14-sync-pin-design.md §3, §5.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

// Seed a fake ~/.claude with settings.enabledPlugins + plugins/*.json and a
// sync/config.json. `opts` lets each test tweak the pieces it cares about.
function seedPluginHome(claudeHome, opts = {}) {
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
}

function readLock(claudeHome) {
  const p = path.join(claudeHome, 'sync', 'repo', 'global', 'plugins.lock.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('exportPluginLock: locks enabled plugins using gitCommitSha from installed_plugins.json', () => {
  const root = mkTmpDir('claude-sync-export-lock-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const installPath = path.join(claudeHome, 'plugins', 'cache', 'ecc');
    fs.mkdirSync(installPath, { recursive: true });

    seedPluginHome(claudeHome, {
      enabledPlugins: { 'ecc@everything-claude-code': true },
      installedPlugins: {
        'ecc@everything-claude-code': [
          {
            scope: 'user',
            installPath,
            version: '1.4.1',
            gitCommitSha: 'e4e94a7e70f124caea5847fff5a644c988da7b90',
          },
        ],
      },
      knownMarketplaces: {
        'everything-claude-code': {
          source: { source: 'github', repo: 'affaan-m/everything-claude-code' },
          installLocation: path.join(claudeHome, 'plugins', 'marketplaces', 'everything-claude-code'),
        },
      },
    });

    const engine = loadEngine(claudeHome);
    engine.exportPluginLock();

    const lock = readLock(claudeHome);
    assert.ok(lock, 'lockfile should be written');
    assert.equal(lock.version, 1);
    assert.deepEqual(lock.plugins['ecc@everything-claude-code'], {
      marketplace: 'everything-claude-code',
      version: '1.4.1',
    });
    assert.equal(
      lock.marketplaces['everything-claude-code'].pinnedCommit,
      'e4e94a7e70f124caea5847fff5a644c988da7b90',
    );
    assert.equal(
      lock.marketplaces['everything-claude-code'].url,
      'https://github.com/affaan-m/everything-claude-code.git',
    );
  } finally {
    rmDir(root);
  }
});

test('exportPluginLock: disabled or absent plugins are excluded from the lock', () => {
  const root = mkTmpDir('claude-sync-export-lock-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });

    seedPluginHome(claudeHome, {
      enabledPlugins: {
        'disabled-one@mp': false,
        // 'absent-one@mp' intentionally not listed at all
      },
      installedPlugins: {
        'disabled-one@mp': [{ scope: 'user', version: '1.0.0', gitCommitSha: 'a'.repeat(40) }],
      },
      knownMarketplaces: {
        mp: { source: { source: 'github', repo: 'someone/mp' } },
      },
    });

    const engine = loadEngine(claudeHome);
    engine.exportPluginLock();

    const lock = readLock(claudeHome);
    assert.ok(lock, 'lockfile should be written');
    assert.deepEqual(lock.plugins, {});
    assert.deepEqual(lock.marketplaces, {});
  } finally {
    rmDir(root);
  }
});

test('exportPluginLock: falls back to marketplace clone HEAD when gitCommitSha is missing', () => {
  const root = mkTmpDir('claude-sync-export-lock-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const cloneDir = path.join(claudeHome, 'sync', 'pinned-marketplaces', 'mp');
    fs.mkdirSync(cloneDir, { recursive: true });
    const { execFileSync } = require('child_process');
    execFileSync('git', ['init'], { cwd: cloneDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: cloneDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: cloneDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(cloneDir, 'file.txt'), 'hello');
    execFileSync('git', ['add', '-A'], { cwd: cloneDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: cloneDir, stdio: 'pipe' });
    const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir, stdio: 'pipe' })
      .toString()
      .trim();

    seedPluginHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: {
        'foo@mp': [{ scope: 'user', version: '2.0.0' }], // no gitCommitSha
      },
      knownMarketplaces: {
        mp: { source: { source: 'github', repo: 'someone/mp' } },
      },
    });

    const engine = loadEngine(claudeHome);
    engine.exportPluginLock();

    const lock = readLock(claudeHome);
    assert.equal(lock.marketplaces.mp.pinnedCommit, expectedHead);
    assert.deepEqual(lock.plugins['foo@mp'], { marketplace: 'mp', version: '2.0.0' });
  } finally {
    rmDir(root);
  }
});

test('exportPluginLock: unlockable plugin (no gitCommitSha, no clone) is reported and excluded', () => {
  const root = mkTmpDir('claude-sync-export-lock-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });

    seedPluginHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: {
        'foo@mp': [{ scope: 'user', version: '2.0.0' }], // no gitCommitSha
      },
      knownMarketplaces: {
        mp: { source: { source: 'github', repo: 'someone/mp' } }, // no installLocation, no clone dir
      },
    });

    const engine = loadEngine(claudeHome);
    const result = engine.exportPluginLock();

    assert.deepEqual(result.unlockable, ['foo@mp']);
    const lock = readLock(claudeHome);
    assert.deepEqual(lock.plugins, {});
    assert.deepEqual(lock.marketplaces, {});
  } finally {
    rmDir(root);
  }
});

test('exportPluginLock: pinPlugins:false skips writing the lockfile', () => {
  const root = mkTmpDir('claude-sync-export-lock-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });

    seedPluginHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: {
        'foo@mp': [{ scope: 'user', version: '2.0.0', gitCommitSha: 'a'.repeat(40) }],
      },
      knownMarketplaces: { mp: { source: { source: 'github', repo: 'someone/mp' } } },
      config: { pinPlugins: false },
    });

    const engine = loadEngine(claudeHome);
    const result = engine.exportPluginLock();

    assert.deepEqual(result, { skipped: true, unlockable: [] });
    assert.equal(readLock(claudeHome), null, 'lockfile should not be written');
  } finally {
    rmDir(root);
  }
});

test('exportPluginLock: idempotent -- calling twice with unchanged state writes identical bytes', () => {
  const root = mkTmpDir('claude-sync-export-lock-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });

    seedPluginHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: {
        'foo@mp': [{ scope: 'user', version: '2.0.0', gitCommitSha: 'a'.repeat(40) }],
      },
      knownMarketplaces: { mp: { source: { source: 'github', repo: 'someone/mp' } } },
    });

    const engine = loadEngine(claudeHome);
    const lockPath = path.join(claudeHome, 'sync', 'repo', 'global', 'plugins.lock.json');

    engine.exportPluginLock();
    const first = fs.readFileSync(lockPath, 'utf8');

    engine.exportPluginLock();
    const second = fs.readFileSync(lockPath, 'utf8');

    assert.equal(first, second, 'unchanged state must produce byte-identical lockfile');
  } finally {
    rmDir(root);
  }
});

test('exportPluginLock: multiple enabled plugins from the same marketplace share one marketplaces entry', () => {
  const root = mkTmpDir('claude-sync-export-lock-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });

    seedPluginHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true, 'bar@mp': true },
      installedPlugins: {
        'foo@mp': [{ scope: 'user', version: '1.0.0', gitCommitSha: 'a'.repeat(40) }],
        'bar@mp': [{ scope: 'user', version: '3.0.0', gitCommitSha: 'b'.repeat(40) }],
      },
      knownMarketplaces: { mp: { source: { source: 'github', repo: 'someone/mp' } } },
    });

    const engine = loadEngine(claudeHome);
    engine.exportPluginLock();

    const lock = readLock(claudeHome);
    assert.equal(Object.keys(lock.marketplaces).length, 1);
    // enabled ids are processed in alphabetical order ('bar@mp' before
    // 'foo@mp'), and the first commit seen for a marketplace wins.
    assert.equal(lock.marketplaces.mp.pinnedCommit, 'b'.repeat(40));
    assert.deepEqual(lock.plugins['foo@mp'], { marketplace: 'mp', version: '1.0.0' });
    assert.deepEqual(lock.plugins['bar@mp'], { marketplace: 'mp', version: '3.0.0' });
  } finally {
    rmDir(root);
  }
});

test('exportAll: returns { unlockable } shape', () => {
  const root = mkTmpDir('claude-sync-export-lock-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });

    seedPluginHome(claudeHome, {
      enabledPlugins: { 'foo@mp': true },
      installedPlugins: {
        'foo@mp': [{ scope: 'user', version: '2.0.0' }], // no gitCommitSha, no clone -> unlockable
      },
      knownMarketplaces: { mp: { source: { source: 'github', repo: 'someone/mp' } } },
    });

    const engine = loadEngine(claudeHome);
    const result = engine.exportAll();

    assert.deepEqual(result.unlockable, ['foo@mp']);
  } finally {
    rmDir(root);
  }
});
