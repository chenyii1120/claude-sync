'use strict';

// F-01 integration scenario: createBackup()/restoreBackup() round trip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { seedFullHome } = require('../helpers/claude-home.js');

test('createBackup()/restoreBackup(): restores settings.json and user-config dirs to the backed-up state', () => {
  const root = mkTmpDir('claude-sync-backup-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedFullHome(claudeHome, { settings: { theme: 'dark' }, ruleContent: '# original style\n' });

    const engine = loadEngine(claudeHome);
    const backupPath = engine.createBackup();
    assert.ok(fs.existsSync(backupPath));
    assert.equal(path.dirname(backupPath), engine.BACKUP_DIR);

    const backedUpSettings = JSON.parse(fs.readFileSync(path.join(backupPath, 'settings.json'), 'utf8'));
    assert.deepEqual(backedUpSettings, { theme: 'dark' });
    const backedUpRule = fs.readFileSync(path.join(backupPath, 'rules', 'style.md'), 'utf8');
    assert.equal(backedUpRule, '# original style\n');

    // Mutate local state after the backup: change settings, delete the rule
    // file, and add an unrelated new file.
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ theme: 'light' }, null, 2));
    fs.writeFileSync(path.join(claudeHome, 'rules', 'style.md'), '# mutated\n');
    fs.writeFileSync(path.join(claudeHome, 'rules', 'extra.md'), 'should be removed by restore\n');

    const backupName = path.basename(backupPath);
    engine.restoreBackup(backupName);

    const restoredSettings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    assert.deepEqual(restoredSettings, { theme: 'dark' });
    const restoredRule = fs.readFileSync(path.join(claudeHome, 'rules', 'style.md'), 'utf8');
    assert.equal(restoredRule, '# original style\n');
    // restoreBackup() replaces the whole dir (rmSync then copyDirSync), so
    // the extra file added after the backup must be gone.
    assert.equal(fs.existsSync(path.join(claudeHome, 'rules', 'extra.md')), false);
  } finally {
    rmDir(root);
  }
});

test('listBackups(): returns backups newest-first and restoreBackup() throws for an unknown name', () => {
  const root = mkTmpDir('claude-sync-backup-list-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedFullHome(claudeHome);
    const engine = loadEngine(claudeHome);

    assert.deepEqual(engine.listBackups(), []);
    const first = engine.createBackup();
    // createBackup() names backups by millisecond ISO timestamp; force a
    // gap so two backups in quick succession don't collide on the same dir.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const second = engine.createBackup();

    const backups = engine.listBackups();
    assert.equal(backups.length, 2);
    assert.equal(backups[0], path.basename(second));
    assert.equal(backups[1], path.basename(first));

    assert.throws(() => engine.restoreBackup('backup-does-not-exist'), /Backup not found/);
  } finally {
    rmDir(root);
  }
});
