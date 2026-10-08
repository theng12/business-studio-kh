/**
 * v0.1.67: the list tools must stay WIRED.
 *
 * Brands, Categories and Suppliers now share one search / sort / selection /
 * bulk-delete implementation (renderer/lib/listTools.js). The failure this
 * file guards against is not a wrong function — it is a screen quietly
 * growing its own copy, or losing a control in a refactor. Unit tests on
 * listTools.js cannot see either: the module stays green while a screen stops
 * calling it, or re-implements range selection slightly differently.
 *
 * The Library filter column's collapse is checked here too, because its whole
 * point is that ONE localStorage key backs the toolbar button and the panel
 * chevron; inconsistent states would read as "the panel is open" to one control and
 * "closed" to the other.
 *
 * Static by design, so it runs under plain `npm test`. The runtime behavior is
 * covered by the listTools unit suite and the UI crawl.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const BRANDS = read('renderer/modules/Brands/index.jsx');
const CATEGORIES = read('renderer/modules/Categories/index.jsx');
const SUPPLIERS = read('renderer/modules/Suppliers/index.jsx');
const LIBRARY = read('renderer/modules/ProductLibrary/index.jsx');
const PRODUCTS_STORE = read('renderer/store/products.js');

const SCREENS = [
  ['Brands', BRANDS],
  ['Categories', CATEGORIES],
  ['Suppliers', SUPPLIERS],
];

test('every screen drives the shared listTools module and not a local copy', () => {
  for (const [name, src] of SCREENS) {
    assert.match(src, /from '\.\.\/\.\.\/lib\/listTools\.js'/, `${name} does not import listTools`);
    for (const fn of ['sortRows', 'nextSelection', 'allIds']) {
      assert.match(src, new RegExp(`\\b${fn}\\(`), `${name} never calls ${fn}()`);
    }
    // A second implementation is the thing to prevent, not just an unused import.
    assert.doesNotMatch(src, /function\s+(nextSelection|sortRows|filterRows|allIds)\b/,
      `${name} has grown a local copy of a listTools function`);
    assert.doesNotMatch(src, /const\s+(nextSelection|sortRows|filterRows|allIds)\s*=/,
      `${name} has grown a local copy of a listTools function`);
  }
  // Brands and Categories filter in the renderer; Suppliers keeps its
  // server-side search (which the client-mode race guard pins) and so uses
  // listTools for its sort and selection.
  for (const [name, src] of [['Brands', BRANDS], ['Categories', CATEGORIES]]) {
    assert.match(src, /\bfilterRows\(/, `${name} never calls filterRows()`);
  }
});

test('every screen has a search box, a sort select and checkboxes', () => {
  for (const [name, src] of SCREENS) {
    assert.match(src, /type="search"/, `${name} has no search box`);
    assert.match(src, /placeholder="Search /, `${name}'s search box has no placeholder`);
    assert.match(src, /aria-label="Sort /, `${name} has no sort select`);
    assert.match(src, /Name A–Z/, `${name} sort options are missing Name A–Z`);
    assert.match(src, /Name Z–A/, `${name} sort options are missing Name Z–A`);
    assert.match(src, /type="checkbox"/, `${name} has no checkbox column`);
    assert.match(src, /Select all visible/, `${name} has no select-all affordance`);
  }
});

test('the third sort option is screen-specific', () => {
  assert.match(BRANDS, /label: 'Most products first'/, 'Brands should sort by product count');
  assert.match(CATEGORIES, /label: 'Most products first'/, 'Categories should sort by product count');
  assert.match(SUPPLIERS, /label: 'Most purchase orders first'/, 'Suppliers should sort by PO count');
  assert.match(SUPPLIERS, /usage: \(a, b\) =>/, 'the PO comparator must be supplied via sortRows extra');
});

test('every screen has a bulk bar with a danger Delete and a Clear', () => {
  for (const [name, src] of SCREENS) {
    assert.match(src, /list-bulk-bar/, `${name} has no bulk bar`);
    assert.match(src, /\{selected\.length\} selected/, `${name} does not show the selected count`);
    assert.match(src, /variant="danger"/, `${name} bulk Delete is not danger-styled`);
    assert.match(src, /Delete \$\{/, `${name} has no bulk Delete button`);
    assert.match(src, />Clear</, `${name} has no Clear control`);
  }
});

test('deleting is a loop over the existing per-item delete, with one summary toast', () => {
  for (const [name, src] of SCREENS) {
    assert.match(src, /const failed = \[\]/, `${name} does not collect per-item failures`);
    assert.match(src, /Deleted \$\{deleted\}/, `${name} has no success summary toast`);
    assert.match(src, /Deleted \$\{deleted\} of \$\{/, `${name} has no partial summary toast`);
  }
  // No new IPC: the batch reuses the channels the single-row delete already used.
  assert.match(BRANDS, /window\.api\.brands\.remove\(/);
  assert.match(CATEGORIES, /window\.api\.categories\.remove\(/);
  assert.match(SUPPLIERS, /window\.api\.suppliers\.remove\(/);
});

test('the Suppliers refusal path names blocked suppliers and their purchase orders', () => {
  assert.match(SUPPLIERS, /poCountOf/, 'Suppliers must pre-check the PO rollup before deleting');
  assert.match(SUPPLIERS, /purchase orders/i, 'the refusal copy must mention purchase orders');
  assert.match(SUPPLIERS, /Archive instead/i, 'the refusal must point at archive');
  assert.match(SUPPLIERS, /still in use/i, 'the summary must say a blocked supplier is still in use');
});

test('the All · Unassigned / Uncategorized chips open the Library with its own filter', () => {
  assert.match(BRANDS, /All · Unassigned \(/, 'Brands is missing the All · Unassigned chip');
  assert.match(BRANDS, /setBrandFilterUnassigned/, 'the Brands chip does not set the unassigned filter');
  assert.match(CATEGORIES, /All · Uncategorized \(/, 'Categories is missing the All · Uncategorized chip');
  assert.match(CATEGORIES, /setCategoryFilterUnassigned/, 'the Categories chip does not set the unassigned filter');
  for (const [name, src] of [['Brands', BRANDS], ['Categories', CATEGORIES]]) {
    assert.match(src, /setActiveModule\('library'\)/, `${name}'s chip must open the Product Library`);
    // A chip is never a selectable row.
    const chipBlock = src.slice(src.indexOf('list-tools__unassigned'));
    assert.doesNotMatch(chipBlock.slice(0, 400), /type="checkbox"/, `${name}'s chip must not be selectable`);
  }
  // The store setters are deterministic, not a toggle that may already be on.
  assert.match(PRODUCTS_STORE, /setBrandFilterUnassigned\(\)/, 'store is missing setBrandFilterUnassigned');
  assert.match(PRODUCTS_STORE, /setCategoryFilterUnassigned\(\)/, 'store is missing setCategoryFilterUnassigned');
  assert.match(PRODUCTS_STORE, /brandIds: \[null\]/, 'setBrandFilterUnassigned must pin brandIds to [null]');
  assert.match(PRODUCTS_STORE, /categoryIds: \[null\]/, 'setCategoryFilterUnassigned must pin categoryIds to [null]');
});

test('the Library filter column retracts to a rail through the independent persisted panel states', () => {
  // Each panel has its own persisted choice; toolbar and filter rail agree.
  assert.match(LIBRARY, /PANEL_VISIBLE_STORAGE_KEY = 'ProductLibrary\.panelVisible'/, 'the panel key moved');
  assert.match(LIBRARY, /lib-layout--filters-collapsed/, 'the collapsed layout class is missing');
  assert.match(LIBRARY, /lib-filters__collapse/, 'the panel header has no collapse control');
  // Both controls call the same toggle.
  const toggles = LIBRARY.match(/onClick=\{toggleFilters\}/g) || [];
  assert.ok(toggles.length >= 2, `expected the toolbar button and the panel chevron to share toggleFilters (found ${toggles.length})`);
  // 0.1.94: what is shown can differ from the saved choice (Filters retract
  // beside Details on a narrow window), so the controls report `filtersShown`.
  assert.match(LIBRARY, /aria-pressed=\{!filtersShown\}/, 'the panel chevron must expose its pressed state');
  assert.match(LIBRARY, /Hide filters/, 'the hide tooltip is missing');
  assert.match(LIBRARY, /Show filters/, 'the show tooltip is missing');
  assert.match(LIBRARY, /ProductLibrary\.filtersVisible/, 'independent filter preference missing');
  // 0.1.94: Details shows only while a product is open (showDetails =
  // panelVisible && editing); hidden, the form stays mounted with its draft.
  assert.match(LIBRARY, /lib-inspector" hidden=\{!showDetails\}/, 'hiding details must preserve the mounted draft');
  assert.match(LIBRARY, /const showDetails = panelVisible && editing !== null;/, 'Details must follow an open product');
  assert.match(LIBRARY, /shortcutBlocked\(e\.target, globalThis\.document\)/, 'filter shortcut must leave inputs/dialogs alone');
  // The keyboard shortcut the tooltips advertise.
  assert.match(LIBRARY, /e\.key !== 'b' && e\.key !== 'B'/, 'the ⌘B shortcut is missing');
});

test('every FilterGroup renders a toggle and its open/closed state is persisted', () => {
  assert.match(LIBRARY, /ProductLibrary\.filterGroups/, 'the filter group state key is missing');
  assert.match(LIBRARY, /function FilterGroup\(\{ label, open = true, onToggle/, 'FilterGroup does not take an open/onToggle pair');
  assert.match(LIBRARY, /className="filter-group__toggle"/, 'FilterGroup renders no toggle');
  assert.match(LIBRARY, /aria-expanded=\{open\}/, 'the group toggle must expose aria-expanded');
  // All five groups are wired through the persisted map.
  for (const label of ['Brand', 'Category', 'Status', 'Process status', 'Images']) {
    assert.match(LIBRARY, new RegExp(`isGroupOpen\\('${label}'\\)`), `${label} group is not wired to the persisted state`);
  }
});

test('Reset all filters sits above the first filter group', () => {
  const reset = LIBRARY.indexOf('lib-filters__reset');
  const firstGroup = LIBRARY.indexOf('<FilterGroup label="Brand"');
  assert.ok(reset !== -1, 'the reset button is gone');
  assert.ok(firstGroup !== -1, 'the Brand filter group is gone');
  assert.ok(reset < firstGroup, 'Reset all filters must come before the first filter group');
});

test('independent visibility choices migrate legacy settings and survive blocked storage', () => {
  const source = LIBRARY.slice(LIBRARY.indexOf("const PANEL_VISIBLE_STORAGE_KEY"), LIBRARY.indexOf('/**\n * v0.1.67: per-group'));
  const values = new Map([['ProductLibrary.panelVisible', 'off']]);
  const ctx = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  assert.equal(vm.runInContext('loadPanelVisible()', ctx), false);
  assert.equal(vm.runInContext('loadPanelVisible(FILTER_VISIBLE_STORAGE_KEY)', ctx), false);
  vm.runInContext('savePanelVisible(true)', ctx);
  assert.equal(vm.runInContext('loadPanelVisible(FILTER_VISIBLE_STORAGE_KEY)', ctx), false, 'legacy filter choice stays independent after Details changes');
  vm.runInContext('savePanelVisible(false)', ctx);
  vm.runInContext('savePanelVisible(true, FILTER_VISIBLE_STORAGE_KEY)', ctx);
  assert.equal(vm.runInContext('loadPanelVisible(FILTER_VISIBLE_STORAGE_KEY)', ctx), true);
  assert.equal(vm.runInContext('loadPanelVisible()', ctx), false);
  ctx.localStorage.getItem = () => { throw new Error('blocked'); };
  assert.equal(vm.runInContext('loadPanelVisible()', ctx), true);
});
