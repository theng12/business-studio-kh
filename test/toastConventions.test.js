/**
 * KH UI conventions for toasts: success 5–8 s, errors stay until read or
 * dismissed, at most three on screen at once (kh-shared-ui/design-tokens.json).
 * The slice is created with a fake `set` and a captured `setTimeout`, so no
 * real timer runs and no fake-timer API is needed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createToastsSlice } = require('../renderer/store/toasts.js');

function slice() {
  let state = { toasts: [] };
  const set = (update) => {
    const next = typeof update === 'function' ? update(state) : update;
    state = { ...state, ...next };
  };
  return { api: { ...createToastsSlice(set, () => state) }, state: () => state };
}

function delaysFor(add) {
  const delays = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (_fn, ms) => { delays.push(ms); return 0; };
  try { add(); } finally { globalThis.setTimeout = real; }
  return delays;
}

test('a success stays 6 s, an info 3 s, an action 6 s, and an error has no timer', () => {
  const { api } = slice();
  assert.deepEqual(delaysFor(() => api.addToast('saved', 'success')), [6000]);
  assert.deepEqual(delaysFor(() => api.addToast('noted', 'info')), [3000]);
  assert.deepEqual(delaysFor(() => api.addToast('noted', 'info', { action: { label: 'Undo', onClick() {} } })), [6000]);
  assert.deepEqual(delaysFor(() => api.addToast('failed', 'error')), [], 'errors wait until read or dismissed');
  assert.deepEqual(delaysFor(() => api.addToast('failed', 'error', { action: { label: 'Retry', onClick() {} } })), []);
});

test('at most three toasts stay on screen; the oldest is dropped', () => {
  const { api, state } = slice();
  for (let i = 1; i <= 4; i += 1) delaysFor(() => api.addToast(`error ${i}`, 'error'));
  assert.deepEqual(state().toasts.map((t) => t.message), ['error 2', 'error 3', 'error 4']);
});
