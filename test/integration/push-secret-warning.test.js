'use strict';

// B-04 integration scenario: push() attaches secretWarnings (non-blocking)
// on the pushed:true path when local settings.json's env looks like it
// holds secrets, and reports an empty array when it doesn't. Mirrors
// push-pull-roundtrip.test.js's single-machine push setup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('push(): secretWarnings flags a likely-secret env entry on a real push', () => {
  const root = mkTmpDir('claude-sync-secretwarn-flagged-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const claudeHome = path.join(root, 'home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    // Change settings.json to include an env var that looks like a secret.
    const settingsPath = path.join(claudeHome, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'dark', env: { ANTHROPIC_API_KEY: 'sk-xxxx' } }, null, 2),
    );

    const result = engine.push();
    assert.equal(result.pushed, true);
    assert.ok(Array.isArray(result.secretWarnings));
    assert.ok(result.secretWarnings.some((w) => w.path === 'env.ANTHROPIC_API_KEY'));
  } finally {
    rmDir(root);
  }
});

test('push(): secretWarnings is empty when no env entry looks like a secret', () => {
  const root = mkTmpDir('claude-sync-secretwarn-clean-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const claudeHome = path.join(root, 'home');
    seedMinimalHome(claudeHome, { theme: 'dark' });
    const engine = loadEngine(claudeHome);
    engine.init(remoteDir);

    const settingsPath = path.join(claudeHome, 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'light', env: { EDITOR: 'vim' } }, null, 2),
    );

    const result = engine.push();
    assert.equal(result.pushed, true);
    assert.deepEqual(result.secretWarnings, []);
  } finally {
    rmDir(root);
  }
});
