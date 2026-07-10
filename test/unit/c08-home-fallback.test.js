'use strict';

// C-08: process.env.HOME is undefined on Windows, so path.join(undefined,
// '.claude') used to throw at require time. sync-engine.js now falls back to
// os.homedir(). This is verified in a child process because deleting HOME in
// the current process could affect other tools running in this test run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const { ENGINE_PATH } = require('../helpers/load-engine.js');

test('C-08: requiring sync-engine.js does not throw when HOME and CLAUDE_SYNC_HOME are both unset', () => {
  const env = { ...process.env };
  delete env.HOME;
  delete env.CLAUDE_SYNC_HOME;

  const result = spawnSync(
    process.execPath,
    ['-e', `const e = require(${JSON.stringify(ENGINE_PATH)}); process.stdout.write('CLAUDE_HOME=' + e.CLAUDE_HOME);`],
    { env, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stdout, /CLAUDE_HOME=.+\.claude$/);
});

test('C-08: CLAUDE_SYNC_HOME takes precedence over os.homedir() fallback', () => {
  const env = { ...process.env, CLAUDE_SYNC_HOME: '/tmp/some-fake-claude-home' };
  delete env.HOME;

  const result = spawnSync(
    process.execPath,
    ['-e', `const e = require(${JSON.stringify(ENGINE_PATH)}); process.stdout.write(e.CLAUDE_HOME);`],
    { env, encoding: 'utf8' },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '/tmp/some-fake-claude-home');
});

test('C-08: lib/sync-engine.js no longer references process.env.HOME directly', () => {
  const source = fs.readFileSync(ENGINE_PATH, 'utf8');
  assert.equal(source.includes('process.env.HOME'), false);
});
