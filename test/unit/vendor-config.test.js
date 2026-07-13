'use strict';

// Phase 2 (sync-pin vendor fallback): vendorMarketplaces()/setVendorMarketplace()
// are the config-level toggle exposed to users via `/sync-pin vendor`. They
// mirror the existing pinPluginsEnabled()/setPinPlugins() style: read/write
// `config.vendorMarketplaces` (an array of marketplace names) in
// ~/.claude/sync/config.json, which exportPluginVendorBundles() consumes to
// decide which pinned marketplaces get git-bundled on push.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

function seedConfig(claudeHome, config = {}) {
  const syncDir = path.join(claudeHome, 'sync');
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(
    path.join(syncDir, 'config.json'),
    JSON.stringify({ repo: 'git@example.com:me/sync.git', branch: 'main', ...config }, null, 2),
  );
}

function readConfig(claudeHome) {
  return JSON.parse(fs.readFileSync(path.join(claudeHome, 'sync', 'config.json'), 'utf8'));
}

test('vendorMarketplaces: defaults to [] when the field is absent', () => {
  const root = mkTmpDir('claude-sync-vendor-config-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedConfig(claudeHome);

    const engine = loadEngine(claudeHome);
    assert.deepEqual(engine.vendorMarketplaces(), []);
  } finally {
    rmDir(root);
  }
});

test('vendorMarketplaces: reflects the persisted config', () => {
  const root = mkTmpDir('claude-sync-vendor-config-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedConfig(claudeHome, { vendorMarketplaces: ['ecc'] });

    const engine = loadEngine(claudeHome);
    assert.deepEqual(engine.vendorMarketplaces(), ['ecc']);
  } finally {
    rmDir(root);
  }
});

test('setVendorMarketplace(name, true): adds the marketplace, dedup on repeat', () => {
  const root = mkTmpDir('claude-sync-vendor-config-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedConfig(claudeHome);

    const engine = loadEngine(claudeHome);
    const result = engine.setVendorMarketplace('ecc', true);
    assert.deepEqual(result, ['ecc']);
    assert.deepEqual(readConfig(claudeHome).vendorMarketplaces, ['ecc']);

    // Calling again is a no-op -- no duplicate entry.
    const result2 = engine.setVendorMarketplace('ecc', true);
    assert.deepEqual(result2, ['ecc']);
    assert.deepEqual(readConfig(claudeHome).vendorMarketplaces, ['ecc']);
  } finally {
    rmDir(root);
  }
});

test('setVendorMarketplace(name, false): removes the marketplace, no-op if absent', () => {
  const root = mkTmpDir('claude-sync-vendor-config-');
  try {
    const claudeHome = path.join(root, 'claude-home');
    seedConfig(claudeHome, { vendorMarketplaces: ['ecc', 'other'] });

    const engine = loadEngine(claudeHome);
    const result = engine.setVendorMarketplace('ecc', false);
    assert.deepEqual(result, ['other']);
    assert.deepEqual(readConfig(claudeHome).vendorMarketplaces, ['other']);

    // Removing an absent name is a no-op.
    const result2 = engine.setVendorMarketplace('ecc', false);
    assert.deepEqual(result2, ['other']);
    assert.deepEqual(readConfig(claudeHome).vendorMarketplaces, ['other']);
  } finally {
    rmDir(root);
  }
});
