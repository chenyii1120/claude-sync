'use strict';

// Builds a minimal, fake ~/.claude directory tree for integration tests.
// Keep this intentionally small: extra dirs (rules/, plugins/, etc.) pull in
// the A-01/A-02/A-03 change-detection bugs documented in
// docs/issues-and-fix-plan.md, which would make "up-to-date" assertions
// flaky until those are fixed in later tasks. Callers that specifically want
// to exercise user-config dirs or plugin data should opt in explicitly.

const fs = require('fs');
const path = require('path');

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Seeds settings.json only (no user-config dirs, no plugins/). Safe for
// tests that need clean "nothing changed" detection.
function seedMinimalHome(claudeHome, settings) {
  fs.mkdirSync(claudeHome, { recursive: true });
  writeJson(path.join(claudeHome, 'settings.json'), settings || { theme: 'dark' });
}

// Seeds settings.json plus a `rules/` dir with one file — for tests that
// specifically want to exercise user-config dir sync.
function seedFullHome(claudeHome, opts = {}) {
  fs.mkdirSync(claudeHome, { recursive: true });
  writeJson(path.join(claudeHome, 'settings.json'), opts.settings || { theme: 'dark' });
  const ruleFile = path.join(claudeHome, 'rules', 'style.md');
  fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
  fs.writeFileSync(ruleFile, opts.ruleContent || '# style\n');
}

module.exports = { writeJson, seedMinimalHome, seedFullHome };
