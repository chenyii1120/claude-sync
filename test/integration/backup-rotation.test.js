'use strict';

// D-02 integration scenarios for the pull()/createBackup() interaction:
//   1. A refused safe-mode pull imports nothing, so it must NOT take a backup
//      (backupPath === null) and must NOT rotate existing backups out of the
//      window — otherwise a run of no-op/refused pulls would push a useful
//      pre-disaster backup out of the retained set.
//   2. A pull that actually imports DOES take exactly one backup.
//   3. Retention is capped at BACKUP_RETENTION (10) backups.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('pull(): repeated refused safe pulls take no backup and do not rotate existing backups', () => {
  const root = mkTmpDir('claude-sync-backup-refuse-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A creates the repo.
    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark', model: 'sonnet' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    // Machine B joins, changes a DIFFERENT key, and pushes so remote is ahead.
    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark', model: 'sonnet' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();
    fs.writeFileSync(path.join(homeB, 'settings.json'), JSON.stringify({ theme: 'dark', model: 'opus' }, null, 2));
    assert.equal(engineB.push().pushed, true);

    // Back on A: make an unpushed local edit so every safe pull refuses.
    const engineAReload = loadEngine(homeA);
    fs.writeFileSync(path.join(homeA, 'settings.json'), JSON.stringify({ theme: 'light', model: 'sonnet' }, null, 2));

    // Seed a baseline backup that must survive the refused pulls, so this
    // directly exercises the "refused pulls rotate useful backups out" bug.
    engineAReload.createBackup();
    const before = engineAReload.listBackups().length;
    assert.equal(before, 1);

    for (let i = 0; i < 3; i++) {
      const r = engineAReload.pull({ mode: 'safe' });
      assert.equal(r.pulled, false, `pull #${i + 1} should refuse`);
      assert.equal(r.reason, 'local-changes-pending');
      assert.equal(r.backupPath, null, `refused pull #${i + 1} must not take a backup`);
    }

    // No backup was taken and none was rotated out: count is unchanged.
    assert.equal(engineAReload.listBackups().length, before);
  } finally {
    rmDir(root);
  }
});

test('pull(): a pull that actually imports takes exactly one backup', () => {
  const root = mkTmpDir('claude-sync-backup-import-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A seeds richer settings and creates the repo.
    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark', model: 'opus' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    // Machine B joins with different settings; its first pull imports remote.
    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    assert.deepEqual(engineB.listBackups(), []);

    const pullB = engineB.pull();
    assert.equal(pullB.pulled, true);
    assert.equal(pullB.mode, 'first-pull');
    assert.ok(pullB.backupPath && fs.existsSync(pullB.backupPath), 'an importing pull must take a backup');
    assert.equal(engineB.listBackups().length, 1);
  } finally {
    rmDir(root);
  }
});

test('createBackup(): retains at most BACKUP_RETENTION (10) backups', () => {
  const root = mkTmpDir('claude-sync-backup-retention-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);

    // Pre-seed 12 timestamp-shaped backups directly (zero-padded so their
    // lexical order is stable), then let createBackup() add one more and prune.
    fs.mkdirSync(engine.BACKUP_DIR, { recursive: true });
    for (let i = 1; i <= 12; i++) {
      fs.mkdirSync(path.join(engine.BACKUP_DIR, `backup-${String(i).padStart(4, '0')}`));
    }
    assert.equal(engine.listBackups().length, 12);

    engine.createBackup();

    // 12 + 1 = 13 created, capped back down to exactly 10.
    assert.equal(engine.listBackups().length, 10);
  } finally {
    rmDir(root);
  }
});
