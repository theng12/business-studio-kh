const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJournal } = require('../main/exportJournal');

test('unfinished exports retain their ID, destination and start time after restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createJournal(dir, () => false);
  const before = Date.now();
  first.start('run-123', '/isolated/output');
  assert.deepEqual(first.inFlightIds(), ['run-123']);
  const restarted = createJournal(dir, () => false);
  const [row] = restarted.list();
  assert.equal(row.id, 'run-123');
  assert.equal(row.target, '/isolated/output');
  assert.equal(row.status, 'interrupted');
  assert.ok(row.startedAt >= before && row.startedAt <= Date.now());
  assert.deepEqual(restarted.inFlightIds(), []);
  assert.equal(fs.statSync(path.join(dir, 'export-recovery.json')).mode & 0o777, 0o600);
});

test('a hold refuses an export and failed records remain visible', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let paused = true;
  const journal = createJournal(dir, () => paused);
  assert.throws(() => journal.start('paused', '/output'), /update.*paused/);
  paused = false;
  journal.start('failed', '/output');
  journal.finish('failed', 'disk full');
  assert.deepEqual(journal.inFlightIds(), []);
  assert.equal(journal.list()[0].error, 'disk full');
});

test('recovery history keeps the newest 50 settled exports', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = createJournal(dir, () => false);
  for (let i = 0; i < 55; i += 1) {
    journal.start(`failed-${i}`, '/output');
    journal.finish(`failed-${i}`, 'disk full');
  }
  const rows = journal.list();
  assert.equal(rows.length, 50);
  assert.equal(rows[0].id, 'failed-5');
  assert.equal(rows.at(-1).id, 'failed-54');
});
