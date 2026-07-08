'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeJsonFields } = require('../../lib/sync-engine.js');

test('mergeJsonFields: unchanged key keeps base value', () => {
  const base = { a: 1 };
  const local = { a: 1 };
  const remote = { a: 1 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: 1 });
  assert.deepEqual(conflicts, []);
});

test('mergeJsonFields: local-only change wins with no conflict', () => {
  const base = { a: 1 };
  const local = { a: 2 };
  const remote = { a: 1 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: 2 });
  assert.deepEqual(conflicts, []);
});

test('mergeJsonFields: remote-only change wins with no conflict', () => {
  const base = { a: 1 };
  const local = { a: 1 };
  const remote = { a: 3 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: 3 });
  assert.deepEqual(conflicts, []);
});

test('mergeJsonFields: both sides change to the same value — no conflict', () => {
  const base = { a: 1 };
  const local = { a: 9 };
  const remote = { a: 9 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: 9 });
  assert.deepEqual(conflicts, []);
});

test('mergeJsonFields: conflicting scalar change — remote preference picks remote and records conflict', () => {
  const base = { a: 1 };
  const local = { a: 2 };
  const remote = { a: 3 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: 3 });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'a');
  assert.equal(conflicts[0].localValue, 2);
  assert.equal(conflicts[0].remoteValue, 3);
  assert.equal(conflicts[0].localDeleted, false);
  assert.equal(conflicts[0].remoteDeleted, false);
});

test('mergeJsonFields: conflicting scalar change — local preference picks local', () => {
  const base = { a: 1 };
  const local = { a: 2 };
  const remote = { a: 3 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'local');
  assert.deepEqual(result, { a: 2 });
  assert.equal(conflicts.length, 1);
});

test('mergeJsonFields: local deletion (remote unchanged) propagates deletion', () => {
  const base = { a: 1, b: 2 };
  const local = { b: 2 }; // a deleted locally
  const remote = { a: 1, b: 2 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { b: 2 });
  assert.equal('a' in result, false);
  assert.deepEqual(conflicts, []);
});

test('mergeJsonFields: remote deletion (local unchanged) propagates deletion', () => {
  const base = { a: 1, b: 2 };
  const local = { a: 1, b: 2 };
  const remote = { b: 2 }; // a deleted remotely
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { b: 2 });
  assert.equal('a' in result, false);
  assert.deepEqual(conflicts, []);
});

test('mergeJsonFields: local deletion vs remote modification is a conflict with localDeleted flag', () => {
  const base = { a: 1 };
  const local = {}; // deleted locally
  const remote = { a: 5 }; // modified remotely
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].localDeleted, true);
  assert.equal(conflicts[0].remoteDeleted, false);
  // remote preference: remote's value wins, key present
  assert.deepEqual(result, { a: 5 });
});

test('mergeJsonFields: local deletion vs remote modification, local preference drops the key', () => {
  const base = { a: 1 };
  const local = {};
  const remote = { a: 5 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'local');
  assert.equal(conflicts.length, 1);
  assert.equal('a' in result, false);
});

test('mergeJsonFields: a brand-new key added identically on both sides merges without conflict', () => {
  const base = {};
  const local = { a: 1 };
  const remote = { a: 1 };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: 1 });
  assert.deepEqual(conflicts, []);
});

test('mergeJsonFields: recursive merge on nested object — independent sub-key changes merge cleanly', () => {
  const base = { a: { x: 1, y: 2 } };
  const local = { a: { x: 1, y: 3 } }; // y changed locally
  const remote = { a: { x: 5, y: 2 } }; // x changed remotely
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: { x: 5, y: 3 } });
  assert.deepEqual(conflicts, []);
});

test('mergeJsonFields: recursive merge surfaces nested conflicts with dotted key path', () => {
  const base = { a: { x: 1 } };
  const local = { a: { x: 2 } };
  const remote = { a: { x: 3 } };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: { x: 3 } });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'a.x');
});

test('mergeJsonFields: nested object vs scalar type change on both sides is a top-level conflict, not recursed', () => {
  const base = { a: { x: 1 } };
  const local = { a: { x: 1, y: 2 } }; // still an object
  const remote = { a: 'now-a-string' }; // changed to a scalar
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'a');
  assert.equal(result.a, 'now-a-string');
});

test('mergeJsonFields: arrays changed on both sides are a conflict, not element-wise merged', () => {
  const base = { a: [1] };
  const local = { a: [1, 2] };
  const remote = { a: [1, 3] };
  const { result, conflicts } = mergeJsonFields(base, local, remote, 'remote');
  assert.deepEqual(result, { a: [1, 3] });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'a');
});

test('mergeJsonFields: null/undefined base treated as empty object', () => {
  const { result, conflicts } = mergeJsonFields(null, { a: 1 }, { a: 1 }, 'remote');
  assert.deepEqual(result, { a: 1 });
  assert.deepEqual(conflicts, []);
});
