/**
 * UI pass, 2026-10 — shared primitives (docs/UI_GUIDE.md).
 *
 * Pins the five things the UI audit found and this pass fixed in the shared
 * layer, so a later page package can't quietly undo them:
 *
 *   1. Button / Input / Textarea / Select MERGE a caller's className with
 *      their base classes (they used to drop `btn btn--primary` / `input`).
 *   2. Page-header actions hug the right edge (`.page__header-right`).
 *   3. `.btn` centres its label and never wraps it.
 *   4. SaveStatus has a real error state (it used to say "All changes saved").
 *   5. renderer/lib/format.js — the one timeAgo / formatDate / formatDateTime.
 *
 * Components are rendered for real with react-dom/server (bundled through
 * esbuild, like test/productImportPreview.test.js); the CSS is checked
 * statically because `node --test` cannot lay out a page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('renderer/index.css');

function load(rel) {
  const esbuild = require('esbuild');
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', 'zustand'],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  const req = createRequire(path.join(ROOT, 'package.json'));
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(req, mod, mod.exports);
  return mod.exports;
}

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const classOf = (markup) => (markup.match(/class="([^"]*)"/) || [])[1] || '';

const UI = load('renderer/components/ui.jsx');
const SS = load('renderer/components/SaveStatus.jsx');
const F = load('renderer/lib/format.js');

/** Body of the first top-level rule whose selector list is exactly `sel`. */
function ruleBody(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `CSS rule ${sel} exists`);
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
}

// ── 1. className merge ────────────────────────────────────────────────

test('Button keeps btn + variant classes when a caller passes className', () => {
  const cls = classOf(html(h(UI.Button, { variant: 'primary', className: 'support-card__cta' }, 'Go')));
  assert.deepEqual(cls.split(' '), ['btn', 'btn--primary', 'support-card__cta']);
});

test('Button without className is unchanged; size/block add helpers', () => {
  assert.equal(classOf(html(h(UI.Button, null, 'x'))), 'btn');
  assert.equal(classOf(html(h(UI.Button, { variant: 'danger', size: 'sm', block: true }, 'x'))), 'btn btn--danger btn--sm btn--block');
  // `size` / `block` are consumed, not leaked onto the DOM.
  const markup = html(h(UI.Button, { size: 'sm', block: true }, 'x'));
  assert.doesNotMatch(markup, /\bsize=|\bblock=/);
});

test('Button does not force a type (forms that rely on submit keep working)', () => {
  assert.doesNotMatch(html(h(UI.Button, null, 'x')), /type=/);
  assert.match(html(h(UI.Button, { type: 'submit' }, 'x')), /type="submit"/);
});

test('Input / Textarea / Select merge className with their base classes', () => {
  assert.equal(classOf(html(h(UI.Input, { className: 'x', invalid: true }))), 'input is-invalid x');
  assert.equal(classOf(html(h(UI.Textarea, { className: 'x' }))), 'input input--textarea x');
  assert.equal(classOf(html(h(UI.Select, { className: 'list-tools__sort' }, h('option', null, 'a')))), 'input input--select list-tools__sort');
  assert.equal(classOf(html(h(UI.Input, null))), 'input');
});

