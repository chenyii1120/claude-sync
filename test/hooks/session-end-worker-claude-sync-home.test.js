'use strict';

// Codex F#8: hooks/session-end-worker.js hardcoded
// path.join(os.homedir(), '.claude', ...) for its CONFIG_PATH/REPO_DIR
// preflight existence guard, while the launcher (hooks/session-end-check.js)
// and the engine itself (lib/sync-engine.js) both honor
// process.env.CLAUDE_SYNC_HOME. Under CLAUDE_SYNC_HOME, the worker's guard
// checked the WRONG path (HOME/.claude instead of CLAUDE_SYNC_HOME), found
// nothing there, and process.exit(0)'d before ever reaching the engine --
// silently skipping auto-push even though sync was properly initialized
// under CLAUDE_SYNC_HOME.
//
// This test sets HOME to a directory with NO sync setup at all, and
// CLAUDE_SYNC_HOME to a separate, fully-initialized-with-autoPush fixture.
// Before the fix, the worker would early-exit (no push, no stderr message)
// because it only ever looked under HOME. After the fix, it resolves the
// same CLAUDE_SYNC_HOME base as the launcher/engine, proceeds past the
// guard, and completes the auto-push.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');
const { runHook } = require('../helpers/run-hook.js');

test('session-end-worker.js: honors CLAUDE_SYNC_HOME for its preflight guard, not just $HOME/.claude (F#8)', () => {
  const root = mkTmpDir('claude-sync-worker-sync-home-');
  // HOME points at a directory with no `.claude` at all -- if the worker
  // (wrongly) resolves against $HOME, its preflight guard finds nothing and
  // exits silently.
  const bareHomeDir = mkTmpDir('claude-sync-worker-bare-home-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // The real sync setup lives under a CLAUDE_SYNC_HOME fixture, separate
    // from HOME/.claude.
    const syncHome = path.join(root, 'sync-home', '.claude');
    seedMinimalHome(syncHome, { theme: 'dark' });
    const engine = loadEngine(syncHome);
    engine.init(remoteDir);
    engine.saveConfig({ ...engine.loadConfig(), autoPush: true });

    // An unpushed local change, so a successful auto-push is observable.
    fs.writeFileSync(path.join(syncHome, 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));

    assert.equal(fs.existsSync(path.join(bareHomeDir, '.claude')), false, 'sanity: HOME has no sync setup');

    const result = runHook(
      'hooks/session-end-check.js',
      bareHomeDir,
      { CLAUDE_SYNC_HOME: syncHome },
    );

    assert.equal(result.status, 0);
    assert.match(
      result.stderr,
      /已自動推送變更到遠端/,
      'worker must reach the engine and auto-push under CLAUDE_SYNC_HOME, not early-exit against HOME',
    );

    // Confirm the push actually landed against the CLAUDE_SYNC_HOME fixture.
    const lastSync = engine.loadLastSync();
    assert.equal(lastSync.action, 'push');
  } finally {
    rmDir(root);
    rmDir(bareHomeDir);
  }
});
