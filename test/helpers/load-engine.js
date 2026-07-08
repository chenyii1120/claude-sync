'use strict';

// sync-engine.js computes CLAUDE_HOME (and every constant derived from it)
// once, at module load time, from process.env.CLAUDE_SYNC_HOME. To run the
// engine against a fresh tmpdir per test, we set that env var and force a
// fresh `require` by evicting the module from Node's require cache. Tests
// in this repo run sequentially within a file (node:test's default), so
// there is no race on the shared process.env write between loadEngine()
// calls.

const ENGINE_PATH = require.resolve('../../lib/sync-engine.js');

function loadEngine(claudeHome) {
  process.env.CLAUDE_SYNC_HOME = claudeHome;
  delete require.cache[ENGINE_PATH];
  return require(ENGINE_PATH);
}

module.exports = { loadEngine, ENGINE_PATH };
