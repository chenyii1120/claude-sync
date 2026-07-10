'use strict';

// F-01 hook smoke tests: run hooks/session-end-check.js as a real
// subprocess. Setup goes through the real sync-engine (via loadEngine(),
// which sets CLAUDE_SYNC_HOME in *this* process) so the on-disk state is
// realistic, then the hook itself is spawned with HOME pointed at the
// parent of that same `.claude` dir — the hook (a thin launcher as of C-05)
// resolves its home directory via os.homedir()/CLAUDE_SYNC_HOME (C-08) as
// path.join(homedir, '.claude', ...), and os.homedir() reads $HOME on
// POSIX, so the fixture dir must literally be named `.claude` for the two
// to line up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');
const { runHook } = require('../helpers/run-hook.js');

// Returns { homeDir, claudeHome } where claudeHome === path.join(homeDir, '.claude'),
// matching what the hook itself will compute from process.env.HOME.
function mkHomeWithDotClaude(prefix) {
  const homeDir = mkTmpDir(prefix);
  const claudeHome = path.join(homeDir, '.claude');
  return { homeDir, claudeHome };
}

test('session-end-check.js: exits silently when sync is not initialized', () => {
  const { homeDir } = mkHomeWithDotClaude('claude-sync-hook-end-uninit-');
  try {
    const result = runHook('hooks/session-end-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    rmDir(homeDir);
  }
});

test('session-end-check.js: autoPush=false and no local changes prints nothing', () => {
  const root = mkTmpDir('claude-sync-hook-end-clean-');
  const { homeDir, claudeHome } = mkHomeWithDotClaude(undefined);
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir); // config defaults to autoPush:false; repo state matches local exactly

    const result = runHook('hooks/session-end-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  } finally {
    rmDir(root);
    rmDir(homeDir);
  }
});

test('session-end-check.js: autoPush=false with unpushed local changes reports them on stderr', () => {
  const root = mkTmpDir('claude-sync-hook-end-dirty-');
  const { homeDir, claudeHome } = mkHomeWithDotClaude(undefined);
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    // Unpushed local edit.
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));

    const result = runHook('hooks/session-end-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /\/sync-push/);

    // The hook's best-effort check must revert its own working-tree probe,
    // leaving the local file itself untouched.
    const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { theme: 'light' });
  } finally {
    rmDir(root);
    rmDir(homeDir);
  }
});

test('session-end-check.js: autoPush=true pushes local changes and reports success on stderr', () => {
  const root = mkTmpDir('claude-sync-hook-end-autopush-');
  const { homeDir, claudeHome } = mkHomeWithDotClaude(undefined);
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);
    engine.saveConfig({ ...engine.loadConfig(), autoPush: true });

    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));

    const result = runHook('hooks/session-end-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /已自動推送變更到遠端/);

    // Verify the push actually landed by checking the last-sync marker.
    const lastSync = engine.loadLastSync();
    assert.equal(lastSync.action, 'push');
  } finally {
    rmDir(root);
    rmDir(homeDir);
  }
});
