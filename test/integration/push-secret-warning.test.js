'use strict';

// B-04 integration scenario: push() attaches secretWarnings when local
// settings.json's env looks like it holds secrets, and reports an empty
// array when it doesn't. Mirrors push-pull-roundtrip.test.js's
// single-machine push setup.
//
// F#7: push() now GATES on a suspected secret unless the caller passes
// confirmSecrets:true (see test/integration/push-secret-gate.test.js for the
// full gate/block scenarios, including local-commit and remote-HEAD
// assertions). This file's "flagged" case now exercises both halves in one
// place: an unconfirmed push must be blocked (pushed:false), and only a
// confirmSecrets:true retry actually pushes, still carrying secretWarnings
// informationally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, git } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('push(): secretWarnings flags a likely-secret env entry -- blocked unconfirmed, pushed once confirmed', () => {
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

    const remoteHeadBefore = git(remoteDir, ['rev-parse', 'HEAD']);

    // Unconfirmed: gated, nothing pushed.
    const blocked = engine.push();
    assert.equal(blocked.pushed, false);
    assert.equal(blocked.reason, 'secrets-detected');
    assert.ok(Array.isArray(blocked.secretWarnings));
    assert.ok(blocked.secretWarnings.some((w) => w.path === 'env.ANTHROPIC_API_KEY'));
    assert.equal(git(remoteDir, ['rev-parse', 'HEAD']), remoteHeadBefore, 'nothing pushed while unconfirmed');

    // Confirmed: proceeds, still surfaces secretWarnings informationally.
    const result = engine.push({ confirmSecrets: true });
    assert.equal(result.pushed, true);
    assert.ok(Array.isArray(result.secretWarnings));
    assert.ok(result.secretWarnings.some((w) => w.path === 'env.ANTHROPIC_API_KEY'));
    assert.notEqual(git(remoteDir, ['rev-parse', 'HEAD']), remoteHeadBefore, 'confirmed push advances the remote');
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
