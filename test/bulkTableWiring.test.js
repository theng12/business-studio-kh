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
// v0.1.71: the save-row builder (SKU/Unassigned/numeric rules) moved to a pure
// module so the "hidden SKU still saves" rule could be unit-tested. The static
// assertions below follow it there rather than weakening.
const ROWS = read('renderer/modules/ProductLibrary/bulkTableRows.js');
const UI = read('renderer/components/ui.jsx');
const PLANNER = read('renderer/modules/ProductLibrary/bulkGridPaste.js');
const CSS = read('renderer/index.css');
const PRELOAD = read('main/preload.js');
const WHATS_NEW = read('renderer/components/WhatsNewModal.jsx');
const CRAWL = read('scripts/probe-ui-crawl.js');
const PKG = JSON.parse(read('package.json'));
const LOCK = JSON.parse(read('package-lock.json'));

// v0.1.67: the bulk table shipped in 0.1.66. Its changelog entry is no longer
// the TOP one, so this test checks the entry by its own version rather than
// pinning a literal that every later release would have to edit.
const BULK_TABLE_VERSION = '0.1.66';

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

test('brand and category cells offer an explicit Unassigned that clears the field', () => {
  // Both selects need it: "fix the unassigned ones in bulk" is a reason the
  // owner asked for this table, and an unassigned product is a real state.
  const unassigned = MODAL.match(/label: '— Unassigned —'/g) || [];
  assert.ok(unassigned.length >= 2,
    `both the Brand and Category selects need the clearing option (found ${unassigned.length})`);
  // An emptied select must send null, not '', or overwrite would store a blank
  // string instead of clearing the column.
  assert.match(ROWS, /case 'brandId':\s*\n\s*case 'categoryId':\s*\n\s*out\[key\] = value \|\| null;/,
    'an emptied brand/category cell must send null so overwrite clears the field');
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
  // v0.1.68: the confirm button names the action AND how many products, so the
  // user is not asked to confirm an unnamed "are you sure".
  assert.match(MODAL, /`Save \$\{confirm\.count \?\? 0\} product/,
    'the dry-run summary confirm button must name the product count it will save');
  assert.match(MODAL, /count: saveRows\.length/, 'the dry-run summary does not carry the product count');
  // A changed SKU is a rename, and bulkUpsert is SKU-keyed (match or insert
  // only), so the rename must go through products:update — with the preload
  // shape products.update(id, patch), not a single object.
  assert.match(MODAL, /products\.update\(m\.id, \{ sku: m\.sku \}\)/,
    'SKU renames must call window.api.products.update(id, patch)');
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
    // v0.1.71: the saved column sets. Four channels, all registered/validated/
    // proxied per test/bulkColumnsWiring.test.js.
    'bulkColumns.create',
    'bulkColumns.list',
    'bulkColumns.remove',
    'bulkColumns.update',
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
  // v0.1.68: the crawl grew real assertions for the three grid fixes.
  assert.match(CRAWL, /data-col-resize="name"/, 'the crawl does not drag a header resize strip');
  assert.match(CRAWL, /textarea\[data-row="0"\]\[data-col="name"\]/, 'the crawl does not exercise the wrapping Name cell');
  assert.match(CRAWL, /unsaved cell edit/i, 'the crawl does not assert the one-prompt rule');
});

/* ── v0.1.68: column resize ──────────────────────────────────────────── */

test('every column header carries a resize strip that can drag and auto-fit', () => {
  // A live DOM affordance, not just CSS.
  assert.match(MODAL, /className="bulk-table__resizer"/, 'no resize strip element is rendered');
  assert.match(MODAL, /onMouseDown=\{\(e\) => beginResize\(e, c\)\}/, 'the strip does not start a resize drag');
  assert.match(MODAL, /onDoubleClick=\{\(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); autoFitColumn\(c\); \}\}/,
    'double-clicking the strip does not auto-fit the column');
  assert.match(MODAL, /window\.addEventListener\('mousemove', onMove\)/, 'the drag does not track the pointer');
  assert.match(MODAL, /window\.removeEventListener\('mouseup', onUp\)/, 'the drag never ends');
  // The columns are laid out with explicit <col> widths, or a width would be
  // re-flowed by the content and the drag would do nothing.
  assert.match(MODAL, /<colgroup>/, 'the table has no colgroup');
  assert.match(MODAL, /data-col=\{c\.key\} style=\{\{ width: `\$\{widthOf\(c\)\}px` \}\}/,
    'columns do not carry explicit px widths');
  assert.match(MODAL, /tableLayout: 'fixed'/, 'the table is not fixed-layout, so widths are not respected');
  assert.match(CSS, /\.bulk-table__resizer \{[\s\S]*?cursor: col-resize;/,
    'the resize strip has no col-resize cursor');
});

test('a column has a floor, and auto-fit measures the rendered values', () => {
  assert.match(MODAL, /min: 90/, 'there is no ~90px floor for text columns');
  assert.match(MODAL, /number: \{ width: 100, min: 70/, 'number columns have no ~70px floor');
  assert.match(MODAL, /Math\.max\(rule\.min/, 'a width is not clamped to its floor');
  assert.match(MODAL, /Math\.min\(rule\.max/, 'a width is not clamped to its ceiling');
  assert.match(MODAL, /function autoFitColumn\(col\)/, 'there is no auto-fit routine');
  assert.match(MODAL, /ctx\.measureText/, 'auto-fit does not measure the rendered text');
  assert.match(MODAL, /el\.value/, 'auto-fit does not read the rendered cell values');
});

test('widths are remembered in one localStorage key and can be reset', () => {
  assert.match(MODAL, /const COLUMN_WIDTHS_STORAGE_KEY = 'BulkTable\.columnWidths'/,
    'the remembered widths do not use the BulkTable.columnWidths key');
  assert.match(MODAL, /function loadColumnWidths\(\)[\s\S]*?localStorage\.getItem\(COLUMN_WIDTHS_STORAGE_KEY\)/,
    'widths are never loaded back');
  assert.match(MODAL, /function saveColumnWidths\(map\)[\s\S]*?localStorage\.setItem\(COLUMN_WIDTHS_STORAGE_KEY/,
    'widths are never persisted');
  assert.match(MODAL, /useState\(loadColumnWidths\)/, 'the modal does not initialise its widths from storage');
  assert.match(MODAL, /Reset columns/, 'there is no Reset columns action');
  assert.match(MODAL, /localStorage\.removeItem\(COLUMN_WIDTHS_STORAGE_KEY\)/,
    'Reset columns does not clear the stored map');
});

/* ── v0.1.68: long text wraps ────────────────────────────────────────── */

test('long free-text columns render a growing textarea, not a clipped input', () => {
  // The columns the customer could not read.
  assert.match(MODAL, /\{ key: 'name', label: 'Name', type: 'text', long: true \}/, 'Name is not a long-text column');
  assert.match(MODAL, /\{ key: 'description', label: 'Description', type: 'text', long: true \}/,
    'Description is not a long-text column');
  assert.match(MODAL, /\{ key: 'tags', label: 'Tags \(comma-separated\)', type: 'text', long: true \}/,
    'Tags is not a long-text column');
  assert.match(MODAL, /custom:\$\{k\}`, label: k, type: 'text', long: true/,
    'custom-field columns are not long-text columns');
  assert.match(MODAL, /<AutoGrowTextarea/, 'no textarea is rendered for long columns');
  assert.match(MODAL, /rows=\{1\}/, 'the growing textarea does not start at one row');
  assert.match(MODAL, /el\.scrollHeight/, 'the textarea height is never synced to its content');
  assert.match(CSS, /\.bulk-table__textarea \{[\s\S]*?white-space: pre-wrap;/,
    'the textarea does not preserve wrapping');
  assert.match(CSS, /\.bulk-table__textarea \{[\s\S]*?overflow-wrap: anywhere;/,
    'long unbroken values cannot break onto the next line');
  assert.match(CSS, /\.bulk-table__textarea \{[\s\S]*?resize: none;/,
    'the wrapping textarea shows a resize handle');
  // The root cause of the reported "disappearing" text.
  assert.doesNotMatch(CSS, /\.bulk-table__cell \{ white-space: nowrap; \}/,
    '.bulk-table__cell still forces nowrap — long values would be clipped again');
  assert.match(CSS, /\.bulk-table__grid td \{[\s\S]*?vertical-align: top;/,
    'cells are not top-aligned, so a grown row would misalign its controls');
});

/* ── v0.1.68: one prompt per action ──────────────────────────────────── */

test('one user action can never produce two confirmations', () => {
  // Opening either prompt dismisses the other. Before v0.1.68 the dry-run
  // summary and the unsaved-close prompt were independent state, so clicking
  // Close while the summary was open stacked both on screen.
  assert.match(MODAL, /function showConfirm\(next\) \{[\s\S]*?setClosePrompt\(false\);[\s\S]*?setConfirm\(next\);/,
    'showing a confirmation does not dismiss the other prompt');
  assert.match(MODAL, /function requestClose\(\) \{[\s\S]*?setConfirm\(null\);[\s\S]*?setClosePrompt\(true\);/,
    'requesting close does not dismiss an open summary first');
  // Every dry-run outcome goes through showConfirm; a bare setConfirm({kind…})
  // would be a second path that forgets to clear the close prompt.
  assert.doesNotMatch(MODAL, /setConfirm\(\{ kind:/,
    'a confirmation path bypasses showConfirm and can stack with the close prompt');
  // A successful save clears the dirty state AND both prompts, so the close
  // right after it cannot re-open the unsaved-edits warning.
  assert.match(MODAL, /setEdits\(\{\}\);[\s\S]*?setConfirm\(null\);[\s\S]*?setClosePrompt\(false\);/,
    'a successful save does not clear the dirty state and both prompts');
});

/* ── v0.1.69: a keystroke must not lose the cell ─────────────────────── */

test('a cell cannot lose focus to the modal on every keystroke', () => {
  // The regression: Modal focused its dialog inside an effect that also
  // depended on `onClose`. BulkTableModal's `requestClose` is a new function
  // each render, so every keystroke re-ran the effect and moved focus to the
  // dialog — the cell accepted exactly one character.
  const focusEffect = UI.match(
    /queueMicrotask\(\(\) => dialogRef\.current\?\.focus\(\)\);\s*\n\s*\}, \[([^\]]*)\]\);/,
  );
  assert.ok(focusEffect, 'the Modal dialog-focus effect is missing');
  assert.equal(focusEffect[1].trim(), 'open',
    'the Modal focus effect must depend on `open` only — depending on onClose re-focuses the dialog on every parent re-render');
  // The Escape listener still follows the live onClose, so Esc cannot go stale.
  assert.match(UI, /window\.addEventListener\('keydown', onKey\)/,
    'the Modal Escape listener is missing');
});

test('row and cell identity never depend on a cell value', () => {
  assert.match(MODAL, /<tr key=\{product\.id \?\? r\}/,
    'the row key must be the product id (falling back to the index), never a value');
  assert.match(MODAL, /key=\{c\.key\}/,
    'the cell key must be the stable column key');
  // The rendered value comes from (row, column), so a keystroke is a prop
  // update — not an identity change. This is the invariant the fix depends on.
  assert.match(MODAL, /const value = cellValue\(r, c\.key\);/,
    'cell values must be derived from (row, column), not stored in the key');
});

test('the crawl types key by key instead of setting the value in one event', () => {
  assert.match(CRAWL, /Input\.dispatchKeyEvent/,
    'the crawl must dispatch real per-key events — a single synthetic set is what hid this bug');
  assert.match(CRAWL, /every keystroke keeps focus and accumulates in the cell/,
    'the per-keystroke focus assertion is missing');
  assert.match(CRAWL, /a wrapping cell keeps focus while the row grows/,
    'the wrapping-cell focus assertion is missing');
  // The shared cause is proven in a SECOND dialog, not just the symptom.
  assert.match(CRAWL, /a different dialog keeps the caret on every keystroke/,
    'the cross-modal focus assertion is missing');
});

test('the version and the top What’s new entry agree', () => {
  assert.equal(LOCK.version, PKG.version, `package-lock.json is ${LOCK.version}, expected ${PKG.version}`);
  assert.equal(LOCK.packages?.['']?.version, PKG.version, 'package-lock.json packages[""] disagrees');
  const topVersion = WHATS_NEW.match(/const CHANGELOG = \[\s*\{\s*version: '([^']+)'/)?.[1];
  assert.equal(topVersion, PKG.version, `the top What's new entry is ${topVersion}, expected ${PKG.version}`);

  // The 0.1.66 entry's bullets are plain text, and it describes the table.
  const start = WHATS_NEW.indexOf(`version: '${BULK_TABLE_VERSION}'`);
  const rest = WHATS_NEW.slice(start + 1);
  const entry = WHATS_NEW.slice(start, start + 1 + rest.indexOf("version: '"));
  assert.match(entry, /bulk (edit )?table|Edit in table/i, 'the 0.1.66 changelog entry does not mention the feature');
  assert.doesNotMatch(entry, /\*\*|\[[^\]]+\]\(/, 'changelog bullets render as plain text — no markdown');
});
