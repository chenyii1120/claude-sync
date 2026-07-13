'use strict';

// Phase 1A (sync-pin), read-only: getPluginLockDrift() compares the plugin
// lock recorded at a git ref (global/plugins.lock.json) against what's
// actually installed on this machine right now, so /sync-status and
// pull-preview can show drift without any apply/mutation logic. Design:
// docs/plans/2026-07-14-sync-pin-design.md §3, §5.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { git, setIdentity } = require('../helpers/git.js');

// REPO_DIR must itself be a git repo with real commits for readJsonAtRef()
// (used internally by getPluginLockDrift) to resolve 'HEAD'. No remote is
// needed for HEAD-ref tests.
function initRepoDir(claudeHome) {
  const repoDir = path.join(claudeHome, 'sync', 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-b', 'main']);
  setIdentity(repoDir);
  return repoDir;
}

function commitLock(repoDir, lock, message) {
  const full = path.join(repoDir, 'global', 'plugins.lock.json');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(lock, null, 2));
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', message || 'add lock']);
}

function commitPlaceholder(repoDir) {
  const full = path.join(repoDir, 'README.md');
  fs.writeFileSync(full, '# placeholder\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', 'placeholder, no lockfile']);
}

function writeInstalled(claudeHome, plugins) {
  const pluginsDir = path.join(claudeHome, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({ version: 1, plugins }, null, 2),
  );
}

function writeSettings(claudeHome, enabledPlugins) {
  fs.writeFileSync(
    path.join(claudeHome, 'settings.json'),
    JSON.stringify({ enabledPlugins: enabledPlugins || {} }, null, 2),
  );
}

test('getPluginLockDrift: returns [] when there is no lockfile at the ref', () => {
  const root = mkTmpDir('claude-sync-plugin-drift-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = initRepoDir(claudeHome);
    commitPlaceholder(repoDir);

    const engine = loadEngine(claudeHome);
    const rows = engine.getPluginLockDrift('HEAD');
    assert.deepEqual(rows, []);
  } finally {
    rmDir(root);
  }
});

test('getPluginLockDrift: in-sync when installed gitCommitSha matches locked pinnedCommit', () => {
  const root = mkTmpDir('claude-sync-plugin-drift-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = initRepoDir(claudeHome);
    commitLock(repoDir, {
      version: 1,
      marketplaces: { mp: { url: 'https://example.com/mp.git', pinnedCommit: 'abc123' } },
      plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
    });

    writeInstalled(claudeHome, {
      'foo@mp': [{ version: '1.0.0', gitCommitSha: 'abc123' }],
    });
    writeSettings(claudeHome, { 'foo@mp': true });

    const engine = loadEngine(claudeHome);
    const rows = engine.getPluginLockDrift('HEAD');
    assert.deepEqual(rows, [{
      plugin: 'foo@mp',
      lockedVersion: '1.0.0',
      lockedCommit: 'abc123',
      currentVersion: '1.0.0',
      currentCommit: 'abc123',
      action: 'in-sync',
    }]);
  } finally {
    rmDir(root);
  }
});

test('getPluginLockDrift: reinstall when installed commit differs from locked commit', () => {
  const root = mkTmpDir('claude-sync-plugin-drift-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = initRepoDir(claudeHome);
    commitLock(repoDir, {
      version: 1,
      marketplaces: { mp: { url: 'https://example.com/mp.git', pinnedCommit: 'abc123' } },
      plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
    });

    writeInstalled(claudeHome, {
      'foo@mp': [{ version: '1.1.0', gitCommitSha: 'def456' }],
    });
    writeSettings(claudeHome, { 'foo@mp': true });

    const engine = loadEngine(claudeHome);
    const rows = engine.getPluginLockDrift('HEAD');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'reinstall');
    assert.equal(rows[0].currentCommit, 'def456');
    assert.equal(rows[0].lockedCommit, 'abc123');
  } finally {
    rmDir(root);
  }
});

