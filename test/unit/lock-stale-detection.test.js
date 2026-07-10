'use strict';

// C-03: acquireLock() used a bare mkdir with no way to tell a crashed
// holder's leftover lock dir apart from a genuinely concurrent sync, so a
// killed process wedged every future push/pull until someone deleted
// .sync.lock by hand. The lock dir now also holds meta.json ({ pid,
// startedAt }), and acquireLock() reclaims it exactly when it can prove the
// holder is dead (ESRCH on process.kill(pid, 0)) or has held it past
// STALE_MS -- otherwise it fails safe and reports busy, same as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

// Guaranteed-dead: above the max PID on every platform this runs on, so
// process.kill(DEAD_PID, 0) reliably throws ESRCH rather than EPERM.
const DEAD_PID = 2147483647;
const STALE_MS = 10 * 60 * 1000;

function writeLockMeta(engine, meta) {
  fs.mkdirSync(engine.SYNC_DIR, { recursive: true });
  fs.mkdirSync(path.join(engine.SYNC_DIR, '.sync.lock'));
  fs.writeFileSync(
    path.join(engine.SYNC_DIR, '.sync.lock', 'meta.json'),
    typeof meta === 'string' ? meta : JSON.stringify(meta)
  );
}

test('acquireLock(): reclaims a lock held by a dead pid', () => {
  const root = mkTmpDir('claude-sync-lock-');
  const claudeHome = path.join(root, 'claude-home');
  const engine = loadEngine(claudeHome);
  try {
    writeLockMeta(engine, { pid: DEAD_PID, startedAt: Date.now() });

    assert.equal(engine.acquireLock(), true);

    const meta = JSON.parse(
      fs.readFileSync(path.join(engine.SYNC_DIR, '.sync.lock', 'meta.json'), 'utf8')
    );
    assert.equal(meta.pid, process.pid);
    assert.equal(typeof meta.startedAt, 'number');

    // The atomic-rename reclaim path renames the stale lock to a
    // `.sync.lock.stale-<pid>` sidecar before rmSync'ing it; prove that
    // temporary dir was cleaned up and left no residue in SYNC_DIR.
    const staleResidue = fs.readdirSync(engine.SYNC_DIR)
      .filter(name => name.startsWith('.sync.lock.stale-'));
    assert.deepEqual(staleResidue, []);
  } finally {
    engine.releaseLock();
    rmDir(root);
  }
});

test('acquireLock(): a live, fresh holder is busy for a second caller', () => {
  const root = mkTmpDir('claude-sync-lock-');
  const claudeHome = path.join(root, 'claude-home');
  const engine = loadEngine(claudeHome);
  try {
    fs.mkdirSync(engine.SYNC_DIR, { recursive: true });
    assert.equal(engine.acquireLock(), true);
    assert.equal(engine.acquireLock(), false);
  } finally {
    engine.releaseLock();
    rmDir(root);
  }
});

test('acquireLock(): reclaims a lock held by a live pid that has aged past STALE_MS', () => {
  const root = mkTmpDir('claude-sync-lock-');
  const claudeHome = path.join(root, 'claude-home');
  const engine = loadEngine(claudeHome);
  try {
    writeLockMeta(engine, { pid: process.pid, startedAt: Date.now() - (STALE_MS + 60 * 1000) });

    assert.equal(engine.acquireLock(), true);
  } finally {
    engine.releaseLock();
    rmDir(root);
  }
});

test('acquireLock(): malformed meta.json fails safe as busy, not reclaimed', () => {
  const root = mkTmpDir('claude-sync-lock-');
  const claudeHome = path.join(root, 'claude-home');
  const engine = loadEngine(claudeHome);
  try {
    writeLockMeta(engine, '{ not json');

    assert.equal(engine.acquireLock(), false);
  } finally {
    engine.releaseLock();
    rmDir(root);
  }
});

test('releaseLock(): removes the lock dir even though it is non-empty (holds meta.json)', () => {
  const root = mkTmpDir('claude-sync-lock-');
  const claudeHome = path.join(root, 'claude-home');
  const engine = loadEngine(claudeHome);
  try {
    fs.mkdirSync(engine.SYNC_DIR, { recursive: true });
    assert.equal(engine.acquireLock(), true);
    const lockPath = path.join(engine.SYNC_DIR, '.sync.lock');
    assert.equal(fs.existsSync(path.join(lockPath, 'meta.json')), true);

    engine.releaseLock();

    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    engine.releaseLock();
    rmDir(root);
  }
});
