'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { removeStalePaths } = require('../../lib/sync-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content || '');
}

test('removeStalePaths: removes dest entries that no longer exist in src', () => {
  const root = mkTmpDir('claude-sync-stale-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'keep.md'), 'k');
    writeFile(path.join(dest, 'keep.md'), 'k');
    writeFile(path.join(dest, 'gone.md'), 'g'); // not in src -> stale

    removeStalePaths(src, dest);

    assert.equal(fs.existsSync(path.join(dest, 'keep.md')), true);
    assert.equal(fs.existsSync(path.join(dest, 'gone.md')), false);
  } finally {
    rmDir(root);
  }
});

test('removeStalePaths: recurses into subdirectories', () => {
  const root = mkTmpDir('claude-sync-stale-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'sub', 'keep.md'), 'k');
    writeFile(path.join(dest, 'sub', 'keep.md'), 'k');
    writeFile(path.join(dest, 'sub', 'gone.md'), 'g');
    writeFile(path.join(dest, 'sub', 'nested', 'also-gone.md'), 'g');

    removeStalePaths(src, dest);

    assert.equal(fs.existsSync(path.join(dest, 'sub', 'keep.md')), true);
    assert.equal(fs.existsSync(path.join(dest, 'sub', 'gone.md')), false);
    assert.equal(fs.existsSync(path.join(dest, 'sub', 'nested')), false);
  } finally {
    rmDir(root);
  }
});

test('removeStalePaths: a whole stale subdirectory (not present in src at all) is removed recursively', () => {
  const root = mkTmpDir('claude-sync-stale-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    writeFile(path.join(dest, 'staleDir', 'a.md'), 'a');
    writeFile(path.join(dest, 'staleDir', 'nested', 'b.md'), 'b');

    removeStalePaths(src, dest);

    assert.equal(fs.existsSync(path.join(dest, 'staleDir')), false);
  } finally {
    rmDir(root);
  }
});

test('removeStalePaths: entries in the exclude set are never removed, even when missing from src', () => {
  const root = mkTmpDir('claude-sync-stale-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    writeFile(path.join(dest, 'cache'), 'should stay');
    writeFile(path.join(dest, 'normal.md'), 'should go');

    removeStalePaths(src, dest, new Set(['cache']));

    assert.equal(fs.existsSync(path.join(dest, 'cache')), true);
    assert.equal(fs.existsSync(path.join(dest, 'normal.md')), false);
  } finally {
    rmDir(root);
  }
});

test('removeStalePaths: no-op when dest does not exist', () => {
  const root = mkTmpDir('claude-sync-stale-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest-does-not-exist');
    fs.mkdirSync(src, { recursive: true });
    assert.doesNotThrow(() => removeStalePaths(src, dest));
  } finally {
    rmDir(root);
  }
});
