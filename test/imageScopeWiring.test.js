/**
 * v0.1.69: two customer-reported wiring failures, pinned statically.
 *
 * Fix A — "Apply to which images" grew a third mode, Specific positions,
 * built as the reusable ImageScopeField control so the follow-up release can
 * drop it into the other image operations. The feature is only real if the
 * picked scope travels the whole chain:
 *
 *     ImageScopeField → dialog value → preload → IPC channel → validator → selectImages
 *
 * The "which images / why skipped" rule must live in ONE place on the main
 * side (main/util/imageScope.js) so it cannot drift between operations.
 *
 * Fix B — the "Image operations ▾" panel outgrew the window. The fix is CSS
 * (scroll + a measured max-height) plus renderer measurement (flip). A
 * stylesheet regression cannot be caught by a renderer unit test, so the
 * panel class is read out of the real CSS here.
 *
 * Static on purpose: runs under plain `npm test`, no Electron, no DB.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const MODAL = read('renderer/modules/ProductLibrary/BulkOverlayRunModal.jsx');
// v0.1.70: the pure value builders / parser live in imageScopeValue.mjs (so
// they are unit-testable without React); the control component stays in the
// .jsx. Both files together are "the shared control" these assertions guard.
const FIELD = read('renderer/modules/ProductLibrary/ImageScopeField.jsx')
  + '\n' + read('renderer/modules/ProductLibrary/imageScopeValue.mjs');
const LIBRARY = read('renderer/modules/ProductLibrary/index.jsx');
const PRELOAD = read('main/preload.js');
const IPC = read('main/ipc/templates.js');
const VALIDATORS = read('main/server/validators.js');
const SCOPE = read('main/util/imageScope.js');
const CSS = read('renderer/index.css');

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return m ? m[1] : '';
}

test('the shared ImageScopeField owns the third "Specific positions" mode', () => {
  assert.match(FIELD, /Specific positions/, 'the third image-scope radio is missing');
  assert.match(FIELD, /IMAGE_SCOPE_DEFAULT/, 'the control must export the default value shape');
  assert.match(FIELD, /scope: 'positions'/, 'the positions mode is not part of the value shape');
  assert.match(FIELD, /buildImageScope/, 'there is no single builder for the value shape');
  assert.match(FIELD, /Position \$\{pos\}/, 'position tick-boxes are not labelled for discovery');
  assert.match(FIELD, /parsePositionsInput/, 'the text field is not parsed');
  assert.match(FIELD, /skipped and reported/, 'the skip warning hint is missing');
  assert.match(FIELD, /image-scope__tick/, 'position tick-boxes have no styling hook');
});

test('BulkOverlayRunModal is a caller of the shared control, not its owner', () => {
  assert.match(MODAL, /import \{[^}]*ImageScopeField[^}]*\} from '\.\/ImageScopeField\.jsx'/,
    'the modal does not import the shared control');
  assert.match(MODAL, /useImageScope\(\)/, 'the modal does not use the shared state hook');
  assert.match(MODAL, /<ImageScopeField[\s\S]*?value=\{imageSelection\}/,
    'the modal never renders the shared control against the value shape');
  assert.doesNotMatch(MODAL, /Specific positions/,
    'the positions UI is still inline in the modal instead of the shared control');
});

test('the picked positions reach the IPC call', () => {
  assert.match(MODAL, /const imageSelection = imageChoice\.value/,
    'the modal does not send the shared value shape');
  assert.match(MODAL, /applyBulk\(\{[\s\S]{0,200}imageSelection/, 'applyBulk does not spread the image selection');
  assert.match(MODAL, /applyByFilter\(\{[\s\S]{0,200}imageSelection/, 'applyByFilter does not spread the image selection');
  // Preload forwards it on all three overlay-apply methods.
  for (const method of ['applyToProduct', 'applyBulk', 'applyByFilter']) {
    assert.ok(
      new RegExp(`${method}: \\(\\{[^}]*positions[^}]*\\}`).test(PRELOAD),
      `main/preload.js ${method} does not accept positions`,
    );
  }
  assert.match(IPC, /expose\('templates:applyBulk', async \(\{[\s\S]*?positions[\s\S]*?\} = \{\}\)/,
    'the applyBulk handler does not read positions');
  assert.match(IPC, /expose\('templates:applyByFilter', async \(\{[\s\S]*?positions[\s\S]*?\} = \{\}\)/,
    'the applyByFilter handler does not read positions');
  assert.match(IPC, /positions: normalizedPositions/, 'positions never reach applyBulkInternal');
});

test('the shared rule lives in one main-side helper and the handler uses it', () => {
  assert.match(SCOPE, /function selectImages\(images, \{ scope = 'main', positions \} = \{\}\)/,
    'main/util/imageScope.js must export selectImages(images, { scope, positions })');
  assert.match(SCOPE, /skippedReason/, 'selectImages does not report a skip reason');
  assert.match(IPC, /selectImages\(imageList, \{ scope, positions \}\)/,
    'the template-apply handler does not use the shared selectImages rule');
  assert.doesNotMatch(IPC, /function pickTargetImages/,
    'the template handler kept its own image-selection rule instead of the shared one');
});

test('the positions input has a validator (and old callers still pass)', () => {
  assert.match(VALIDATORS, /function validateOptionalPositions/, 'the positions validator is missing');
  const uses = VALIDATORS.match(/validateOptionalPositions\(a\.positions\)/g) || [];
  assert.ok(uses.length >= 3,
    `validateOptionalPositions is used ${uses.length} time(s) — applyToProduct, applyBulk and applyByFilter all need it`);
  // Absent is legal: the pre-v0.1.69 `scope` contract must keep working.
  assert.match(VALIDATORS, /if \(positions == null\) return true/,
    'positions must stay optional so saved presets / older renderers do not break');
});

test('the skip reason is reported, not just the count', () => {
  assert.match(IPC, /skippedReasons/, 'the bulk result has no per-reason skip summary');
  assert.match(SCOPE, /no \$\{ordinal\(missing\[0\]\)\} image/, 'the skip reason wording is missing');
  assert.match(MODAL, /skipSummary/, 'the modal toast does not read the skip reasons');
});

test('the Image operations panel scrolls and can flip above the trigger', () => {
  const panel = cssBlock('.lib-bulk-menu__panel');
  assert.match(panel, /overflow-y:\s*auto/, 'the menu panel cannot scroll, so the last section is unreachable');
  assert.match(panel, /max-height:/, 'the panel has no max-height bound');
  assert.match(LIBRARY, /getBoundingClientRect\(\)/, 'the menu never measures the trigger');
  assert.match(LIBRARY, /placement === 'up'/, 'the menu cannot render upward');
  assert.match(LIBRARY, /bottom: 'calc\(100% \+ 4px\)'/, 'the flipped placement has no anchor');
  assert.match(LIBRARY, /window\.innerHeight/, 'the menu does not bound itself to the window height');
});

test('sections are sideways submenus, bounded and left-flipping too', () => {
  assert.match(LIBRARY, /lib-bulk-menu__section-trigger/, 'the section labels are not submenu triggers');
  assert.match(LIBRARY, /aria-haspopup="menu"/, 'submenu triggers do not advertise a popup');
  assert.match(LIBRARY, /aria-expanded=\{openSection === sec\.label\}/, 'submenu triggers do not expose their state');
  assert.match(LIBRARY, /lib-bulk-menu__submenu/, 'there is no submenu panel');
  // Horizontal flip: left when the right edge would leave the window.
  assert.match(LIBRARY, /pRect\.right \+ 4/, 'the submenu is not positioned beside the panel');
  assert.match(LIBRARY, /pRect\.left - 4 - SUBMENU_WIDTH/, 'the submenu cannot flip to the left');
  assert.match(LIBRARY, /subPosition[\s\S]{0,400}maxHeight/, 'the submenu is not bounded/scrolled');
  const submenu = cssBlock('.lib-bulk-menu__submenu');
  assert.match(submenu, /overflow-y:\s*auto/, 'the submenu panel cannot scroll');
  assert.match(submenu, /max-height:/, 'the submenu has no max-height bound');
});

test('the menu search is always present and flattens the tree', () => {
  assert.match(LIBRARY, /lib-bulk-menu__search/, 'there is no filter field');
  assert.match(LIBRARY, /lib-bulk-menu__search-input/, 'the filter field has no input');
  // v0.1.72: the field is no longer threshold-gated on the menu length.
  assert.doesNotMatch(LIBRARY, /showSearch|totalItems/, 'the filter field must not be gated on the menu length');
  assert.match(LIBRARY, /searching \? \(/, 'search does not switch the panel to the flat filtered list');
  assert.match(LIBRARY, /flatItems\.map/, 'the flat filtered list is not rendered');
  assert.match(LIBRARY, /lib-bulk-menu__flat-meta/, 'flat results do not name their section');
});

test('the menu keyboard covers both levels', () => {
  assert.match(LIBRARY, /e\.key === 'ArrowDown'/, 'arrow-key navigation is missing');
  assert.match(LIBRARY, /e\.key === 'ArrowUp'/, 'arrow-key navigation is missing');
  assert.match(LIBRARY, /e\.key === 'ArrowRight'/, 'there is no key to open a submenu');
  assert.match(LIBRARY, /e\.key === 'ArrowLeft'/, 'there is no key to close a submenu');
  assert.match(LIBRARY, /e\.key === 'Escape'/, 'Escape must still close the menu');
});

test('the search field joins the arrow cycle and Escape clears the query first', () => {
  assert.match(LIBRARY, /function navFocusables\(\)/, 'the arrow cycle does not know about the search field');
  assert.match(LIBRARY, /\[searchRef\.current, \.\.\.rows\]/, 'the search field is not part of the ↑/↓ cycle');
  assert.match(LIBRARY, /if \(query\.length > 0\)[\s\S]{0,200}setQuery\(''\)/,
    'Escape must clear a typed query before closing the whole menu');
  assert.match(LIBRARY, /e\.target === searchRef\.current/, 'the search field is not told apart from the rows');
});

test('hover intent points at the open submenu instead of a fixed delay', () => {
  assert.match(LIBRARY, /import \{ pointsTowardRect \} from '\.\/menuIntent\.mjs'/,
    'the menu does not import the pure intent helper');
  assert.match(LIBRARY, /pointsTowardRect\(prev, next, rect\)/,
    'the trigger hover does not consult the intent helper');
  assert.match(LIBRARY, /setTimeout\(\(\) => openSubmenu\(sectionLabel, trigger\), HOVER_OPEN_DELAY_MS\)/,
    'the no-clear-direction fallback delay is missing');
  assert.match(LIBRARY, /!openSection\) \{ openSubmenu\(sectionLabel, trigger\); return; \}/,
    'hover must open a section immediately when no submenu is open');
  assert.match(LIBRARY, /HOVER_OPEN_DELAY_MS/, 'the hover fallback delay is missing');
  assert.match(LIBRARY, /ponytail:/, 'a deliberate shortcut needs a ponytail: note');
  const INTENT = read('renderer/modules/ProductLibrary/menuIntent.mjs');
  assert.match(INTENT, /export function pointsTowardRect\(prevPoint, nextPoint, rect\)/,
    'the pure intent helper is missing or has the wrong signature');
});
