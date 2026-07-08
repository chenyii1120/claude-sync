'use strict';

// A-02: syncDirReportChanges() is the "only copy/delete what actually
// changed" helper used by importPluginData()/importUserConfig() so that a
// no-op pull can correctly report up-to-date instead of unconditionally
// treating every entry as a change. Content comparison uses Buffer equality
// (not utf8 strings) per C-09, so binary files compare correctly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { syncDirReportChanges } = require('../../lib/sync-engine.js');
const { mkTmpDir, rmDir } = require('../helpers/tmp.js');

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('syncDirReportChanges: copies a new file and reports it as a change', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'new.md'), 'hello');

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes, ['new.md']);
    assert.equal(fs.readFileSync(path.join(dest, 'new.md'), 'utf8'), 'hello');
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: identical content is left untouched on disk and not reported', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'same.md'), 'unchanged content');
    writeFile(path.join(dest, 'same.md'), 'unchanged content');
    // Stamp an old mtime so we can prove the file was NOT rewritten (a
    // rewrite would reset mtime to "now"), i.e. the no-op copy is actually
    // skipped, not merely left out of the report.
    const oldTime = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(dest, 'same.md'), oldTime, oldTime);

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes, []);
    const mtime = fs.statSync(path.join(dest, 'same.md')).mtime;
    assert.equal(mtime.getTime(), oldTime.getTime());
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: overwrites a file whose content differs and reports it', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'changed.md'), 'new content');
    writeFile(path.join(dest, 'changed.md'), 'old content');

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes, ['changed.md']);
    assert.equal(fs.readFileSync(path.join(dest, 'changed.md'), 'utf8'), 'new content');
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: deletes dest entries missing from src and reports them', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'keep.md'), 'k');
    writeFile(path.join(dest, 'keep.md'), 'k');
    writeFile(path.join(dest, 'gone.md'), 'g');

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes, ['gone.md']);
    assert.equal(fs.existsSync(path.join(dest, 'gone.md')), false);
    assert.equal(fs.existsSync(path.join(dest, 'keep.md')), true);
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: deleting a stale subdirectory reports each file inside it', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    fs.mkdirSync(src, { recursive: true });
    writeFile(path.join(dest, 'staleDir', 'a.md'), 'a');
    writeFile(path.join(dest, 'staleDir', 'nested', 'b.md'), 'b');

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes.sort(), ['staleDir/a.md', 'staleDir/nested/b.md']);
    assert.equal(fs.existsSync(path.join(dest, 'staleDir')), false);
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: recurses into subdirectories with "/"-joined relative paths', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'sub', 'nested', 'c.md'), 'c');

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes, ['sub/nested/c.md']);
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'nested', 'c.md'), 'utf8'), 'c');
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: excluded top-level entries are never copied, deleted, or reported', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'cache'), 'src-side cache, should be ignored');
    writeFile(path.join(dest, 'cache'), 'dest-side cache, must survive untouched');
    writeFile(path.join(dest, 'normal.md'), 'should be deleted, missing from src');

    const changes = syncDirReportChanges(src, dest, new Set(['cache']));

    assert.deepEqual(changes, ['normal.md']);
    assert.equal(fs.readFileSync(path.join(dest, 'cache'), 'utf8'), 'dest-side cache, must survive untouched');
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: a full no-op run over an identical tree reports nothing', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    writeFile(path.join(src, 'a.md'), 'a');
    writeFile(path.join(src, 'sub', 'b.md'), 'b');
    writeFile(path.join(dest, 'a.md'), 'a');
    writeFile(path.join(dest, 'sub', 'b.md'), 'b');

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes, []);
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: uses Buffer comparison so differing binary content is detected as changed (C-09)', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    // Bytes that are invalid UTF-8 on their own (lone continuation/lead
    // bytes) -- naive `readFileSync(p, 'utf8')` comparison would decode
    // both to the same U+FFFD replacement character sequence and wrongly
    // report them as identical.
    writeFile(path.join(src, 'bin.dat'), Buffer.from([0xff, 0x00, 0xfe, 0x01]));
    writeFile(path.join(dest, 'bin.dat'), Buffer.from([0xff, 0x00, 0xfe, 0x02]));

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes, ['bin.dat']);
    assert.deepEqual(fs.readFileSync(path.join(dest, 'bin.dat')), Buffer.from([0xff, 0x00, 0xfe, 0x01]));
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: identical binary content (Buffer-equal) is left untouched and not reported (C-09)', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src');
    const dest = path.join(root, 'dest');
    const bin = Buffer.from([0xff, 0x00, 0xfe, 0x01]);
    writeFile(path.join(src, 'bin.dat'), bin);
    writeFile(path.join(dest, 'bin.dat'), Buffer.from(bin));
    const oldTime = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(dest, 'bin.dat'), oldTime, oldTime);

    const changes = syncDirReportChanges(src, dest);

    assert.deepEqual(changes, []);
    assert.equal(fs.statSync(path.join(dest, 'bin.dat')).mtime.getTime(), oldTime.getTime());
  } finally {
    rmDir(root);
  }
});

test('syncDirReportChanges: no-op when both src and dest do not exist', () => {
  const root = mkTmpDir('claude-sync-syncdir-');
  try {
    const src = path.join(root, 'src-does-not-exist');
    const dest = path.join(root, 'dest-does-not-exist');
    assert.doesNotThrow(() => {
      const changes = syncDirReportChanges(src, dest);
      assert.deepEqual(changes, []);
    });
  } finally {
    rmDir(root);
  }
});
