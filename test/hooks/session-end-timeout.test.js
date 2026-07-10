'use strict';

// C-05: hooks/session-end-check.js is a thin launcher that spawns the real
// work (hooks/session-end-worker.js) as a child process with a hard 10s
// wall-clock cap, so a slow/unreachable network can never block Claude Code
// shutdown. These tests swap in deterministic, network-free worker fixtures
// via the CLAUDE_SYNC_END_WORKER env seam instead of exercising a real
// slow network.
//
// Empirically verified spawnSync timeout shape (see task report): on
// timeout, spawnSync kills the child with SIGTERM (res.signal === 'SIGTERM')
// AND sets res.error with res.error.code === 'ETIMEDOUT'. The launcher
// treats `res.error || res.signal` as "gave up".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { runHook } = require('../helpers/run-hook.js');

// Minimal on-disk state so the launcher's own early-exit check
// (fs.existsSync(REPO_DIR) && fs.existsSync(CONFIG_PATH)) passes and it
// proceeds to spawn the worker. Contents don't matter -- with
// CLAUDE_SYNC_END_WORKER set, the real worker (which would need a real repo)
// never runs.
function seedInitialized(homeDir) {
  const repoDir = path.join(homeDir, '.claude', 'sync', 'repo');
  const configPath = path.join(homeDir, '.claude', 'sync', 'config.json');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ repo: 'file:///nonexistent' }));
  return { repoDir, configPath };
}

test('session-end-check.js: worker exceeding the 10s cap is killed and reported, not left blocking', () => {
  const homeDir = mkTmpDir('claude-sync-hook-end-timeout-');
  try {
    seedInitialized(homeDir);

    // Blocks ~20s via a real synchronous sleep (Atomics.wait) -- far longer
    // than the launcher's 10s cap -- with no network or event-loop
    // dependency, so the test is deterministic.
    const fixture = path.join(homeDir, 'sleepy-worker.js');
    fs.writeFileSync(
      fixture,
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);\n"
    );

    const start = Date.now();
    const result = runHook(
      'hooks/session-end-check.js',
      homeDir,
      { CLAUDE_SYNC_END_WORKER: fixture },
      { timeoutMs: 20000 }
    );
    const elapsed = Date.now() - start;

    assert.equal(result.status, 0);
    assert.ok(elapsed <= 13000, `expected launcher to give up within ~13s, took ${elapsed}ms`);
    assert.match(result.stderr, /自動推送逾時/);
  } finally {
    rmDir(homeDir);
  }
});

test('session-end-check.js: fast-finishing worker is not delayed and its output passes through', () => {
  const homeDir = mkTmpDir('claude-sync-hook-end-fastworker-');
  try {
    seedInitialized(homeDir);

    const fixture = path.join(homeDir, 'fast-worker.js');
    fs.writeFileSync(fixture, "process.stderr.write('fast-worker-ran\\n');\n");

    const start = Date.now();
    const result = runHook(
      'hooks/session-end-check.js',
      homeDir,
      { CLAUDE_SYNC_END_WORKER: fixture },
      { timeoutMs: 15000 }
    );
    const elapsed = Date.now() - start;

    assert.equal(result.status, 0);
    assert.ok(elapsed <= 2000, `expected launcher to return quickly, took ${elapsed}ms`);
    // stdio: 'inherit' on the inner spawnSync means the worker's own stderr
    // writes flow straight through to the launcher's stderr.
    assert.match(result.stderr, /fast-worker-ran/);
  } finally {
    rmDir(homeDir);
  }
});

test('session-end-check.js: exits silently (no worker spawned) when sync is not initialized', () => {
  const homeDir = mkTmpDir('claude-sync-hook-end-timeout-uninit-');
  try {
    const result = runHook('hooks/session-end-check.js', homeDir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    rmDir(homeDir);
  }
});
