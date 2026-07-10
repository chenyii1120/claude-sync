'use strict';

// B-01: validateRemoteUrl() is the allow-list gate that init() runs before
// handing a remote to `git clone`. Even though every git call now goes through
// execFileSync (no shell), a hostile remote string can still be treated as a
// git option ('-'-prefixed, e.g. --upload-pack=<cmd>) or select a transport
// helper (ext::sh -c '<cmd>') that makes git run arbitrary commands. These
// tests pin down exactly which forms are accepted and which are rejected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

test('validateRemoteUrl: rejects a shell-injection-style https URL', () => {
  const home = mkTmpDir('claude-sync-vru-');
  try {
    const engine = loadEngine(home);
    assert.throws(() => engine.validateRemoteUrl('https://x/y"; touch /tmp/pwned; "'), /remote url/i);
  } finally {
    rmDir(home);
  }
});

test('validateRemoteUrl: rejects an option-injection remote (--upload-pack=...)', () => {
  const home = mkTmpDir('claude-sync-vru-');
  try {
    const engine = loadEngine(home);
    assert.throws(() => engine.validateRemoteUrl('--upload-pack=touch /tmp/pwned'), /remote url/i);
  } finally {
    rmDir(home);
  }
});

test('validateRemoteUrl: rejects the ext:: transport helper', () => {
  const home = mkTmpDir('claude-sync-vru-');
  try {
    const engine = loadEngine(home);
    assert.throws(() => engine.validateRemoteUrl("ext::sh -c 'touch /tmp/pwned'"), /remote url/i);
  } finally {
    rmDir(home);
  }
});

test('validateRemoteUrl: rejects other protocols (file://, git://)', () => {
  const home = mkTmpDir('claude-sync-vru-');
  try {
    const engine = loadEngine(home);
    assert.throws(() => engine.validateRemoteUrl('file:///etc/passwd'), /remote url/i);
    assert.throws(() => engine.validateRemoteUrl('git://evil.example/repo.git'), /remote url/i);
  } finally {
    rmDir(home);
  }
});

test('validateRemoteUrl: rejects empty / non-string input', () => {
  const home = mkTmpDir('claude-sync-vru-');
  try {
    const engine = loadEngine(home);
    assert.throws(() => engine.validateRemoteUrl(''), /required/i);
    assert.throws(() => engine.validateRemoteUrl(null), /required/i);
    assert.throws(() => engine.validateRemoteUrl(undefined), /required/i);
  } finally {
    rmDir(home);
  }
});

test('validateRemoteUrl: rejects a non-existent bare local path', () => {
  const home = mkTmpDir('claude-sync-vru-');
  try {
    const engine = loadEngine(home);
    assert.throws(() => engine.validateRemoteUrl('/no/such/path/repo.git'), /remote url/i);
  } finally {
    rmDir(home);
  }
});

test('validateRemoteUrl: accepts https / ssh / scp-like git@ URLs', () => {
  const home = mkTmpDir('claude-sync-vru-');
  try {
    const engine = loadEngine(home);
    assert.equal(engine.validateRemoteUrl('https://github.com/user/repo.git'), 'https://github.com/user/repo.git');
    assert.equal(engine.validateRemoteUrl('ssh://git@github.com/user/repo.git'), 'ssh://git@github.com/user/repo.git');
    assert.equal(engine.validateRemoteUrl('git@github.com:user/repo.git'), 'git@github.com:user/repo.git');
  } finally {
    rmDir(home);
  }
});

test('validateRemoteUrl: accepts an existing local directory (real local remote)', () => {
  const home = mkTmpDir('claude-sync-vru-');
  try {
    const engine = loadEngine(home);
    const localRepo = path.join(home, 'remote.git');
    fs.mkdirSync(localRepo, { recursive: true });
    assert.equal(engine.validateRemoteUrl(localRepo), localRepo);
  } finally {
    rmDir(home);
  }
});
