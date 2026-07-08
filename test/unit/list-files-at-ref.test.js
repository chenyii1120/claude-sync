'use strict';

// C-01: listFilesAtRef() is the remote-side counterpart to
// listFilesRecursive() — it lists files at a git ref (e.g. origin/main)
// instead of walking a working-tree directory, so diff functions can see
// content that has been fetched but not yet checked out locally.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { initBareRepo, cloneWithIdentity, writeAndCommit, git } = require('../helpers/git.js');

test('listFilesAtRef: lists files under a prefix at a ref, stripping the prefix and joining with "/"', () => {
  const root = mkTmpDir('claude-sync-list-at-ref-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));

    const seedClone = cloneWithIdentity(remoteDir, path.join(root, 'seed-clone'));
    writeAndCommit(seedClone, 'user-config/rules/a.md', '# a\n', 'add a');
    writeAndCommit(seedClone, 'user-config/rules/sub/b.md', '# b\n', 'add b');
    writeAndCommit(seedClone, 'user-config/other/c.md', '# c\n', 'add c');
    git(seedClone, ['push', 'origin', 'main']);

    // The engine's REPO_DIR must itself be a clone with the ref fetched --
    // listFilesAtRef always operates via gitExecFile (`-C REPO_DIR`).
    const claudeHome = path.join(root, 'claude-home');
    const repoDir = path.join(claudeHome, 'sync', 'repo');
    execFileSync('git', ['clone', remoteDir, repoDir], { stdio: 'pipe' });

    const engine = loadEngine(claudeHome);
    const result = engine.listFilesAtRef('origin/main', 'user-config/rules');
    assert.equal(result instanceof Set, true);
    assert.deepEqual([...result].sort(), ['a.md', 'sub/b.md']);
  } finally {
    rmDir(root);
  }
});

test('listFilesAtRef: returns an empty Set when the prefix does not exist at the ref', () => {
  const root = mkTmpDir('claude-sync-list-at-ref-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const seedClone = cloneWithIdentity(remoteDir, path.join(root, 'seed-clone'));
    writeAndCommit(seedClone, 'user-config/rules/a.md', '# a\n', 'add a');
    git(seedClone, ['push', 'origin', 'main']);

    const claudeHome = path.join(root, 'claude-home');
    const repoDir = path.join(claudeHome, 'sync', 'repo');
    execFileSync('git', ['clone', remoteDir, repoDir], { stdio: 'pipe' });

    const engine = loadEngine(claudeHome);
    const result = engine.listFilesAtRef('origin/main', 'user-config/nonexistent-dir');
    assert.equal(result instanceof Set, true);
    assert.equal(result.size, 0);
  } finally {
    rmDir(root);
  }
});

test('listFilesAtRef: returns an empty Set (not a throw) when the ref does not exist', () => {
  const root = mkTmpDir('claude-sync-list-at-ref-');
  try {
    const remoteDir = initBareRepo(path.join(root, 'remote.git'));
    const seedClone = cloneWithIdentity(remoteDir, path.join(root, 'seed-clone'));
    writeAndCommit(seedClone, 'user-config/rules/a.md', '# a\n', 'add a');
    git(seedClone, ['push', 'origin', 'main']);

    const claudeHome = path.join(root, 'claude-home');
    const repoDir = path.join(claudeHome, 'sync', 'repo');
    execFileSync('git', ['clone', remoteDir, repoDir], { stdio: 'pipe' });

    const engine = loadEngine(claudeHome);
    const result = engine.listFilesAtRef('origin/no-such-branch', 'user-config/rules');
    assert.equal(result instanceof Set, true);
    assert.equal(result.size, 0);
  } finally {
    rmDir(root);
  }
});
