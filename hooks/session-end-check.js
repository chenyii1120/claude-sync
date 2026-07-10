'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

// SessionEnd fires while Claude Code is shutting down, so it must return fast.
// The real work (which may fetch/merge/push over the network) runs in a child
// process with a hard wall-clock cap: spawnSync kills it at TIMEOUT_MS, so
// shutdown is never blocked longer than that. A killed worker leaves its sync
// lock owned by a now-dead pid, which acquireLock() reclaims automatically
// (C-03) — so a timeout is safe, not corrupting.
//
// (The previous setTimeout(...).unref() did nothing: the blocking git calls
// starved the event loop so the timer never fired, and .unref() meant it could
// not force an exit regardless.)
const TIMEOUT_MS = 10000;

const CLAUDE_HOME = process.env.CLAUDE_SYNC_HOME || path.join(os.homedir(), '.claude');
const CONFIG_PATH = path.join(CLAUDE_HOME, 'sync', 'config.json');
const REPO_DIR = path.join(CLAUDE_HOME, 'sync', 'repo');

// Nothing to do if sync isn't set up — don't even spawn a worker.
if (!fs.existsSync(REPO_DIR) || !fs.existsSync(CONFIG_PATH)) process.exit(0);

// Worker path is overridable via env purely so the timeout behavior can be
// tested with a sleeping stub without a real slow network. Defaults to the real
// worker in production.
const worker = process.env.CLAUDE_SYNC_END_WORKER || path.join(__dirname, 'session-end-worker.js');

const res = spawnSync(process.execPath, [worker], {
  timeout: TIMEOUT_MS,
  stdio: 'inherit',
  env: process.env,
});

// spawnSync sets res.error (code ETIMEDOUT) and/or kills with res.signal on
// timeout. Either signals we gave up. The worker handles its own internal
// failures and prints them itself, so a launcher-level error is effectively
// "worker didn't finish in time".
if (res.error || res.signal) {
  process.stderr.write('[claude-sync] ⚠️ 自動推送逾時（>10s），已放棄。請稍後手動執行 /sync-push。\n');
}
process.exit(0);
