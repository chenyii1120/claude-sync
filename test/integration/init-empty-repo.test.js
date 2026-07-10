'use strict';

// F-01 integration scenario: init against a brand-new (empty) bare repo.
// init() should push the local ~/.claude state as the first commit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, git } = require('../helpers/git.js');
const { seedFullHome } = require('../helpers/claude-home.js');

test('init(): pushes local state as the initial commit when the remote repo is empty', () => {
  const root = mkTmpDir('claude-sync-init-empty-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const claudeHome = path.join(root, 'claude-home');
    seedFullHome(claudeHome, { settings: { theme: 'dark', model: 'sonnet' } });

    const engine = loadEngine(claudeHome);
    const result = engine.init(remoteDir);

    assert.equal(result.hasContent, false);
    assert.equal(result.repoUrl, remoteDir);
    assert.equal(engine.isInitialized(), true);

    const config = engine.loadConfig();
    // C-02: config now also carries the detected default branch.
    assert.deepEqual(config, { repo: remoteDir, branch: 'main', autoPull: false, autoPush: false });

    const lastSync = engine.loadLastSync();
    assert.equal(lastSync.action, 'init');
    assert.equal(lastSync.firstPullPending, false);
    assert.match(lastSync.commitHash, /^[0-9a-f]{40}$/);

    // Verify what actually landed in the bare "remote" by cloning it fresh.
    const checkClone = cloneWithIdentity(remoteDir, path.join(root, 'check-clone'));
    const pushedSettings = JSON.parse(
      fs.readFileSync(path.join(checkClone, 'global', 'settings.json'), 'utf8'),
    );
    assert.deepEqual(pushedSettings, { theme: 'dark', model: 'sonnet' });

    const pushedRule = fs.readFileSync(path.join(checkClone, 'user-config', 'rules', 'style.md'), 'utf8');
    assert.equal(pushedRule, '# style\n');

    const commitSubject = git(checkClone, ['log', '-1', '--format=%s']);
    assert.equal(commitSubject, 'Initial sync from first machine');
  } finally {
    rmDir(root);
  }
});
