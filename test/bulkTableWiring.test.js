/**
 * v0.1.66: the bulk edit table must stay REACHABLE and stay honest.
 *
 * Slice 1 shipped the paste rules as a pure module with its own unit tests. That
 * proves the arithmetic, not the feature: the table still has to be opened from
 * the Library, still has to reuse the planner, still has to gate image pastes on
 * the Image cell, still has to dry-run before it writes, and must not invent a
 * new IPC channel to do any of it. Those are exactly the wiring failures a unit
 * suite cannot see, so this file scans the real sources.
 *
 * It also pins the two release edits together: the version in package.json /
 * package-lock.json and the top entry in the "What's new" array have to agree,
 * because a bump without a changelog leaves the modal pointing at the previous
 * release.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const LIBRARY = read('renderer/modules/ProductLibrary/index.jsx');
const MODAL = read('renderer/modules/ProductLibrary/BulkTableModal.jsx');
const PLANNER = read('renderer/modules/ProductLibrary/bulkGridPaste.js');
const PRELOAD = read('main/preload.js');
const WHATS_NEW = read('renderer/components/WhatsNewModal.jsx');
const CRAWL = read('scripts/probe-ui-crawl.js');
const PKG = JSON.parse(read('package.json'));
const LOCK = JSON.parse(read('package-lock.json'));

const VERSION = '0.1.66';

test('the Library offers Edit in table from the bulk Image operations menu', () => {
  assert.match(LIBRARY, /import \{ BulkTableModal \} from '\.\/BulkTableModal\.jsx'/,
    'the Library does not import the bulk table modal');
  assert.match(LIBRARY, /<BulkTableModal/, 'the Library never renders the bulk table modal');
  assert.match(LIBRARY, /label: 'Edit in table'/, 'there is no "Edit in table" item in the bulk menu');
  assert.match(LIBRARY, /productIds=\{Array\.from\(selectedIds\)\}/,
    'the modal is not given the ticked products');
  assert.match(LIBRARY, /filters=\{filters\}/, 'the modal is not given the Library filters');
});

test('the table reuses the slice-1 paste planner instead of rewriting it', () => {
  assert.match(MODAL, /from '\.\/bulkGridPaste\.js'/, 'the modal does not import the paste planner');
  assert.match(MODAL, /planPaste\(/, 'the modal never calls planPaste()');
  assert.match(MODAL, /GRID_MAX_ROWS/, 'the 200-row cap constant is not reused');
  assert.match(PLANNER, /export function planPaste/, 'the planner lost planPaste()');
  assert.match(PLANNER, /export const GRID_MAX_ROWS = 200/, 'the planner cap changed');
});

test('an image paste is gated on the dedicated Image cell', () => {
  // The cell exists, is focusable, and is the only place an image is accepted.
  assert.match(MODAL, /data-col="image"/, 'the Image cell carries no data-col marker');
  assert.match(MODAL, /tabIndex=\{0\}/, 'the Image cell cannot take focus');
  assert.match(MODAL, /f\.key !== 'image'/, 'the paste handler does not check that the Image cell is focused');
  assert.match(MODAL, /startsWith\('image\/'\)/, 'the paste handler does not look for clipboard images');
});

test('both image modes are non-destructive — importFromBytes, then setMainImage for Make main', () => {
  assert.match(MODAL, /window\.api\.images\.importFromBytes\(/,
    'the table never imports pasted bytes');
  assert.match(MODAL, /window\.api\.images\.setMainImage\(/,
    'Make main never promotes the pasted photo');
  assert.match(MODAL, /mode === 'main'/, 'setMainImage is not gated on the Make main mode');
  assert.match(MODAL, /setImageMode\('add'\)/, 'the Add mode control is missing');
  assert.match(MODAL, /setImageMode\('main'\)/, 'the Make main mode control is missing');
  assert.match(MODAL, /e\.shiftKey \? 'main' : 'add'/,
    'the ⌘V / ⇧⌘V shortcut does not choose the paste mode');
  // There is deliberately no destructive replace/overwrite mode.
  assert.doesNotMatch(MODAL, /Replace (the )?(main )?image/i,
    'a destructive replace-image mode crept back in — the owner ruled it out');
});

test('Save all dry-runs through bulkUpsert before the live write', () => {
  const dry = MODAL.indexOf('dryRun: true');
  const live = MODAL.indexOf('dryRun: false');
  assert.ok(dry > -1, 'the modal never asks bulkUpsert for a dry run');
  assert.ok(live > -1, 'the modal never commits through bulkUpsert');
  assert.ok(dry < live, 'the live save is reachable before the dry run');
  const calls = MODAL.match(/window\.api\.products\.bulkUpsert\(/g) || [];
  assert.equal(calls.length, 2, `expected exactly two bulkUpsert calls (dry + live), found ${calls.length}`);
  const overwrite = MODAL.match(/conflictPolicy: 'overwrite'/g) || [];
  assert.equal(overwrite.length, 2, 'both the dry run and the commit must use conflictPolicy overwrite');
  assert.match(MODAL, /Save all/, 'there is no explicit Save all button');
  assert.match(MODAL, /Confirm save/, 'the dry-run summary has no confirmation step');
});

test('a duplicate SKU refuses the whole save and names the row', () => {
  assert.match(MODAL, /row \$\{/, 'the refusal message never names a row');
  assert.match(MODAL, /already used by another product/,
    'a SKU collision is not detected as a collision (bulkUpsert is SKU-keyed, so it would silently write the wrong product)');
  assert.match(MODAL, /kind: 'refuse'/, 'there is no refusal state');
  assert.match(MODAL, /You have \{dirty\} unsaved cell edit/,
    'closing with unsaved edits does not warn');
  assert.match(MODAL, /⌘Z|'z'/, 'the grid has no ⌘Z undo binding');
});

test('the table invents no new IPC channel', () => {
  const used = [...MODAL.matchAll(/window\.api\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  const unique = [...new Set(used)].sort();
  assert.deepEqual(unique, [
    'images.importFromBytes',
    'images.setMainImage',
    'products.bulkUpsert',
    'products.update',
  ], `unexpected window.api surface used: ${JSON.stringify(unique)}`);
  for (const call of unique) {
    const method = call.split('.')[1];
    assert.match(PRELOAD, new RegExp(`${method}:`), `window.api.${call} is not exposed by preload`);
  }
  assert.doesNotMatch(MODAL, /ipcRenderer|ipcMain|require\(/,
    'the renderer reached for main-process plumbing instead of window.api');
});

test('the UI crawl exercises the bulk table and stays non-fatal', () => {
  assert.match(CRAWL, /async function deepBulkTableFlow\(/, 'the crawl has no bulk-table leg');
  assert.match(CRAWL, /await deepBulkTableFlow\(crawl, photoPath\)/, 'the bulk-table leg is never called');
  assert.match(CRAWL, /crawl\.step\('deep bulk table flow', false/, 'the leg has no non-fatal catch');
  assert.match(CRAWL, /ClipboardEvent\('paste'/, 'the crawl does not dispatch a real paste event');
});

test('the version and the top What’s new entry agree', () => {
  assert.equal(PKG.version, VERSION, `package.json is ${PKG.version}, expected ${VERSION}`);
  assert.equal(LOCK.version, VERSION, `package-lock.json is ${LOCK.version}, expected ${VERSION}`);
  assert.equal(LOCK.packages?.['']?.version, VERSION, 'package-lock.json packages[""] disagrees');
  assert.match(WHATS_NEW, new RegExp(`const CHANGELOG = \\[\\s*\\{\\s*version: '${VERSION.replace(/\./g, '\\.')}'`),
    `the top What's new entry is not ${VERSION}`);

  // The top entry's bullets are plain text, and it describes the table.
  const start = WHATS_NEW.indexOf(`version: '${VERSION}'`);
  const rest = WHATS_NEW.slice(start + 1);
  const entry = WHATS_NEW.slice(start, start + 1 + rest.indexOf("version: '"));
  assert.match(entry, /bulk (edit )?table|Edit in table/i, 'the changelog entry does not mention the feature');
  assert.doesNotMatch(entry, /\*\*|\[[^\]]+\]\(/, 'changelog bullets render as plain text — no markdown');
});
