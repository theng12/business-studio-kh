/**
 * v0.1.25 — `safeFileExt`: an extension that is safe to put in a path.
 *
 * This exists because of a real write-anywhere bug. Two handlers took an
 * extension straight off the IPC payload and did:
 *
 *     const safeExt = (ext || '.png').toLowerCase().replace(/^([^.])/, '.$1');
 *     const tmpPath = path.join(tmpDir, `paste${safeExt}`);
 *
 * which looks like sanitising but is not: `path.join` normalises `..`, so
 * `ext = '.png/../../../../../../tmp/owned.jpg'` produced `/var/tmp/owned.jpg`
 * and the caller's bytes were written there. Both channels
 * (`images:importFromBytes`, `ai:queueBulkBatchFromBytes`) are reachable from a
 * remote client holding a token, so a partial sanitiser was the only thing
 * between an authenticated caller and an arbitrary file write.
 *
 * The fix rejects anything that is not exactly a dot + 2-5 alphanumerics,
 * rather than trying to clean a hostile string into a safe one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const { safeFileExt } = require('../main/util/fileKinds');

test('ordinary image extensions pass through, lower-cased', () => {
  assert.equal(safeFileExt('.png'), '.png');
  assert.equal(safeFileExt('.JPG'), '.jpg');
  assert.equal(safeFileExt('.jpeg'), '.jpeg');
  assert.equal(safeFileExt('.webp'), '.webp');
});

test('an extension given without the dot is normalised', () => {
  assert.equal(safeFileExt('png'), '.png');
  assert.equal(safeFileExt('JPEG'), '.jpeg');
});

test('path traversal cannot survive', () => {
  // The exact payloads that used to escape the temp directory.
  for (const hostile of [
    '.png/../../../../../../tmp/owned.jpg',
    '../../../etc/passwd',
    '..',
    '../..',
    '.png/..',
    '/etc/passwd',
    '.png/',
  ]) {
    const result = safeFileExt(hostile);
    assert.equal(result, '.png', `${hostile} must fall back, got ${result}`);
    // Prove it, rather than trusting the string comparison: join it the way
    // the vulnerable code did and confirm we stay inside the temp dir.
    const tmpDir = path.join(os.tmpdir(), 'iskh-paste-XXXX');
    const resolved = path.join(tmpDir, `paste${result}`);
    assert.ok(resolved.startsWith(tmpDir), `${hostile} escaped the temp dir -> ${resolved}`);
  }
});

test('a NUL byte cannot smuggle a second extension', () => {
  assert.equal(safeFileExt('.png\u0000.jpg'), '.png');
});

test('nonsense, empty and over-long values fall back rather than being cleaned', () => {
  assert.equal(safeFileExt('.p n g'), '.png');
  assert.equal(safeFileExt('.toolongextension'), '.png');
  assert.equal(safeFileExt('.a'), '.png');
  assert.equal(safeFileExt(''), '.png');
  assert.equal(safeFileExt(null), '.png');
  assert.equal(safeFileExt(undefined), '.png');
  assert.equal(safeFileExt(42), '.png');
  assert.equal(safeFileExt({}), '.png');
});

test('the fallback is configurable for non-image callers', () => {
  assert.equal(safeFileExt(null, '.jpg'), '.jpg');
  assert.equal(safeFileExt('.png', '.jpg'), '.png');
  assert.equal(safeFileExt('../x', '.jpg'), '.jpg');
});
