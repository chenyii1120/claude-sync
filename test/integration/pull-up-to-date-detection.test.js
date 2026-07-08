'use strict';

// A-02 regression scenario: before the fix, importPluginData() and
// importUserConfig() unconditionally pushed every entry into their
// `changes` list regardless of whether the content actually differed, so
// pull()'s `nothingChanged` check was never true once a real install had
// plugin-data or any user-config dir (which every real install does).
// Unlike push-pull-roundtrip.test.js (which deliberately uses
// seedMinimalHome -- settings only -- to dodge this bug), this test seeds a
// full home (rules/ + plugin-data) specifically to exercise it.
//
// Verification recipe (from the brief): pull once -> make no further
// changes -> pull again -> expect { pulled: false, reason: 'up-to-date' }.
// A second test guards against over-correcting to "always up-to-date": a
// real remote change must still be reported as pulled:true with the
// changed path listed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedFullHome, writeJson } = require('../helpers/claude-home.js');

function seedPluginData(claudeHome, content) {
  const dataPath = path.join(claudeHome, 'plugins', 'myplugin', 'data.json');
  writeJson(dataPath, content || { foo: 1 });
}

test('pull(): a no-op second pull reports up-to-date even with user-config dirs and plugin-data present (A-02)', () => {
  const root = mkTmpDir('claude-sync-pull-uptodate-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A: seeds settings + rules/ + plugin-data, then init() pushes
    // it all as the initial commit (empty remote).
    const homeA = path.join(root, 'home-a');
    seedFullHome(homeA, { settings: { theme: 'dark' }, ruleContent: '# style\n' });
    seedPluginData(homeA, { foo: 1 });
    const engineA = loadEngine(homeA);
    const initA = engineA.init(remoteDir);
    assert.equal(initA.hasContent, false);

    // Machine B: joins the populated repo. Its settings.json and rules/
    // file already match A's content exactly (simulating a machine that's
    // already converged); only plugin-data is genuinely new to it.
    const homeB = path.join(root, 'home-b');
    seedFullHome(homeB, { settings: { theme: 'dark' }, ruleContent: '# style\n' });
    const engineB = loadEngine(homeB);
    const initB = engineB.init(remoteDir);
    assert.equal(initB.hasContent, true);

    // First pull: brings down plugin-data B doesn't have yet, so a real
    // change happens here. (Not the scenario under test -- just setup.)
    const pullB1 = engineB.pull();
    assert.equal(pullB1.mode, 'first-pull');
    assert.equal(
      fs.existsSync(path.join(homeB, 'plugins', 'myplugin', 'data.json')),
      true,
    );

    // Second pull: nothing has changed anywhere since pullB1. This must
    // report up-to-date, not pulled:true.
    const pullB2 = engineB.pull();
    assert.equal(pullB2.pulled, false);
    assert.equal(pullB2.reason, 'up-to-date');
    assert.deepEqual(pullB2.configChanges, []);
    assert.deepEqual(pullB2.pluginDataChanges, []);
  } finally {
    rmDir(root);
  }
});

test('pull(): a real remote change after an up-to-date pull is still reported as pulled:true with the changed path listed (A-02 guard)', () => {
  const root = mkTmpDir('claude-sync-pull-realchange-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedFullHome(homeA, { settings: { theme: 'dark' }, ruleContent: '# style\n' });
    seedPluginData(homeA, { foo: 1 });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    seedFullHome(homeB, { settings: { theme: 'dark' }, ruleContent: '# style\n' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull(); // first pull, brings down plugin-data

    // Confirm convergence: a no-op pull is up-to-date before we make a
    // real change (same assertion as the sibling test, kept minimal here).
    const preCheck = engineB.pull();
    assert.equal(preCheck.pulled, false);
    assert.equal(preCheck.reason, 'up-to-date');

    // Machine A makes a real change to a user-config file and pushes it.
    // NOTE: this uses a NON-executable dir (commands/) on purpose. rules/ is
    // now a CONFIRM_REQUIRED_DIR (B-02): its changes are deferred to
    // pendingConfirmation and NOT reported in configChanges by pull(). This
    // guard is about change-detection through the normal import path, so it
    // must exercise a dir that pull() still applies directly.
    fs.mkdirSync(path.join(homeA, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'commands', 'hi.md'), '# hi v2\n');
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    // Machine B pulls -- must detect the real change and report pulled:true
    // with the changed path listed in configChanges.
    const pullB3 = engineB.pull();
    assert.equal(pullB3.pulled, true);
    assert.deepEqual(pullB3.configChanges, ['commands/hi.md']);
    assert.equal(
      fs.readFileSync(path.join(homeB, 'commands', 'hi.md'), 'utf8'),
      '# hi v2\n',
    );
    // And rules/ (executable) must NOT have been auto-applied.
    assert.deepEqual(pullB3.pendingConfirmation, []);
  } finally {
    rmDir(root);
  }
});
