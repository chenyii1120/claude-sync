'use strict';

// B-02 + B-03 scenarios: pull() no longer auto-applies executable user-config
// dirs (hooks/skills/rules), and never imports a remote dir the local machine
// hasn't opted into.
//
// B-02 (two-stage confirm): a remote change under hooks/, skills/, or rules/
// is NOT written to ~/.claude on pull(). Instead pull() returns it under
// `pendingConfirmation` and defers advancing last-sync. A separate
// applyPendingDirs() writes the confirmed dirs and finalizes last-sync;
// discardPendingDirs() drops the pending state without applying and without
// advancing last-sync (so the next pull re-offers it).
//
// B-03 (opt-in for unknown remote dirs): a repo dir that is not in the local
// allow set is never imported; pull() surfaces it under `unknownRemoteDirs`.
// After addAllowSyncDir(), a second pull imports it.
//
// Each test builds two converged machines (A/B) sharing one bare remote, then
// has A push a change and B pull it. engineB stays a live module instance
// bound to homeB even after engineA calls (each loadEngine() returns its own
// instance), so it is reused directly for B's later operations.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedFullHome } = require('../helpers/claude-home.js');

function twoConvergedHomes(root) {
  const remoteDir = initBareRepo(path.join(root, 'remote.git'));

  const homeA = path.join(root, 'home-a');
  seedFullHome(homeA, { settings: { theme: 'dark' }, ruleContent: '# style\n' });
  const engineA = loadEngine(homeA);
  engineA.init(remoteDir);

  const homeB = path.join(root, 'home-b');
  seedFullHome(homeB, { settings: { theme: 'dark' }, ruleContent: '# style\n' });
  const engineB = loadEngine(homeB);
  engineB.init(remoteDir);
  engineB.pull(); // first-pull: converge

  return { remoteDir, homeA, engineA, homeB, engineB };
}

test('B-02: a remote hooks/ addition is deferred, not applied, and does not advance last-sync', () => {
  const root = mkTmpDir('claude-sync-defer-hooks-');
  try {
    const { homeA, engineA, homeB, engineB } = twoConvergedHomes(root);

    // Capture B's converged base commit — the deferred pull must NOT advance it.
    const baseBefore = engineB.loadLastSync().commitHash;

    // A adds a brand-new hook file and pushes it.
    fs.mkdirSync(path.join(homeA, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'hooks', 'evil.js'), 'console.log("pwned")\n');
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    // B pulls: the hook must be DEFERRED, not written to ~/.claude/hooks.
    const pullB = engineB.pull();

    assert.equal(
      fs.existsSync(path.join(homeB, 'hooks', 'evil.js')),
      false,
      'a malicious remote hook must NOT land in ~/.claude on pull',
    );
    const pend = pullB.pendingConfirmation.find(p => p.dir === 'hooks');
    assert.ok(pend, 'hooks change must be listed in pendingConfirmation');
    assert.deepEqual(pend.changes, ['evil.js']);

    // last-sync must NOT have advanced, and the recovery state file exists.
    assert.equal(engineB.loadLastSync().commitHash, baseBefore, 'last-sync must not advance while confirmation pending');
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), true, 'pending-apply state file must exist');

    // Confirm + apply: now the file lands and last-sync advances.
    const remoteHead = engineB.gitExecFile(['rev-parse', 'origin/main']);
    const applyRes = engineB.applyPendingDirs(['hooks']);
    assert.equal(applyRes.applied, true);
    assert.deepEqual(applyRes.configChanges, ['hooks/evil.js']);
    assert.equal(
      fs.readFileSync(path.join(homeB, 'hooks', 'evil.js'), 'utf8'),
      'console.log("pwned")\n',
    );
    assert.equal(engineB.loadLastSync().commitHash, remoteHead, 'last-sync advances after apply');
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), false, 'pending-apply state file cleared after apply');
  } finally {
    rmDir(root);
  }
});

test('B-02: discardPendingDirs() drops a deferred hooks/ change without applying or advancing last-sync', () => {
  const root = mkTmpDir('claude-sync-discard-hooks-');
  try {
    const { homeA, engineA, homeB, engineB } = twoConvergedHomes(root);

    const baseBefore = engineB.loadLastSync().commitHash;

    fs.mkdirSync(path.join(homeA, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'hooks', 'evil.js'), 'console.log("pwned")\n');
    engineA.push();

    const pullB = engineB.pull();
    assert.ok(pullB.pendingConfirmation.some(p => p.dir === 'hooks'));
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), true);

    const discardRes = engineB.discardPendingDirs();
    assert.equal(discardRes.discarded, true);
    assert.deepEqual(discardRes.dirs, ['hooks']);

    // File never applied, last-sync unchanged, state file gone.
    assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'evil.js')), false);
    assert.equal(engineB.loadLastSync().commitHash, baseBefore, 'discard must not advance last-sync');
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), false, 'state file removed on discard');
  } finally {
    rmDir(root);
  }
});

test('B-03: an unknown remote dir is not imported; after addAllowSyncDir() a second pull imports it', () => {
  const root = mkTmpDir('claude-sync-unknown-dir-');
  try {
    const { homeA, engineA, homeB, engineB } = twoConvergedHomes(root);

    // A introduces a brand-new, non-default dir and allow-lists it locally so
    // it gets pushed. B has NOT opted into it.
    fs.mkdirSync(path.join(homeA, 'evil'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'evil', 'x.sh'), 'rm -rf /\n');
    engineA.addAllowSyncDir('evil');
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    const pullB = engineB.pull();

    assert.equal(
      fs.existsSync(path.join(homeB, 'evil')),
      false,
      'a remote dir the local machine has not opted into must NOT be imported',
    );
    assert.ok(pullB.unknownRemoteDirs.includes('evil'), 'unknown remote dir must be surfaced');

    // Local opt-in, then a second pull imports it.
    engineB.addAllowSyncDir('evil');
    const pullB2 = engineB.pull();
    assert.equal(fs.existsSync(path.join(homeB, 'evil', 'x.sh')), true);
    assert.equal(fs.readFileSync(path.join(homeB, 'evil', 'x.sh'), 'utf8'), 'rm -rf /\n');
    assert.ok(!(pullB2.unknownRemoteDirs || []).includes('evil'), 'evil no longer unknown after opt-in');
  } finally {
    rmDir(root);
  }
});

test('B-02 guard: a pull with no executable-dir changes keeps the normal path (no pending, last-sync saved)', () => {
  const root = mkTmpDir('claude-sync-normal-path-');
  try {
    const { homeA, engineA, homeB, engineB } = twoConvergedHomes(root);

    // A changes a NON-executable user-config dir (commands/) and pushes.
    fs.mkdirSync(path.join(homeA, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'commands', 'foo.md'), '# foo\n');
    engineA.push();

    const pullB = engineB.pull();

    assert.equal(pullB.pulled, true);
    assert.deepEqual(pullB.pendingConfirmation, [], 'no executable-dir changes => no pending confirmation');
    assert.deepEqual(pullB.unknownRemoteDirs, []);
    assert.ok(pullB.configChanges.includes('commands/foo.md'));
    assert.equal(fs.existsSync(path.join(homeB, 'commands', 'foo.md')), true);

    // last-sync advanced immediately; no state file left behind.
    const remoteHead = engineB.gitExecFile(['rev-parse', 'origin/main']);
    assert.equal(engineB.loadLastSync().commitHash, remoteHead);
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), false);
  } finally {
    rmDir(root);
  }
});
