'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listFilesRecursive } = require('../../lib/sync-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content || '');
}

test('listFilesRecursive: returns an empty Set for a non-existent directory', () => {
  const root = mkTmpDir('claude-sync-list-');
  try {
    const result = listFilesRecursive(path.join(root, 'nope'));
    assert.equal(result instanceof Set, true);
    assert.equal(result.size, 0);
  } finally {
    rmDir(root);
  }
});

test('listFilesRecursive: lists top-level files', () => {
  const root = mkTmpDir('claude-sync-list-');
  try {
    writeFile(path.join(root, 'a.md'), 'a');
    writeFile(path.join(root, 'b.md'), 'b');
    const result = listFilesRecursive(root);
    assert.deepEqual([...result].sort(), ['a.md', 'b.md']);
  } finally {
    rmDir(root);
  }
});

test('listFilesRecursive: joins nested paths with "/" regardless of platform separator', () => {
  const root = mkTmpDir('claude-sync-list-');
  try {
    writeFile(path.join(root, 'sub', 'nested', 'c.md'), 'c');
    const result = listFilesRecursive(root);
    assert.deepEqual([...result], ['sub/nested/c.md']);
  } finally {
    rmDir(root);
  }
});

test('listFilesRecursive: skips .DS_Store files', () => {
  const root = mkTmpDir('claude-sync-list-');
  try {
    writeFile(path.join(root, '.DS_Store'), '');
    writeFile(path.join(root, 'sub', '.DS_Store'), '');
    writeFile(path.join(root, 'sub', 'kept.md'), 'k');
    const result = listFilesRecursive(root);
    assert.deepEqual([...result], ['sub/kept.md']);
  } finally {
    rmDir(root);
  }
});

test('listFilesRecursive: honors an explicit prefix argument', () => {
  const root = mkTmpDir('claude-sync-list-');
  try {
    writeFile(path.join(root, 'a.md'), 'a');
    const result = listFilesRecursive(root, 'prefix');
    assert.deepEqual([...result], ['prefix/a.md']);
  } finally {
    rmDir(root);
  }
});
