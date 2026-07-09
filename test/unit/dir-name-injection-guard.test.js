'use strict';

// F#2 (Codex, RCE): commands/sync-pull.md's add/skip step used to interpolate
// an untrusted remote directory name straight into a `node -e` JS STRING
// LITERAL (`s.addAllowSyncDir('<dir>')`). A remote dir named e.g.
// `x');require('child_process').execFileSync('touch',['/tmp/pwned']);//`
// becomes executable JS the moment the agent substitutes it in — and it runs
// during `node -e` PARSING, before addAllowSyncDir() is ever called, so an
// engine-side charset check alone cannot stop it. The real fix is layered:
//
//   1. hasUnsafeDirNameChars(name) = anything outside [A-Za-z0-9._-].
//   2. isSuspiciousDirName() also flags unsafe-charset names, so
//      getUnknownRemoteDirs() never offers one for add/skip and
//      getSuspiciousRemoteDirs() surfaces it as a likely spoofing/injection
//      attempt instead.
//   3. addAllowSyncDir()/addSkipSyncDir() throw on unsafe-charset names as a
//      backstop, independent of where the name came from.
//   4. commands/sync-pull.md and sync-init.md pass the dir name via
//      process.argv[1] instead of a JS string literal (defense-in-depth,
//      covered by doc review, not exercised by this test file).
//
// This file pins layers 1-3 at the engine level.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

test('isSuspiciousDirName: flags classic node -e injection payloads and other unsafe-charset names', () => {
  const root = mkTmpDir('claude-sync-injection-guard-');
  try {
    const engine = loadEngine(path.join(root, 'claude-home'));

    assert.equal(engine.isSuspiciousDirName("x');evil//"), true);
    assert.equal(engine.isSuspiciousDirName('has space'), true);
    assert.equal(engine.isSuspiciousDirName('a/b'), true);
    assert.equal(engine.isSuspiciousDirName(''), true);
  } finally {
    rmDir(root);
  }
});

test('isSuspiciousDirName: a normal safe-charset name is NOT suspicious', () => {
  const root = mkTmpDir('claude-sync-injection-guard-');
  try {
    const engine = loadEngine(path.join(root, 'claude-home'));

    assert.equal(engine.isSuspiciousDirName('normal-dir'), false);
  } finally {
    rmDir(root);
  }
});

test('getUnknownRemoteDirs excludes an odd-charset repo dir; getSuspiciousRemoteDirs includes it', () => {
  const root = mkTmpDir('claude-sync-injection-guard-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const engine = loadEngine(claudeHome);

    // Seed the repo's user-config/ directly on disk -- getUnknownRemoteDirs()
    // and getSuspiciousRemoteDirs() only read the filesystem, no git needed.
    const repoUserConfig = path.join(engine.REPO_DIR, 'user-config');
    // A space is rejected by the [A-Za-z0-9._-] charset but accepted by every
    // major filesystem, so it's a safe stand-in for a shell-metacharacter
    // payload that some filesystems would refuse to create as a literal dir name.
    fs.mkdirSync(path.join(repoUserConfig, 'weird dir'), { recursive: true });
    fs.writeFileSync(path.join(repoUserConfig, 'weird dir', 'pwn.js'), 'x\n');
    // A normal dir should still flow through the unknown (opt-in) path.
    fs.mkdirSync(path.join(repoUserConfig, 'myteam-config'), { recursive: true });
    fs.writeFileSync(path.join(repoUserConfig, 'myteam-config', 'a.md'), '# a\n');

    const unknown = engine.getUnknownRemoteDirs();
    const suspicious = engine.getSuspiciousRemoteDirs();

    assert.equal(unknown.includes('weird dir'), false, 'odd-charset dir must NOT be offered for add/skip');
    assert.equal(suspicious.includes('weird dir'), true, 'odd-charset dir must be surfaced as suspicious');
    assert.equal(unknown.includes('myteam-config'), true, 'a normal dir is still a valid unknown/opt-in candidate');
    assert.equal(suspicious.includes('myteam-config'), false, 'a normal dir must not be flagged suspicious');
  } finally {
    rmDir(root);
  }
});

test('addAllowSyncDir / addSkipSyncDir throw on unsafe-charset names', () => {
  const root = mkTmpDir('claude-sync-injection-guard-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const engine = loadEngine(claudeHome);

    assert.throws(() => engine.addAllowSyncDir('weird dir'), /characters not allowed/);
    assert.throws(() => engine.addSkipSyncDir('a$b'), /characters not allowed/);

    // Neither rejected name should have been persisted.
    const config = engine.loadConfig() || {};
    assert.equal((config.allowSyncDirs || []).includes('weird dir'), false);
    assert.equal((config.skipSyncDirs || []).includes('a$b'), false);
  } finally {
    rmDir(root);
  }
});

test('addAllowSyncDir succeeds for a normal safe-charset name and lands in config', () => {
  const root = mkTmpDir('claude-sync-injection-guard-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const engine = loadEngine(claudeHome);

    engine.addAllowSyncDir('myteam-config');

    const config = engine.loadConfig();
    assert.equal(config.allowSyncDirs.includes('myteam-config'), true);
  } finally {
    rmDir(root);
  }
});

test('end to end: a normal safe name flows through getUnknownRemoteDirs -> addAllowSyncDir', () => {
  const root = mkTmpDir('claude-sync-injection-guard-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const engine = loadEngine(claudeHome);

    const repoUserConfig = path.join(engine.REPO_DIR, 'user-config');
    fs.mkdirSync(path.join(repoUserConfig, 'myteam-config'), { recursive: true });
    fs.writeFileSync(path.join(repoUserConfig, 'myteam-config', 'a.md'), '# a\n');

    const unknownBefore = engine.getUnknownRemoteDirs();
    assert.deepEqual(unknownBefore, ['myteam-config']);

    for (const dir of unknownBefore) engine.addAllowSyncDir(dir);

    const config = engine.loadConfig();
    assert.equal(config.allowSyncDirs.includes('myteam-config'), true);

    // Now that it's allow-listed, it's no longer "unknown".
    const unknownAfter = engine.getUnknownRemoteDirs();
    assert.deepEqual(unknownAfter, []);
  } finally {
    rmDir(root);
  }
});
