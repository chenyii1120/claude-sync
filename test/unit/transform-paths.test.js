'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

test('transformPathsForExport/Import: round-trips absolute CLAUDE_HOME paths', () => {
  const claudeHome = mkTmpDir('claude-sync-transform-');
  try {
    const engine = loadEngine(claudeHome);
    const original = {
      hooks: {
        start: `node "${path.join(claudeHome, 'hooks', 'foo.js')}"`,
      },
      list: [path.join(claudeHome, 'a'), path.join(claudeHome, 'b'), 'unrelated'],
      untouched: 'no-path-here',
    };

    const exported = engine.transformPathsForExport(original);
    assert.equal(JSON.stringify(exported).includes(claudeHome), false, 'exported form must not contain the raw home path');
    assert.equal(exported.hooks.start, 'node "${CLAUDE_HOME}/hooks/foo.js"');
    assert.deepEqual(exported.list, ['${CLAUDE_HOME}/a', '${CLAUDE_HOME}/b', 'unrelated']);
    assert.equal(exported.untouched, 'no-path-here');

    const reimported = engine.transformPathsForImport(exported);
    assert.deepEqual(reimported, original);
  } finally {
    rmDir(claudeHome);
  }
});

test('transformPathsForExport: escapes regex-special characters in CLAUDE_HOME', () => {
  const base = mkTmpDir('claude-sync-transform-special-');
  const claudeHome = path.join(base, 'home (a).with+chars');
  try {
    const engine = loadEngine(claudeHome);
    const original = { path: path.join(claudeHome, 'settings.json') };
    const exported = engine.transformPathsForExport(original);
    assert.equal(exported.path, '${CLAUDE_HOME}/settings.json');
    const reimported = engine.transformPathsForImport(exported);
    assert.deepEqual(reimported, original);
  } finally {
    rmDir(base);
  }
});

test('transformPathsForImport: leaves input untouched when no placeholder is present', () => {
  const claudeHome = mkTmpDir('claude-sync-transform-noop-');
  try {
    const engine = loadEngine(claudeHome);
    const original = { a: 1, b: 'plain string', c: [1, 2, 3] };
    assert.deepEqual(engine.transformPathsForImport(original), original);
  } finally {
    rmDir(claudeHome);
  }
});
