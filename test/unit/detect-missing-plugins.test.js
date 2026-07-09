'use strict';

// D-03: detectMissingPlugins() returns the KEYS of installed_plugins.json's
// `plugins` object for any plugin whose installPath no longer exists. Those
// keys are already `plugin@marketplace` (e.g. "superpowers@claude-plugins-official")
// -- verified against a real ~/.claude/plugins/installed_plugins.json -- so the
// returned strings are directly usable, VERBATIM, as the argument to
// `claude plugin install <arg>`. This test pins that contract: the returned
// value must contain '@' and end with the marketplace segment, and must
// exclude any plugin whose installPath still exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

test('detectMissingPlugins: returns install-ready plugin@marketplace strings for missing installPaths only', () => {
  const root = mkTmpDir('claude-sync-missing-plugins-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    const pluginsDir = path.join(claudeHome, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });

    // beta's installPath genuinely exists on disk.
    const betaInstallPath = path.join(pluginsDir, 'beta-install');
    fs.mkdirSync(betaInstallPath, { recursive: true });

    // alpha's installPath does NOT exist -- this is the "missing plugin" case.
    const alphaInstallPath = path.join(pluginsDir, 'alpha-install-gone');

    const installedPlugins = {
      plugins: {
        'alpha@market-one': [{ scope: 'user', installPath: alphaInstallPath, version: '1.0.0' }],
        'beta@market-two': [{ scope: 'user', installPath: betaInstallPath, version: '2.0.0' }],
      },
    };
    fs.writeFileSync(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify(installedPlugins, null, 2),
    );

    const engine = loadEngine(claudeHome);
    const missing = engine.detectMissingPlugins();

    assert.deepEqual(missing, ['alpha@market-one']);

    // Contract check: the returned string is already install-ready --
    // it contains '@' and ends with the marketplace segment.
    assert.equal(missing[0].includes('@'), true);
    assert.equal(missing[0].endsWith('@market-one'), true);

    // The plugin whose installPath exists is excluded.
    assert.equal(missing.includes('beta@market-two'), false);
  } finally {
    rmDir(root);
  }
});
