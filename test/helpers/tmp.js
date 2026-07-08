'use strict';

// Tmpdir helpers shared by unit/integration/hook tests. Every test that
// touches the filesystem MUST create its sandbox through mkTmpDir() and
// clean it up through rmDir() in a finally/after — never write to the real
// ~/.claude.

const fs = require('fs');
const os = require('os');
const path = require('path');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'claude-sync-test-'));
}

function rmDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { mkTmpDir, rmDir };
