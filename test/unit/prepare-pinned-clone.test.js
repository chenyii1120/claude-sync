'use strict';

// Phase 1B (sync-pin): preparePinnedClone() prepares a full local clone of a
// marketplace, checked out (detached) at a locked commit -- the pure
// git/filesystem mechanics behind pinning a plugin marketplace to an exact
// commit. sanitizeMarketplaceName() is the path-traversal guard that keeps
// the marketplace name (attacker-influenceable via a synced plugins.lock.json)
// from escaping cloneRoot when it's joined into a directory path.
//
// No `claude plugin` CLI calls happen here -- only `git` and `fs` -- so this
// is fully testable against real local git repos used as "remotes" (the same
// pattern validateRemoteUrl's own tests + init-failure-cleanup.test.js use:
// validateRemoteUrl() accepts a path to an existing local directory).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');
const { git, setIdentity, writeAndCommit } = require('../helpers/git.js');

// Builds a plain (non-bare) local git repo at `dir` with a local identity,
// suitable for use as `url` (a real local remote -- validateRemoteUrl and
// `git clone` both accept a path to an existing directory).
function makeSourceRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  setIdentity(dir);
  return dir;
}

test('sanitizeMarketplaceName: rejects path-traversal and separator forms', () => {
  const home = mkTmpDir('claude-sync-spmn-');
  try {
    const engine = loadEngine(home);
    assert.equal(engine.sanitizeMarketplaceName('../etc'), null);
    assert.equal(engine.sanitizeMarketplaceName('a/b'), null);
    assert.equal(engine.sanitizeMarketplaceName('a\\b'), null);
    assert.equal(engine.sanitizeMarketplaceName('.'), null);
    assert.equal(engine.sanitizeMarketplaceName('..'), null);
    assert.equal(engine.sanitizeMarketplaceName(''), null);
  } finally {
    rmDir(home);
  }
});

test('sanitizeMarketplaceName: accepts safe single-segment names unchanged', () => {
  const home = mkTmpDir('claude-sync-spmn-');
  try {
    const engine = loadEngine(home);
    assert.equal(engine.sanitizeMarketplaceName('everything-claude-code'), 'everything-claude-code');
    assert.equal(engine.sanitizeMarketplaceName('claude_plugins.official'), 'claude_plugins.official');
  } finally {
    rmDir(home);
  }
});

test('preparePinnedClone: invalid name is rejected and creates nothing outside cloneRoot', () => {
  const root = mkTmpDir('claude-sync-ppc-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const result = engine.preparePinnedClone('../evil', sourceDir, 'HEAD', { cloneRoot });

    assert.deepEqual(result, { status: 'invalid-name' });
    // Nothing traversal-related was created: no sibling 'evil' dir, and
    // cloneRoot itself was never even created.
    assert.equal(fs.existsSync(path.join(root, 'evil')), false);
    assert.equal(fs.existsSync(cloneRoot), false);
  } finally {
    rmDir(root);
  }
});

test('preparePinnedClone: invalid url is rejected', () => {
  const root = mkTmpDir('claude-sync-ppc-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);
    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const nonExistentUrl = path.join(root, 'nope');

    const result = engine.preparePinnedClone('my-marketplace', nonExistentUrl, 'HEAD', { cloneRoot });

    assert.deepEqual(result, { status: 'invalid-url' });
  } finally {
    rmDir(root);
  }
});

test('preparePinnedClone: happy path clones and checks out the requested commit, detached', () => {
  const root = mkTmpDir('claude-sync-ppc-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const result = engine.preparePinnedClone('my-marketplace', sourceDir, commitX, { cloneRoot });

    assert.equal(result.status, 'ready');
    assert.equal(result.cloneDir, path.join(cloneRoot, 'my-marketplace'));
    assert.equal(git(result.cloneDir, ['rev-parse', 'HEAD']), commitX);
    // Detached HEAD: rev-parse --abbrev-ref HEAD reports the literal 'HEAD'
    // string instead of a branch name when detached.
    assert.equal(git(result.cloneDir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  } finally {
    rmDir(root);
  }
});

test('preparePinnedClone: unreproducible commit is reported without throwing and without checkout', () => {
  const root = mkTmpDir('claude-sync-ppc-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const bogusCommit = 'f'.repeat(40);

    let result;
    assert.doesNotThrow(() => {
      result = engine.preparePinnedClone('my-marketplace', sourceDir, bogusCommit, { cloneRoot });
    });
    assert.deepEqual(result, { status: 'unreproducible', commit: bogusCommit });
  } finally {
    rmDir(root);
  }
});

test('preparePinnedClone: second call with the same args is idempotent (reuses the existing clone)', () => {
  const root = mkTmpDir('claude-sync-ppc-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const first = engine.preparePinnedClone('my-marketplace', sourceDir, commitX, { cloneRoot });
    const second = engine.preparePinnedClone('my-marketplace', sourceDir, commitX, { cloneRoot });

    assert.equal(first.status, 'ready');
    assert.equal(second.status, 'ready');
    assert.equal(second.cloneDir, first.cloneDir);
    assert.equal(git(second.cloneDir, ['rev-parse', 'HEAD']), commitX);
  } finally {
    rmDir(root);
  }
});

test('preparePinnedClone: re-preparing an existing clone at a different commit checks out the new commit', () => {
  const root = mkTmpDir('claude-sync-ppc-');
  try {
    const home = path.join(root, 'claude-home');
    const engine = loadEngine(home);
    const sourceDir = makeSourceRepo(path.join(root, 'source'));
    writeAndCommit(sourceDir, 'file.txt', 'hello', 'first commit');
    const commitX = git(sourceDir, ['rev-parse', 'HEAD']);
    writeAndCommit(sourceDir, 'file.txt', 'hello again', 'second commit');
    const commitY = git(sourceDir, ['rev-parse', 'HEAD']);

    const cloneRoot = path.join(root, 'pinned-marketplaces');
    const first = engine.preparePinnedClone('my-marketplace', sourceDir, commitX, { cloneRoot });
    assert.equal(first.status, 'ready');
    assert.equal(git(first.cloneDir, ['rev-parse', 'HEAD']), commitX);

    const second = engine.preparePinnedClone('my-marketplace', sourceDir, commitY, { cloneRoot });
    assert.equal(second.status, 'ready');
    assert.equal(git(second.cloneDir, ['rev-parse', 'HEAD']), commitY);
  } finally {
    rmDir(root);
  }
});
