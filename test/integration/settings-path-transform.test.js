'use strict';

// A-04 scenario: settings.json (unlike plugin configs) was never run through
// transformPathsForExport/Import, so an absolute CLAUDE_HOME path embedded in
// a hook `command` string (very common -- /sync-init step 6 already warned
// about this) synced verbatim and broke on any machine with a different
// username/home directory.
//
// Verification recipe (from the task brief): settings.json with a hook
// command containing an absolute `~/.claude/...` path -> push -> repo file
// contains `${CLAUDE_HOME}` -> pull on a DIFFERENT home -> restored with
// THAT home's absolute path.
//
// Also verifies the fix doesn't introduce false diffs: diffSettings() and
// getLocalDelta() (via previewPull()) must NOT report a difference when the
// only delta between local and repo content is the placeholder
// transformation, but must still report a genuine settings change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { writeJson } = require('../helpers/claude-home.js');

function seedHomeWithHookPath(claudeHome) {
  fs.mkdirSync(claudeHome, { recursive: true });
  const hookScript = path.join(claudeHome, 'hooks', 'foo.js');
  writeJson(path.join(claudeHome, 'settings.json'), {
    theme: 'dark',
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: `node "${hookScript}"` }] },
      ],
    },
  });
}

test('settings.json hook command with an absolute CLAUDE_HOME path survives push -> pull onto a DIFFERENT home (A-04)', () => {
  const root = mkTmpDir('claude-sync-settings-transform-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A: first to init -- empty repo, so init() pushes immediately.
    const homeA = path.join(root, 'home-a');
    seedHomeWithHookPath(homeA);
    const engineA = loadEngine(homeA);
    const initA = engineA.init(remoteDir);
    assert.equal(initA.hasContent, false);

    // The repo copy must contain the ${CLAUDE_HOME} placeholder, not A's raw
    // absolute path.
    const repoSettingsPath = path.join(engineA.REPO_DIR, 'global', 'settings.json');
    const repoContent = fs.readFileSync(repoSettingsPath, 'utf8');
    assert.equal(repoContent.includes(homeA), false, 'repo settings.json must not contain the raw local home path');
    assert.match(repoContent, /\$\{CLAUDE_HOME\}\/hooks\/foo\.js/);

    // Machine B: a DIFFERENT home directory, joins via first pull.
    const homeB = path.join(root, 'home-b');
    seedHomeWithHookPath(homeB); // seeded with B's own path so B's baseline is self-consistent
    const engineB = loadEngine(homeB);
    const initB = engineB.init(remoteDir);
    assert.equal(initB.hasContent, true);
    const pullB = engineB.pull();
    assert.equal(pullB.mode, 'first-pull');

    // B's local settings.json must now contain B's OWN absolute path, not A's.
    const settingsB = JSON.parse(fs.readFileSync(path.join(homeB, 'settings.json'), 'utf8'));
    const commandB = settingsB.hooks.SessionStart[0].hooks[0].command;
    assert.equal(commandB.includes(homeA), false, 'B must not end up with A\'s absolute path');
    assert.match(commandB, new RegExp(`node "${path.join(homeB, 'hooks', 'foo.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));

    // No false diff: B is fully converged with the repo it just pulled.
    assert.deepEqual(engineB.diffSettings(), []);
    const previewAfterConverge = engineB.previewPull();
    assert.equal(previewAfterConverge.recommendation, 'up-to-date');
    assert.deepEqual(previewAfterConverge.localDelta.settingsKeys, []);

    // A genuine remote settings change must still be detected as a real diff,
    // not swallowed by the path-transform logic.
    const settingsA = JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8'));
    settingsA.theme = 'light';
    fs.writeFileSync(path.join(homeA, 'settings.json'), JSON.stringify(settingsA, null, 2));
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    engineB.gitFetch();
    const diffsAfterRealChange = engineB.diffSettings();
    assert.equal(diffsAfterRealChange.length, 1);
    assert.deepEqual(diffsAfterRealChange[0], { field: 'theme', local: 'dark', remote: 'light' });
  } finally {
    rmDir(root);
  }
});

test('round-trips settings.json with NO CLAUDE_HOME paths losslessly through push/pull (A-04 no-regression)', () => {
  const root = mkTmpDir('claude-sync-settings-transform-noop-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    fs.mkdirSync(homeA, { recursive: true });
    writeJson(path.join(homeA, 'settings.json'), { theme: 'dark', language: 'en' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    fs.mkdirSync(homeB, { recursive: true });
    writeJson(path.join(homeB, 'settings.json'), { theme: 'dark', language: 'en' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    const pullB = engineB.pull();
    assert.equal(pullB.mode, 'first-pull');

    const settingsB = JSON.parse(fs.readFileSync(path.join(homeB, 'settings.json'), 'utf8'));
    assert.deepEqual(settingsB, { theme: 'dark', language: 'en' });
    assert.deepEqual(engineB.diffSettings(), []);
  } finally {
    rmDir(root);
  }
});

test('getLocalDelta(): no false "local diverged" delta when only the CLAUDE_HOME placeholder differs (A-04)', () => {
  const root = mkTmpDir('claude-sync-settings-transform-delta-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedHomeWithHookPath(homeA);
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    seedHomeWithHookPath(homeB);
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();

    // B is now converged with base. A second, no-op pull attempt must see an
    // empty local delta even though B's on-disk settings.json holds B's own
    // absolute path while the base commit (last-sync ref) holds the
    // ${CLAUDE_HOME} placeholder written by A's push.
    const lastSync = engineB.loadLastSync();
    const delta = engineB.getLocalDelta(lastSync.commitHash);
    assert.deepEqual(delta.settingsKeys, []);
    assert.equal(engineB.isLocalDeltaEmpty(delta), true);
  } finally {
    rmDir(root);
  }
});
