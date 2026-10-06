const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/modules/AIStudio/index.jsx'), 'utf8');
function display(t) {
  const logic = source.slice(source.indexOf('const isStuckDone ='), source.indexOf('return (', source.indexOf('const isStuckDone =')));
  const tones = { done: { tone: 'emerald', label: 'Done' }, failed: { tone: 'rose', label: 'Failed' }, cancelled: { tone: 'slate', label: 'Cancelled' }, running: { tone: 'amber', label: 'Running' }, queued: { tone: 'slate', label: 'Queued' } };
  return vm.runInNewContext(`(() => { ${logic}; return { needsRecovery, status, errorOrPrompt }; })()`, { t, Date, STATUS_TONE: tones });
}

test('completed partial/follow-on failures remain visibly warned in queue rows', () => {
  const d = display({ status: 'done', galleryCount: 1, errorMessage: '1 of 2 images saved. ENOSPC' });
  assert.equal(d.errorOrPrompt, '1 of 2 images saved. ENOSPC'); assert.equal(d.status.tone, 'amber'); assert.match(d.status.label, /warning/i);
});

test('long-running requests never gain Repair controls', () => {
  const d = display({ status: 'running', galleryCount: 0, startedAt: Date.now() - 600000 });
  assert.equal(d.needsRecovery, false); assert.equal(d.status.label, 'Running');
});

test('legacy Done-without-images explains a new paid generation without pretending recovery', () => {
  const d = display({ status: 'done', galleryCount: 0 });
  assert.equal(d.needsRecovery, false); assert.match(d.errorOrPrompt, /new paid generation/i); assert.doesNotMatch(d.errorOrPrompt, /re-fetch/);
});
