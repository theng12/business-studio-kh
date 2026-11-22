/**
 * crash.log is bounded (main/util/eventLog.js).
 *
 * Why: on this Mac the file reached 1.95 GB / 29 million lines, mostly one
 * unhandled-rejection stack written in a retry loop, and macOS reports that
 * to the owner as "System Data". These tests pin the two guards — rotation
 * at a size ceiling, and a repeated line collapsing to one written line plus
 * a count.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createEventLog, rotateIfLarge, MAX_BYTES } = require('../main/util/eventLog');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-eventlog-'));
  return { dir, file: path.join(dir, 'crash.log') };
}

test('a repeat is counted, not written again, and the count lands when the line changes', () => {
  const { dir, file } = tmp();
  const log = createEventLog({ filePath: file, fs });
  log.log('unhandledRejection', 'connect ECONNREFUSED');
  for (let i = 0; i < 5000; i++) log.log('unhandledRejection', 'connect ECONNREFUSED');
  log.log('before-quit');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split('\n').filter((l) => l.includes('unhandledRejection')).length, 1);
  assert.match(text, /repeated :: the line above appeared 5000 more times/);
  assert.match(text, /before-quit/);
  assert.ok(text.length < 1000, `storm kept small, got ${text.length} bytes`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('flush writes the pending count so a crash at quit loses nothing', () => {
  const { dir, file } = tmp();
  const log = createEventLog({ filePath: file, fs });
  log.log('boot', 'pid=1');
  log.log('boot', 'pid=1');
  log.flush();
  assert.match(fs.readFileSync(file, 'utf8'), /appeared 1 more time/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a different detail is not collapsed with the same event', () => {
  const { dir, file } = tmp();
  const log = createEventLog({ filePath: file, fs });
  log.log('db:error', 'locked');
  log.log('db:error', 'disk full');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split('\n').filter((l) => l.includes('db:error')).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotation keeps only a small tail, even when an old build left a huge file', () => {
  const { dir, file } = tmp();
  fs.writeFileSync(file, Buffer.alloc(MAX_BYTES + 1024, 0x41));
  assert.equal(rotateIfLarge(file, fs), true);
  assert.equal(fs.statSync(file).size, 0);
  assert.ok(fs.statSync(`${file}.1`).size <= 64 * 1024);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the logger rotates by itself past the ceiling and says so', () => {
  const { dir, file } = tmp();
  const log = createEventLog({ filePath: file, fs, maxBytes: 4000 });
  for (let i = 0; i < 600; i++) log.log('tick', `n=${i}`);
  assert.ok(fs.existsSync(`${file}.1`), 'previous tail kept');
  assert.ok(fs.statSync(file).size < 8000, `live log stays small, got ${fs.statSync(file).size}`);
  assert.match(fs.readFileSync(file, 'utf8'), /log:rotated/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the app wires the bounded logger and flushes on quit', () => {
  const src = fs.readFileSync(path.join(__dirname, '../main/index.js'), 'utf8');
  assert.match(src, /createEventLog\(\{[\s\S]{0,200}filePath: crashLogPath\(\)/);
  const quit = src.slice(src.indexOf("app.on('before-quit'"), src.indexOf("app.on('window-all-closed'"));
  assert.match(quit, /eventLog\.flush\(\)/, 'the quit handler flushes the log');
  assert.ok(quit.indexOf('eventLog.flush()') < quit.indexOf('app.quit()'), 'flushed before it quits');
  assert.doesNotMatch(src, /fs\.appendFileSync\(crashLogPath\(\)/, 'no unbounded append left behind');
});

test('the migration logger rotates before it appends, so it cannot outgrow the bound', () => {
  const src = fs.readFileSync(path.join(__dirname, '../main/db/index.js'), 'utf8');
  assert.match(
    src,
    /rotateIfLarge\(crashLog, fs\);\s*fs\.appendFileSync\(crashLog, line\)/,
    'main/db/index.js must rotate crash.log before its direct append',
  );
});

test('an oversized log left by an older build shrinks at the first new line', () => {
  const { dir, file } = tmp();
  fs.writeFileSync(file, Buffer.alloc(MAX_BYTES + 1024, 0x41));
  const log = createEventLog({ filePath: file, fs });
  log.log('boot', 'pid=1');
  assert.ok(fs.statSync(file).size < 4096, `live log small at once, got ${fs.statSync(file).size}`);
  assert.ok(fs.existsSync(`${file}.1`), 'the tail is kept');
  assert.ok(fs.statSync(`${file}.1`).size <= 64 * 1024);
  fs.rmSync(dir, { recursive: true, force: true });
});
