/**
 * A progress row that main marks `cancellable` must be stoppable from the UI.
 *
 * Why: the export runner has taken a cancel since 0.1.89 — `exports:cancel`
 * sets the run's flag and the loop stops between images — but no renderer
 * component ever called it. The person saw "Running export" with no control,
 * which is the owner's "row with no terminal escape" bug (2026-11-15).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const src = read('renderer/components/ProgressOverlay.jsx');

test('a cancellable row offers Stop and calls the runner\'s cancel with its own id', () => {
  assert.match(src, /op\.cancellable \?/);
  assert.match(src, /window\.api\.exports\.cancel\(id\)/);
  assert.match(src, /aria-label="Stop this export"/);
});

test('the export run id the overlay holds is the id cancel expects', () => {
  const ipc = read('main/ipc/exports.js');
  assert.match(ipc, /broadcast\('progress:event', \{ id: opId, kind: 'export-run',[\s\S]{0,160}cancellable: true/);
  assert.match(ipc, /const run = activeRuns\.get\(opId\)/);
});

test('a run that already ended says so instead of looking ignored', () => {
  assert.match(src, /That export has already finished\./);
});

test('the overlay still renders nothing when there is no work', () => {
  assert.match(src, /if \(ids\.length === 0\) return null;/);
});
