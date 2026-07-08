'use strict';

// B-02/B-03 security-review fixes:
//
// Fix 1 (case-fold bypass): on case-insensitive filesystems (macOS/Windows) a
// repo dir named 'Hooks' aliases ~/.claude/hooks but compares unequal to the
// reserved name 'hooks', so before the fix it could be allow-listed and
// imported through the normal (unconfirmed) path. Now every reserved-name
// comparison is case-folded: such dirs are never importable, are surfaced as
// `suspiciousRemoteDirs` (spoofing warning), and addAllowSyncDir() rejects
// any name that case-fold-collides with a reserved dir. The logic is purely
// name-based, so these tests are deterministic on case-SENSITIVE filesystems
// too.
//
// Fix 2 (pending-aware local delta): while pending-apply.json exists,
// getLocalDelta() compares against the stashed commit (whose non-exec content
// was already applied) and skips CONFIRM_REQUIRED_DIRS, so a re-pull after a
// deferred confirmation is not misread as local divergence.
//
// Fix 3 (partial apply): applyPendingDirs(subset) keeps the remaining dirs
// pending (state file rewritten, not deleted) so they are re-offered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, writeAndCommit, git } = require('../helpers/git.js');
const { seedMinimalHome, seedFullHome, writeJson } = require('../helpers/claude-home.js');

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

test('Fix 1: a case-fold-spoofed remote dir (Hooks/) is never imported, is surfaced as suspicious, and cannot be allow-listed', () => {
  const root = mkTmpDir('claude-sync-casefold-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Seed the repo with plain git (the engine itself now refuses to create
    // such a dir): a spoofed 'Hooks' dir carrying an executable payload.
    const seedClone = cloneWithIdentity(remoteDir, path.join(root, 'seed-clone'));
    writeAndCommit(seedClone, 'global/settings.json', JSON.stringify({ theme: 'dark' }, null, 2), 'seed settings');
    writeAndCommit(seedClone, 'user-config/Hooks/pwn.js', 'console.log("pwned")\n', 'spoofed dir');
    git(seedClone, ['push', 'origin', 'main']);

    const home = path.join(root, 'claude-home');
    seedMinimalHome(home, { theme: 'dark' });
    const engine = loadEngine(home);
    engine.init(remoteDir);
    const res = engine.pull();

    // Never lands locally under ANY casing (covers case-sensitive FS too).
    const hooksAliases = fs.readdirSync(home).filter(n => n.toLowerCase() === 'hooks');
    assert.deepEqual(hooksAliases, [], 'no hooks-aliasing dir may be created in ~/.claude');

    // Surfaced as suspicious, NOT offered as an opt-in candidate.
    assert.deepEqual(res.suspiciousRemoteDirs, ['Hooks']);
    assert.deepEqual(res.unknownRemoteDirs, []);

    // The opt-in door is closed too.
    assert.throws(() => engine.addAllowSyncDir('Hooks'), /reserved/i);
    assert.throws(() => engine.addAllowSyncDir('plugins'), /reserved/i);
    // Exact default dir names are still fine to allow-list.
    engine.addAllowSyncDir('hooks');
  } finally {
    rmDir(root);
  }
});

test('Fix 2(i): a re-pull with an unresolved pending confirmation is not misread as local divergence', () => {
  const root = mkTmpDir('claude-sync-pending-delta-');
  try {
    const { homeA, engineA, engineB, homeB } = twoConvergedHomes(root);

    // A pushes a MIXED change: settings (applied immediately by B's pull)
    // plus a hook (deferred).
    writeJson(path.join(homeA, 'settings.json'), { theme: 'light' });
    fs.mkdirSync(path.join(homeA, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'hooks', 'h.js'), 'x\n');
    assert.equal(engineA.push().pushed, true);

    const pull1 = engineB.pull();
    assert.equal(pull1.pulled, true);
    assert.ok(pull1.pendingConfirmation.some(p => p.dir === 'hooks'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(homeB, 'settings.json'), 'utf8')).theme, 'light');

    // Immediate second pull, no user edits: the applied settings change must
    // NOT read as unpushed local work (base = stashed commit), and the same
    // hooks confirmation must be re-offered.
    const pull2 = engineB.pull();
    assert.notEqual(pull2.reason, 'local-changes-pending', 'applied-from-pending content must not count as local divergence');
    assert.ok(pull2.pendingConfirmation.some(p => p.dir === 'hooks'), 'unresolved confirmation must be re-offered');
    assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'h.js')), false, 'hook must still be deferred');
  } finally {
    rmDir(root);
  }
});