test('getPluginLockDrift: missing when locked plugin is not installed at all', () => {
  const root = mkTmpDir('claude-sync-plugin-drift-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = initRepoDir(claudeHome);
    commitLock(repoDir, {
      version: 1,
      marketplaces: { mp: { url: 'https://example.com/mp.git', pinnedCommit: 'abc123' } },
      plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
    });

    writeInstalled(claudeHome, {});
    writeSettings(claudeHome, {});

    const engine = loadEngine(claudeHome);
    const rows = engine.getPluginLockDrift('HEAD');
    assert.deepEqual(rows, [{
      plugin: 'foo@mp',
      lockedVersion: '1.0.0',
      lockedCommit: 'abc123',
      currentVersion: null,
      currentCommit: null,
      action: 'missing',
    }]);
  } finally {
    rmDir(root);
  }
});

test('getPluginLockDrift: unlocked when a plugin is enabled locally but absent from the lock', () => {
  const root = mkTmpDir('claude-sync-plugin-drift-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = initRepoDir(claudeHome);
    commitLock(repoDir, {
      version: 1,
      marketplaces: {},
      plugins: {},
    });

    writeInstalled(claudeHome, {
      'bar@mp': [{ version: '2.0.0', gitCommitSha: 'zzz999' }],
    });
    writeSettings(claudeHome, { 'bar@mp': true });

    const engine = loadEngine(claudeHome);
    const rows = engine.getPluginLockDrift('HEAD');
    assert.deepEqual(rows, [{
      plugin: 'bar@mp',
      lockedVersion: null,
      lockedCommit: null,
      currentVersion: '2.0.0',
      currentCommit: 'zzz999',
      action: 'unlocked',
    }]);
  } finally {
    rmDir(root);
  }
});

test('getPluginLockDrift: rows are sorted alphabetically by plugin name', () => {
  const root = mkTmpDir('claude-sync-plugin-drift-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = initRepoDir(claudeHome);
    commitLock(repoDir, {
      version: 1,
      marketplaces: { mp: { url: 'https://example.com/mp.git', pinnedCommit: 'c1' } },
      plugins: {
        'zeta@mp': { marketplace: 'mp', version: '1.0.0' },
        'alpha@mp': { marketplace: 'mp', version: '1.0.0' },
      },
    });

    writeInstalled(claudeHome, {
      'zeta@mp': [{ version: '1.0.0', gitCommitSha: 'c1' }],
      'alpha@mp': [{ version: '1.0.0', gitCommitSha: 'c1' }],
    });
    writeSettings(claudeHome, { 'zeta@mp': true, 'alpha@mp': true });

    const engine = loadEngine(claudeHome);
    const rows = engine.getPluginLockDrift('HEAD');
    assert.deepEqual(rows.map(r => r.plugin), ['alpha@mp', 'zeta@mp']);
  } finally {
    rmDir(root);
  }
});

test('getStatus: includes a pluginDrift array and never throws when the repo has no lockfile', () => {
  const root = mkTmpDir('claude-sync-plugin-drift-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = initRepoDir(claudeHome);
    commitPlaceholder(repoDir);

    fs.writeFileSync(
      path.join(claudeHome, 'sync', 'config.json'),
      JSON.stringify({ repo: 'git@example.com:me/sync.git', branch: 'main' }, null, 2),
    );
    writeSettings(claudeHome, {});

    const engine = loadEngine(claudeHome);
    const status = engine.getStatus();
    assert.ok(Array.isArray(status.pluginDrift));
    assert.deepEqual(status.pluginDrift, []);
  } finally {
    rmDir(root);
  }
});

test('getPluginLockDrift: never throws when installed_plugins.json is absent', () => {
  const root = mkTmpDir('claude-sync-plugin-drift-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = initRepoDir(claudeHome);
    commitLock(repoDir, {
      version: 1,
      marketplaces: { mp: { url: 'https://example.com/mp.git', pinnedCommit: 'abc123' } },
      plugins: { 'foo@mp': { marketplace: 'mp', version: '1.0.0' } },
    });
    writeSettings(claudeHome, {});
    // no plugins/installed_plugins.json written at all

    const engine = loadEngine(claudeHome);
    const rows = engine.getPluginLockDrift('HEAD');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'missing');
  } finally {
    rmDir(root);
  }
});
