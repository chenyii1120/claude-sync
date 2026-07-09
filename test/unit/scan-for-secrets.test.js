'use strict';

// B-04: unit tests for the scanForSecrets() heuristic helper. It scans only
// settingsObj.env -- key NAMES against SECRET_KEY_PATTERN and string VALUES
// against SECRET_VALUE_PATTERNS -- and is used by push() to WARN (never
// block) before settings.json is sent to a git remote.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

test('scanForSecrets: env key name matching the secret keyword pattern is flagged', () => {
  const claudeHome = mkTmpDir('claude-sync-scansecrets-name-');
  try {
    const engine = loadEngine(claudeHome);
    const result = engine.scanForSecrets({ env: { OPENAI_API_KEY: 'anything' } });
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'env.OPENAI_API_KEY');
    assert.match(result[0].reason, /name/i);
  } finally {
    rmDir(claudeHome);
  }
});

test('scanForSecrets: benign name with a value matching a secret-token prefix is flagged', () => {
  const claudeHome = mkTmpDir('claude-sync-scansecrets-value-');
  try {
    const engine = loadEngine(claudeHome);
    const result = engine.scanForSecrets({ env: { SOME_VAR: 'sk-abc123def456' } });
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'env.SOME_VAR');
    assert.match(result[0].reason, /value/i);
  } finally {
    rmDir(claudeHome);
  }
});

test('scanForSecrets: a truly benign env entry is not flagged', () => {
  const claudeHome = mkTmpDir('claude-sync-scansecrets-benign-');
  try {
    const engine = loadEngine(claudeHome);
    const result = engine.scanForSecrets({ env: { EDITOR: 'vim' } });
    assert.deepEqual(result, []);
  } finally {
    rmDir(claudeHome);
  }
});

test('scanForSecrets: missing env, or env not an object, returns [] without throwing', () => {
  const claudeHome = mkTmpDir('claude-sync-scansecrets-missing-');
  try {
    const engine = loadEngine(claudeHome);
    assert.deepEqual(engine.scanForSecrets({}), []);
    assert.deepEqual(engine.scanForSecrets({ env: null }), []);
    assert.deepEqual(engine.scanForSecrets({ env: 'not-an-object' }), []);
    assert.deepEqual(engine.scanForSecrets({ env: ['array', 'not', 'object'] }), []);
    assert.deepEqual(engine.scanForSecrets(null), []);
    assert.deepEqual(engine.scanForSecrets(undefined), []);
  } finally {
    rmDir(claudeHome);
  }
});