test('Fix 2(ii): the opt-in re-pull (addAllowSyncDir after a mixed pull) imports the newly allowed dir', () => {
  const root = mkTmpDir('claude-sync-optin-repull-');
  try {
    const { homeA, engineA, engineB, homeB } = twoConvergedHomes(root);

    // A pushes settings + a hook + a brand-new dir in one commit.
    writeJson(path.join(homeA, 'settings.json'), { theme: 'light' });
    fs.mkdirSync(path.join(homeA, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'hooks', 'h.js'), 'x\n');
    fs.mkdirSync(path.join(homeA, 'mytools'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'mytools', 'a.md'), '# a\n');
    engineA.addAllowSyncDir('mytools');
    assert.equal(engineA.push().pushed, true);

    const pull1 = engineB.pull();
    assert.deepEqual(pull1.unknownRemoteDirs, ['mytools']);
    assert.equal(fs.existsSync(path.join(homeB, 'mytools')), false);

    // The sync-pull.md step-5 flow: opt in, then re-pull.
    engineB.addAllowSyncDir('mytools');
    const pull2 = engineB.pull();
    assert.notEqual(pull2.reason, 'local-changes-pending');
    assert.equal(fs.readFileSync(path.join(homeB, 'mytools', 'a.md'), 'utf8'), '# a\n');
    assert.deepEqual(pull2.unknownRemoteDirs, []);
  } finally {
    rmDir(root);
  }
});

test('Fix 3: applyPendingDirs(subset) keeps the remaining dirs pending and they are re-offered on the next pull', () => {
  const root = mkTmpDir('claude-sync-partial-apply-');
  try {
    const { homeA, engineA, engineB, homeB } = twoConvergedHomes(root);

    // A pushes changes to TWO executable dirs.
    fs.mkdirSync(path.join(homeA, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'hooks', 'h.js'), 'x\n');
    fs.writeFileSync(path.join(homeA, 'rules', 'style.md'), '# style v2\n');
    assert.equal(engineA.push().pushed, true);

    const pull1 = engineB.pull();
    assert.deepEqual(pull1.pendingConfirmation.map(p => p.dir).sort(), ['hooks', 'rules']);
    const remoteHead = engineB.gitExecFile(['rev-parse', 'origin/main']);

    // Apply ONLY hooks.
    const applyRes = engineB.applyPendingDirs(['hooks']);
    assert.equal(applyRes.applied, true);
    assert.deepEqual(applyRes.dirs, ['hooks']);
    assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'h.js')), true);
    assert.equal(fs.readFileSync(path.join(homeB, 'rules', 'style.md'), 'utf8'), '# style\n', 'rules must remain unapplied');

    // last-sync advanced, but the state file survives with the remainder.
    assert.equal(engineB.loadLastSync().commitHash, remoteHead);
    const state = engineB.loadPendingApply();
    assert.ok(state, 'pending state must survive a partial apply');
    assert.deepEqual(state.dirs, ['rules']);

    // Next pull: no false divergence, and ONLY rules is re-offered.
    const pull2 = engineB.pull();
    assert.notEqual(pull2.reason, 'local-changes-pending');
    assert.deepEqual(pull2.pendingConfirmation.map(p => p.dir), ['rules']);
    assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'h.js')), true);
  } finally {
    rmDir(root);
  }
});

test('minor: local-changes-pending result carries pendingConfirmation/unknownRemoteDirs fields', () => {
  const root = mkTmpDir('claude-sync-lcp-fields-');
  try {
    const { homeA, engineA, engineB, homeB } = twoConvergedHomes(root);

    // Remote advances AND B has a genuine unpushed local edit.
    writeJson(path.join(homeA, 'settings.json'), { theme: 'light' });
    engineA.push();
    writeJson(path.join(homeB, 'settings.json'), { theme: 'blue' });

    const res = engineB.pull({ mode: 'safe' });
    assert.equal(res.reason, 'local-changes-pending');
    assert.deepEqual(res.pendingConfirmation, []);
    assert.ok(Array.isArray(res.unknownRemoteDirs));
    assert.ok(Array.isArray(res.suspiciousRemoteDirs));
  } finally {
    rmDir(root);
  }
});

test('minor: applyPendingDirs aborts (and applies nothing) when the reviewed commit cannot be restored', () => {
  const root = mkTmpDir('claude-sync-reset-fail-');
  try {
    const { homeA, engineA, engineB, homeB } = twoConvergedHomes(root);

    fs.mkdirSync(path.join(homeA, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'hooks', 'h.js'), 'x\n');
    engineA.push();
    engineB.pull();

    // Corrupt the stashed commit hash: reset --hard must fail, and the apply
    // must abort BEFORE importing anything.
    const state = engineB.loadPendingApply();
    state.pendingLastSync.commitHash = '0'.repeat(40);
    fs.writeFileSync(engineB.PENDING_APPLY_PATH, JSON.stringify(state));

    assert.throws(() => engineB.applyPendingDirs(['hooks']), /reviewed commit/i);
    assert.equal(fs.existsSync(path.join(homeB, 'hooks', 'h.js')), false, 'nothing may be applied after a failed reset');
    assert.equal(fs.existsSync(engineB.PENDING_APPLY_PATH), true, 'state must remain recoverable');
  } finally {
    rmDir(root);
  }
});
