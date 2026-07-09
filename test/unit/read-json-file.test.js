'use strict';

// C-04: unit tests for the shared readJsonFile() guard added to
// lib/sync-engine.js. Covers the four required/ENOENT/malformed combinations
// called out in task-C04-decisions.md's test plan.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadEngine } = require('../helpers/load-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

test('readJsonFile: valid JSON is parsed and returned', () => {
  const claudeHome = mkTmpDir('claude-sync-readjson-valid-');
  try {
    const engine = loadEngine(claudeHome);
    const filePath = path.join(claudeHome, 'valid.json');
    fs.writeFileSync(filePath, JSON.stringify({ a: 1, b: [2, 3] }));
    const result = engine.readJsonFile(filePath, { required: true });
    assert.deepEqual(result, { a: 1, b: [2, 3] });
  } finally {
    rmDir(claudeHome);
  }
});

test('readJsonFile: malformed JSON + required:true throws an Error naming the path', () => {
  const claudeHome = mkTmpDir('claude-sync-readjson-malformed-required-');
  try {
    const engine = loadEngine(claudeHome);
    const filePath = path.join(claudeHome, 'broken.json');
    fs.writeFileSync(filePath, '{ not valid json');
    assert.throws(
      () => engine.readJsonFile(filePath, { required: true }),
      (err) => err instanceof Error && err.message.includes(filePath),
    );
  } finally {
    rmDir(claudeHome);
  }
});

test('readJsonFile: malformed JSON + required:false + warnings array returns fallback and records exactly one warning', () => {
  const claudeHome = mkTmpDir('claude-sync-readjson-malformed-fallback-');
  try {
    const engine = loadEngine(claudeHome);
    const filePath = path.join(claudeHome, 'broken.json');
    fs.writeFileSync(filePath, '{ not valid json');
    const warnings = [];
    const result = engine.readJsonFile(filePath, { required: false, fallback: { safe: true }, warnings });
    assert.deepEqual(result, { safe: true });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /malformed json/i);
    assert.ok(warnings[0].includes(filePath));
  } finally {
    rmDir(claudeHome);
  }
});

test('readJsonFile: ENOENT + required:true returns fallback (does NOT throw)', () => {
  const claudeHome = mkTmpDir('claude-sync-readjson-enoent-required-');
  try {
    const engine = loadEngine(claudeHome);
    const filePath = path.join(claudeHome, 'does-not-exist.json');
    const result = engine.readJsonFile(filePath, { required: true, fallback: { missing: true } });
    assert.deepEqual(result, { missing: true });
  } finally {
    rmDir(claudeHome);
  }
});

test('readJsonFile: ENOENT + required:false returns fallback', () => {
  const claudeHome = mkTmpDir('claude-sync-readjson-enoent-fallback-');
  try {
    const engine = loadEngine(claudeHome);
    const filePath = path.join(claudeHome, 'does-not-exist.json');
    const result = engine.readJsonFile(filePath, { required: false, fallback: [] });
    assert.deepEqual(result, []);
  } finally {
    rmDir(claudeHome);
  }
});

test('readJsonFile: ENOENT with no fallback specified defaults to null', () => {
  const claudeHome = mkTmpDir('claude-sync-readjson-enoent-default-');
  try {
    const engine = loadEngine(claudeHome);
    const filePath = path.join(claudeHome, 'does-not-exist.json');
    assert.equal(engine.readJsonFile(filePath), null);
  } finally {
    rmDir(claudeHome);
  }
});

test('readJsonFile: malformed JSON + required:false + no warnings array does not throw', () => {
  const claudeHome = mkTmpDir('claude-sync-readjson-malformed-no-warnings-');
  try {
    const engine = loadEngine(claudeHome);
    const filePath = path.join(claudeHome, 'broken.json');
    fs.writeFileSync(filePath, 'not json at all');
    const result = engine.readJsonFile(filePath, { fallback: 'fallback-value' });
    assert.equal(result, 'fallback-value');
  } finally {
    rmDir(claudeHome);
  }
});
