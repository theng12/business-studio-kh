/**
 * v0.1.25 — every sidebar entry must actually be routable.
 *
 * WHY THIS EXISTS. `setActiveModule` silently ignores any name that is not in
 * the MODULES allowlist in renderer/store/navigation.js: it logs a console
 * warning and returns, so the click does nothing at all. That is a nasty
 * failure — there is no error, no toast, and the page error boundary never
 * runs because the page is never even attempted. The user clicks a menu item
 * and simply stays where they were.
 *
 * This is not hypothetical. It has happened at least twice: the v0.10.0
 * "Overlay Studio doesn't open" bug (a missing MODULES entry) and again in
 * v0.1.25, when adding Social Grid produced a sidebar button that opened
 * Catalog Projects instead — the allowlist had not been updated, and the only
 * visible symptom was that the wrong page appeared.
 *
 * So the check is mechanical: read the ids out of the sidebar config, read the
 * allowlist, read the route table, and require all three to agree. A new page
 * that forgets one of the three now fails the suite instead of failing quietly
 * under someone's mouse.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 2026-10-08: the nav list lives in the module registry (the sidebar and the
// Home grid both render it), so the "sidebar entries" are its pages.
const SIDEBAR = path.join(ROOT, 'renderer', 'lib', 'modules.js');
const NAVIGATION = path.join(ROOT, 'renderer', 'store', 'navigation.js');
const APP = path.join(ROOT, 'renderer', 'App.jsx');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Page ids from the registry, e.g. `{ id: 'overlay', name: … }` — one line
 *  each, which is what tells a page from a module (whose `name` is on the next
 *  line). */
function sidebarIds() {
  const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
  return [...src.matchAll(/\{[ \t]*id:[ \t]*'([a-z0-9]+)'[ \t]*,[ \t]*name:/g)].map((m) => m[1]);
}

/** The MODULES allowlist in the navigation slice. */
function allowedModules() {
  const src = stripComments(fs.readFileSync(NAVIGATION, 'utf8'));
  const block = src.match(/const MODULES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'could not find the MODULES allowlist in renderer/store/navigation.js');
  return [...block[1].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
}

/** The keys of the PAGES route table in App.jsx. */
function routedModules() {
  const src = stripComments(fs.readFileSync(APP, 'utf8'));
  const block = src.match(/const PAGES\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not find the PAGES map in renderer/App.jsx');
  return [...block[1].matchAll(/^\s*([a-z0-9]+):/gm)].map((m) => m[1]);
}

test('the nav config was actually parsed', () => {
  // Guards the guard: if the shape of NAV changes and this regex stops
  // matching, every assertion below becomes vacuous and silently passes.
  const ids = sidebarIds();
  assert.ok(ids.length >= 15, `expected 15+ sidebar entries, parsed ${ids.length}`);
  assert.ok(ids.includes('dashboard'));
  assert.ok(ids.includes('settings'));
  assert.ok(allowedModules().length >= 15, 'MODULES allowlist looks truncated');
  assert.ok(routedModules().length >= 15, 'PAGES route table looks truncated');
});

test('every sidebar entry is in the MODULES allowlist', () => {
  const allowed = new Set(allowedModules());
  const missing = sidebarIds().filter((id) => !allowed.has(id));
  assert.deepEqual(
    missing,
    [],
    'These sidebar entries are missing from MODULES in renderer/store/navigation.js.\n'
    + 'setActiveModule() IGNORES an unknown name silently, so clicking the entry does\n'
    + 'nothing at all (or leaves the previous page on screen):\n  ' + missing.join('\n  '),
  );
});

test('every sidebar entry has a page in the PAGES route table', () => {
  const routed = new Set(routedModules());
  const missing = sidebarIds().filter((id) => !routed.has(id));
  assert.deepEqual(
    missing,
    [],
    'These sidebar entries are routable in the store but App.jsx has no page for\n'
    + 'them, so they would render as the Dashboard fallback:\n  ' + missing.join('\n  '),
  );
});

test('every routed module is reachable from the allowlist', () => {
  // The reverse direction: a page that exists but can never be navigated to is
  // dead code, which is how the Overlay Studio bug hid for so long.
  const allowed = new Set(allowedModules());
  const orphans = routedModules().filter((id) => !allowed.has(id));
  assert.deepEqual(
    orphans,
    [],
    'These entries exist in the PAGES map but are not in the MODULES allowlist,\n'
    + 'so nothing can ever navigate to them:\n  ' + orphans.join('\n  '),
  );
});

test('Social Grid is wired end to end', () => {
  // Pins the v0.1.25 regression specifically, so a future refactor that drops
  // one of the three links fails with an obvious message.
  assert.ok(sidebarIds().includes('socialgrid'), 'no Social Grid entry in the sidebar');
  assert.ok(allowedModules().includes('socialgrid'), 'socialgrid missing from MODULES');
  assert.ok(routedModules().includes('socialgrid'), 'socialgrid missing from PAGES');
});
