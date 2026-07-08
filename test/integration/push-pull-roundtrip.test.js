'use strict';

// F-01 integration scenario: two "machines" sharing one bare remote.
// Machine A creates the repo, machine B joins via first-pull, B pushes a
// change, A pulls it. A second no-op pull on A should then report
// up-to-date (settings-only scenario, so this isn't tripped up by the
// known A-02 "always reports changes" bug in importUserConfig/importPluginData
// — see docs/issues-and-fix-plan.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome } = require('../helpers/claude-home.js');

test('push()/pull() round trip between two machines converges, and a no-op pull reports up-to-date', () => {
  const root = mkTmpDir('claude-sync-roundtrip-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    // Machine A: first to init — empty repo, so init() pushes immediately.
    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    const engineA = loadEngine(homeA);
    const initA = engineA.init(remoteDir);
    assert.equal(initA.hasContent, false);

    // Machine B: joins the now-populated repo via first pull.
    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    const initB = engineB.init(remoteDir);
    assert.equal(initB.hasContent, true);
    const pullB = engineB.pull();
    assert.equal(pullB.mode, 'first-pull');

    // Machine B changes a setting and pushes.
    const settingsPathB = path.join(homeB, 'settings.json');
    fs.writeFileSync(settingsPathB, JSON.stringify({ theme: 'light' }, null, 2));
    const pushB = engineB.push();
    assert.equal(pushB.pushed, true);

    // Machine A pulls — should fast-forward and pick up B's change.
    const engineAReload = loadEngine(homeA);
    const pullA1 = engineAReload.pull();
    assert.equal(pullA1.pulled, true);
    assert.equal(pullA1.mode, 'fast-forward');
    const settingsA = JSON.parse(fs.readFileSync(path.join(homeA, 'settings.json'), 'utf8'));
    assert.deepEqual(settingsA, { theme: 'light' });

    // A second, no-op pull on A (nothing changed since) should report
    // up-to-date rather than pulled:true.
    const pullA2 = engineAReload.pull();
    assert.equal(pullA2.pulled, false);
    assert.equal(pullA2.reason, 'up-to-date');
  } finally {
    rmDir(root);
  }
});
