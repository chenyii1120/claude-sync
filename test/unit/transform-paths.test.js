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

// A-04 review: PINS a documented, intentional trade-off -- do not "fix" this
// without deliberately revisiting the placeholder convention. A user-typed
// settings value containing the literal text `${CLAUDE_HOME}` collides with
// claude-sync's path placeholder and IS rewritten to the machine's absolute
// path on import (and the repo/base-side transforms in diffSettings /
// getLocalDelta see the same rewrite). The controller judged the collision
// too theoretical to warrant an escaping mechanism; it is documented as a
// known limitation in README.md / README.zh-TW.md ("Path Transformation"
// section: the literal text ${CLAUDE_HOME} is reserved). If this test starts
// failing, the convention changed -- update the READMEs in the same commit.
test('transformPathsForImport: rewrites a user-typed literal ${CLAUDE_HOME} string (documented reserved-text trade-off)', () => {
  const claudeHome = mkTmpDir('claude-sync-transform-literal-');
  try {
    const engine = loadEngine(claudeHome);
    const input = {
      note: 'my docs live in ${CLAUDE_HOME}/docs',   // user-typed literal, NOT written by export
      command: 'echo "${CLAUDE_HOME}"',
    };
    const imported = engine.transformPathsForImport(input);
    assert.equal(imported.note, `my docs live in ${claudeHome}/docs`);
    assert.equal(imported.command, `echo "${claudeHome}"`);
    // And the collision is symmetric: export turns the now-absolute path back
    // into the placeholder, so the literal text can never round-trip as-is.
    assert.deepEqual(engine.transformPathsForExport(imported), input);
  } finally {
    rmDir(claudeHome);
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
