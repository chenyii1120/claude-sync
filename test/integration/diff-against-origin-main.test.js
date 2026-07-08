'use strict';

// C-01 regression scenario: before the fix, diffSettings(), diffPluginConfigs(),
// diffUserConfig(), and diffPluginData() all read the "remote side" from
// REPO_DIR's working tree (= local clone's HEAD, as of the last pull/push),
// not from `origin/main`. /sync-diff calls gitFetch() first, but fetch never
// touches the working tree, so a remote change that has been fetched but not
// yet pulled was invisible to every diff preview.
//
// Verification recipe (from the brief): two clones (machine A / machine B)
// sharing one bare "remote" repo. A pushes a change. B fetches (NOT pull).
// B's diff must show the change.
//
// Each test converges A and B first (seed identical content, init both,
// have B do one pull so its local state and its repo clone's working tree
// both match the shared base), confirms the diff is empty at that point,
// then has A push a real change and has B fetch-only before diffing again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo } = require('../helpers/git.js');
const { seedMinimalHome, seedFullHome, writeJson } = require('../helpers/claude-home.js');

test('diffSettings(): shows a remote settings change that has been fetched but not pulled (C-01)', () => {
  const root = mkTmpDir('claude-sync-diff-settings-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA, { theme: 'dark' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB, { theme: 'dark' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();

    // Converged: no diff yet.
    assert.deepEqual(engineB.diffSettings(), []);

    // A changes a setting and pushes.
    writeJson(path.join(homeA, 'settings.json'), { theme: 'light' });
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    // B fetches (NOT pull): B's local settings.json is still 'dark' and
    // B's repo clone's working tree is still the old commit. The diff must
    // still show the remote change, read from origin/main.
    engineB.gitFetch();
    const diffs = engineB.diffSettings();
    assert.equal(diffs.length, 1);
    assert.deepEqual(diffs[0], { field: 'theme', local: 'dark', remote: 'light' });
  } finally {
    rmDir(root);
  }
});

test('diffUserConfig(): shows a remote rules/ file change that has been fetched but not pulled (C-01)', () => {
  const root = mkTmpDir('claude-sync-diff-userconfig-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedFullHome(homeA, { settings: { theme: 'dark' }, ruleContent: '# style v1\n' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    seedFullHome(homeB, { settings: { theme: 'dark' }, ruleContent: '# style v1\n' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();

    assert.deepEqual(engineB.diffUserConfig(), []);

    fs.writeFileSync(path.join(homeA, 'rules', 'style.md'), '# style v2\n');
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    engineB.gitFetch();
    const diffs = engineB.diffUserConfig();
    assert.equal(diffs.length, 1);
    assert.deepEqual(diffs[0], { dir: 'rules', file: 'style.md', status: 'modified' });
  } finally {
    rmDir(root);
  }
});

test('diffPluginConfigs(): shows a remote installed_plugins.json change that has been fetched but not pulled (C-01)', () => {
  const root = mkTmpDir('claude-sync-diff-pluginconfigs-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA);
    writeJson(path.join(homeA, 'plugins', 'installed_plugins.json'), { plugins: { foo: [{ version: '1.0.0' }] } });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB);
    writeJson(path.join(homeB, 'plugins', 'installed_plugins.json'), { plugins: { foo: [{ version: '1.0.0' }] } });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();

    assert.deepEqual(engineB.diffPluginConfigs(), []);

    writeJson(path.join(homeA, 'plugins', 'installed_plugins.json'), { plugins: { foo: [{ version: '2.0.0' }] } });
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    engineB.gitFetch();
    const diffs = engineB.diffPluginConfigs();
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].file, 'installed_plugins.json');
    assert.deepEqual(diffs[0].remote, { plugins: { foo: [{ version: '2.0.0' }] } });
  } finally {
    rmDir(root);
  }
});

test('diffPluginData(): shows a remote plugin-data change that has been fetched but not pulled (C-01)', () => {
  const root = mkTmpDir('claude-sync-diff-plugindata-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedMinimalHome(homeA);
    writeJson(path.join(homeA, 'plugins', 'myplugin', 'data.json'), { foo: 1 });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    seedMinimalHome(homeB);
    writeJson(path.join(homeB, 'plugins', 'myplugin', 'data.json'), { foo: 1 });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();

    assert.deepEqual(engineB.diffPluginData(), []);

    writeJson(path.join(homeA, 'plugins', 'myplugin', 'data.json'), { foo: 2 });
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    engineB.gitFetch();
    const diffs = engineB.diffPluginData();
    assert.equal(diffs.length, 1);
    assert.deepEqual(diffs[0], { file: 'myplugin/data.json', status: 'modified' });
  } finally {
    rmDir(root);
  }
});

test('diffUserConfig(): discovers a brand-new remote user-config dir that has been fetched but not pulled (C-01 review fix)', () => {
  const root = mkTmpDir('claude-sync-diff-newdir-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const homeA = path.join(root, 'home-a');
    seedFullHome(homeA, { settings: { theme: 'dark' }, ruleContent: '# style v1\n' });
    const engineA = loadEngine(homeA);
    engineA.init(remoteDir);

    const homeB = path.join(root, 'home-b');
    seedFullHome(homeB, { settings: { theme: 'dark' }, ruleContent: '# style v1\n' });
    const engineB = loadEngine(homeB);
    engineB.init(remoteDir);
    engineB.pull();

    assert.deepEqual(engineB.diffUserConfig(), []);

    // A allow-lists a brand-new dir (NOT in DEFAULT_USER_CONFIG_DIRS and not
    // existing on B in any form) and pushes it.
    fs.mkdirSync(path.join(homeA, 'statusline'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'statusline', 'foo.md'), '# foo\n');
    engineA.addAllowSyncDir('statusline');
    const pushA = engineA.push();
    assert.equal(pushA.pushed, true);

    // B fetches (NOT pull): the new dir exists only at origin/main -- it is
    // in neither B's local ~/.claude nor B's repo clone's working tree, so
    // dir discovery must come from the ref itself.
    engineB.gitFetch();
    const diffs = engineB.diffUserConfig();
    assert.deepEqual(diffs, [{ dir: 'statusline', file: 'foo.md', status: 'remote-only' }]);
  } finally {
    rmDir(root);
  }
});