test('merged Selects that must stay inline are pinned to width:auto', () => {
  assert.match(CSS, /\.input\.list-tools__sort,\s*\n?\s*\.input\.lib-csv-select\s*\{\s*width:\s*auto/);
});

// ── 2. page header ────────────────────────────────────────────────────

test('.page__header-right packs actions to the right instead of growing mid-page', () => {
  const body = ruleBody('.page__header-right');
  assert.match(body, /justify-content:\s*flex-end/);
  assert.match(body, /flex:\s*0 1 auto/, 'must not grow into the free space');
  assert.match(body, /min-width:\s*0/, 'must be allowed to shrink so its buttons wrap');
  assert.match(ruleBody('.page__header-actions'), /flex-wrap:\s*wrap/);
  assert.match(ruleBody('.page__header-actions'), /justify-content:\s*flex-end/);
  assert.match(ruleBody('.page__back'), /white-space:\s*nowrap/);
});

test('PageHeader: backTo supports onClick, and no empty right block without actions', () => {
  const src = read('renderer/components/PageHeader.jsx');
  assert.match(src, /backTo\?\.onClick/);
  assert.match(src, /\{actions \? \(\s*<div className="page__header-right">/);
});

// ── 3. buttons ────────────────────────────────────────────────────────

test('.btn centres and never wraps its label; sm and block helpers exist', () => {
  const body = ruleBody('.btn');
  assert.match(body, /justify-content:\s*center/);
  assert.match(body, /white-space:\s*nowrap/);
  assert.match(ruleBody('.btn--sm'), /padding:/);
  assert.match(ruleBody('.btn--block'), /width:\s*100%/);
});

// ── 4. SaveStatus ─────────────────────────────────────────────────────

test('SaveStatus exports the four states and an error label', () => {
  assert.deepEqual([...SS.SAVE_STATES], ['saved', 'saving', 'dirty', 'error']);
  assert.equal(SS.saveStatusLabel('error'), 'Couldn’t save — retry');
  assert.equal(SS.saveStatusLabel('error', { canRetry: false }), 'Couldn’t save');
  assert.equal(SS.saveStatusLabel('saving'), 'Saving…');
  assert.equal(SS.saveStatusLabel('dirty'), 'Unsaved changes');
  assert.equal(SS.saveStatusLabel('saved'), 'All changes saved');
});

test('SaveStatus error state is rose and clickable (retry) — never "All changes saved"', () => {
  const markup = html(h(SS.SaveStatus, { state: 'error', onSave: () => {}, error: 'Disk full' }));
  assert.match(markup, /<button[^>]*class="save-status save-status--error"/);
  assert.match(markup, /Couldn’t save — retry/);
  assert.match(markup, /title="Disk full/);
  assert.doesNotMatch(markup, /All changes saved/);
  // Without a retry handler it is plain text, not a dead button.
  const plain = html(h(SS.SaveStatus, { state: 'error' }));
  assert.doesNotMatch(plain, /<button/);
  assert.match(CSS, /\.save-status\.save-status--error\s*\{[^}]*var\(--c-rose\)/);
});

test('SaveStatus keeps its original API and accepts the {state,lastSavedAt} shape', () => {
  const now = Date.now();
  const saved = html(h(SS.SaveStatus, { state: 'saved', savedAt: now, onSave: () => {} }));
  assert.match(saved, /save-status--saved/);
  assert.match(saved, /All changes saved/);
  assert.match(saved, /just now/);
  assert.match(saved, />Save<\/button>/);
  const saving = html(h(SS.SaveStatus, { state: 'saving', onSave: () => {} }));
  assert.match(saving, /save-status--saving/);
  assert.match(saving, /disabled=""/);
  assert.match(html(h(SS.SaveStatus, { state: 'dirty' })), /Unsaved changes/);
  // Image Workspace / Overlay Studio shape.
  assert.match(html(h(SS.SaveStatus, { status: { state: 'idle', lastSavedAt: now } })), /All changes saved/);
  assert.doesNotMatch(html(h(SS.SaveStatus, { status: { state: 'idle', lastSavedAt: null } })), /save-status--/);
  assert.match(html(h(SS.SaveStatus, { status: { state: 'error', lastSavedAt: null } })), /save-status--error/);
});

// ── EmptyState ────────────────────────────────────────────────────────

test('EmptyState spans a grid and supports a secondary action', () => {
  const markup = html(h(UI.EmptyState, {
    title: 'No brands yet', body: 'Create your first one.',
    action: h('button', null, 'New brand'), secondaryAction: h('button', null, 'Import'),
  }));
  assert.match(markup, /class="empty__actions"><button>New brand<\/button><button>Import<\/button>/);
  assert.doesNotMatch(html(h(UI.EmptyState, { title: 'x' })), /empty__actions/);
  assert.match(CSS, /\.empty\s*\{\s*width:\s*100%;\s*grid-column:\s*1 \/ -1;/);
});

// ── tokens + shared classes ───────────────────────────────────────────

test('single token system: brand, radius and type scale are defined', () => {
  for (const t of ['--c-brand:', '--c-brand-soft:', '--radius-sm:', '--radius-md:', '--radius-lg:', '--radius-xl:',
    '--fs-xs: 11px', '--fs-sm: 12px', '--fs-md: 13px', '--fs-lg: 15px', '--fs-xl: 22px']) {
    assert.ok(CSS.includes(t), `token ${t}`);
  }
  for (const sel of ['.data-table', '.card', '.card__body', '.card__actions', '.section-title', '.toolbar']) {
    assert.ok(ruleBody(sel), `shared class ${sel}`);
  }
  assert.doesNotMatch(ruleBody('.section-title'), /uppercase/, 'section titles are sentence case');
});

// ── 5. format.js ──────────────────────────────────────────────────────

test('timeAgo: just now → min → h → yesterday → date', () => {
  const now = new Date(2026, 9, 2, 15, 0, 0).getTime(); // 2 Oct 2026, 15:00 local
  assert.equal(F.timeAgo(now, now), 'just now');
  assert.equal(F.timeAgo(now - 59_000, now), 'just now');
  assert.equal(F.timeAgo(now + 120_000, now), 'just now', 'clock skew is not "in 2 min"');
  assert.equal(F.timeAgo(now - 5 * 60_000, now), '5 min ago');
  assert.equal(F.timeAgo(now - 2 * 3_600_000, now), '2 h ago');
  assert.equal(F.timeAgo(new Date(2026, 9, 1, 9, 0).getTime(), now), 'yesterday');
  const older = new Date(2026, 8, 20, 12, 0).getTime();
  assert.equal(F.timeAgo(older, now), F.formatDate(older));
  assert.equal(F.timeAgo(null, now), '');
  assert.equal(F.timeAgo('garbage', now), '');
  assert.equal(F.timeAgo(new Date(now - 5 * 60_000), now), '5 min ago');
  assert.equal(F.timeAgo(String(now - 5 * 60_000), now), '5 min ago');
});

test('formatDate / formatDateTime: one locale style, never throw', () => {
  const ts = new Date(2026, 9, 2, 14, 5).getTime();
  assert.equal(F.formatDate(ts), new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
  assert.match(F.formatDate(ts), /2026/);
  assert.match(F.formatDateTime(ts), /2026/);
  assert.match(F.formatDateTime(ts), /05/);
  assert.equal(F.formatDate(new Date(ts).toISOString()), F.formatDate(ts));
  for (const bad of [null, undefined, '', 'nope', NaN]) {
    assert.equal(F.formatDate(bad), '—');
    assert.equal(F.formatDateTime(bad), '—');
  }
});
