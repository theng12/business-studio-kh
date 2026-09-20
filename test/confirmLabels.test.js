/**
 * v0.1.20: what the two buttons in a confirmation dialog say.
 *
 * The "no" button used to be labelled "Cancel" everywhere. On a destructive
 * confirm that word is ambiguous — cancel the dialog, or cancel the action that
 * is already running? — and sitting next to a red "Delete" it does not read as
 * the safe choice. It now says "Keep" whenever the dialog is destructive, and
 * stays "Cancel" for the ordinary informational confirms where there is nothing
 * to keep.
 *
 * The rule lives in ONE place (ConfirmModal) so the component and the imperative
 * `confirm()` helper cannot drift: the helper used to hard-code 'Cancel', which
 * would have quietly overridden the component's decision.
 *
 * No DOM: `react-dom/server` renders the component straight to a string. The
 * imperative `confirm()` helper mounts its own root and cannot be exercised
 * here, so its half is pinned by reading the source instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

async function loadConfirmModal() {
  const esbuild = require('esbuild');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(ROOT, 'package.json'));

  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, 'renderer/components/ConfirmModal.jsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', 'zustand'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(req, mod, mod.exports);
  return mod.exports;
}

/** Button labels of the rendered dialog, in order. */
function buttonLabels(html) {
  return [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim()).filter(Boolean);
}

function render(props) {
  const React = require('react');
  const { renderToString } = require('react-dom/server');
  return renderToString(React.createElement(props.Component, props));
}

test('confirm labels — a destructive dialog offers "Keep", not "Cancel"', async () => {
  const { ConfirmModal } = await loadConfirmModal();
  const html = render({
    Component: ConfirmModal,
    open: true,
    danger: true,
    title: 'Delete 2 products?',
    confirmLabel: 'Delete 2',
    onCancel: () => {},
    onConfirm: () => {},
  });
  const labels = buttonLabels(html);
  assert.ok(labels.includes('Keep'), `expected a "Keep" button, saw ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes('Cancel'), `destructive dialog must not say "Cancel": ${JSON.stringify(labels)}`);
  assert.ok(labels.includes('Delete 2'), 'the destructive action keeps its own label');
});

test('confirm labels — a non-destructive dialog still says "Cancel"', async () => {
  const { ConfirmModal } = await loadConfirmModal();
  const html = render({
    Component: ConfirmModal,
    open: true,
    danger: false,
    title: 'Save changes?',
    onCancel: () => {},
    onConfirm: () => {},
  });
  const labels = buttonLabels(html);
  assert.ok(labels.includes('Cancel'), `expected "Cancel", saw ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes('Keep'), 'nothing is being kept here, so "Keep" would be odd');
});

test('confirm labels — an explicit label always wins', async () => {
  // Settings has one deliberate override ("Keep for now") on a dialog that is
  // not flagged destructive. The rule must not stomp on it.
  const { ConfirmModal } = await loadConfirmModal();
  const html = render({
    Component: ConfirmModal,
    open: true,
    danger: false,
    cancelLabel: 'Keep for now',
    title: 'Move old data folder to Trash?',
    onCancel: () => {},
    onConfirm: () => {},
  });
  const labels = buttonLabels(html);
  assert.ok(labels.includes('Keep for now'), `explicit label lost: ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes('Cancel'), 'the explicit label should replace the default');
});

test('confirm labels — the imperative helper does not override the rule', () => {
  // `confirm({ danger: true })` must reach ConfirmModal with NO cancelLabel, so
  // the component's own rule applies. The helper previously hard-coded 'Cancel',
  // which would have defeated the whole change on every one of the 24 call sites.
  const src = fs.readFileSync(path.join(ROOT, 'renderer/components/ConfirmModal.jsx'), 'utf8');
  assert.match(src, /cancelLabel=\{opts\.cancelLabel\}/, 'the helper should forward the caller\'s label verbatim');
  assert.doesNotMatch(src, /cancelLabel=\{opts\.cancelLabel \?\? ['"]Cancel['"]\}/, 'the helper must not hard-code "Cancel"');
  assert.match(src, /const cancelText = cancelLabel \?\? \(danger \? 'Keep' : 'Cancel'\)/, 'the single label rule is missing');
});
