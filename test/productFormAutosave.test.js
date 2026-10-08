/**
 * The product panel's autosave, pinned at the source.
 *
 * `<ProductForm>` is rendered without a `key`, so switching rows re-points the
 * SAME component at another product instead of remounting it. That made three
 * things true that no unit test could see, because `npm test` mounts no React
 * screens:
 *
 *   - an edit typed within 500 ms of switching was dropped, its payload stayed
 *     owed, and the unmount flush later wrote A's fields to B with B's token;
 *   - a save or image fetch that resolved after a switch landed on the product
 *     now on screen (B inherited A's token, or a create re-pointed the panel);
 *   - Esc inside a brand / category picker closed the whole panel, and
 *     Duplicate set the Image Workspace's product instead of the panel's.
 *
 * The behaviour lives in renderer/modules/ProductLibrary/ProductForm.jsx; this
 * file fails if the structure that makes it correct is undone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const FORM = read('renderer/modules/ProductLibrary/ProductForm.jsx');
const LIBRARY = read('renderer/modules/ProductLibrary/index.jsx');

/** The text of the `{ … }` block that starts at the first `{` after `marker`. */
function blockAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`unbalanced block after ${marker}`);
}

const FLUSH = blockAfter(FORM, 'const flushOwed = useCallback(async () =>');
const PRODUCT_EFFECT = blockAfter(FORM, 'useEffect(() => {\n    selectionGen.current += 1;');
const SAVE = blockAfter(FORM, 'async function handleSave()');
const DUPLICATE = blockAfter(FORM, 'async function handleDuplicate()');

test('autosave, explicit Save and navigation share the latest-save queue', () => {
  assert.match(FORM, /createLatestSaveQueue/);
  assert.match(FLUSH, /await saveQueue\.current\?\.flush\(\(\) => autoSavePayload\.current\)/);
  assert.doesNotMatch(FLUSH, /autoSavePayload\.current = null|catch/);
  assert.match(SAVE, /await flushOwed\(\)/);
  assert.match(FORM, /saveQueue\.current\?\.enqueue\(owed\)/);
  assert.match(blockAfter(FORM, 'persist: (draft, expectedUpdatedAt) =>'), /return updateProduct\(id/);
});

test('selection and all navigation exits await persistence before repointing or unmounting', () => {
  assert.match(FORM, /registerCompanySwitchFlusher\(flushOwed\)/);
  assert.match(FORM, /onRegisterFlush\?\.\(flushOwed\)/);
  assert.match(LIBRARY, /await panelFlush\.current\?\.\(\)/);
  for (const marker of ['const handleOpen = useCallback', 'const startNewProduct = useCallback', 'const closePanel = useCallback']) {
    assert.match(blockAfter(LIBRARY, marker), /await beforePanelChange\(\)/);
  }
  assert.doesNotMatch(FORM, /useEffect\(\(\) => \(\) => flushOwed/);
  assert.match(PRODUCT_EFFECT, /selectionGen\.current \+= 1/);
});

test('async completions only advance the current product revision', () => {
  assert.doesNotMatch(FORM, /listByProduct\([^)]*\)\s*\.then\(setImages\)/);
  assert.match(FORM, /gen !== selectionGen\.current \|\| id !== activeProductIdRef\.current/);
  assert.match(SAVE, /const gen = selectionGen\.current;/);
});

test('a finished create points the refs and queue at the created row', () => {
  const create = blockAfter(SAVE, 'if (isCreate)');
  assert.match(create, /if \(!current\(\)\) return;/);
  assert.match(create, /setActiveProductId\(created\.id\)/);
  assert.match(create, /activeProductIdRef\.current = created\.id/);
  assert.match(create, /lastSavedUpdatedAt\.current = created\.updatedAt \?\? null/);
  assert.match(create, /saveQueue\.current = makeSaveQueue\(created\.id/);
});

test('failed drafts stay present and conflict copy explains the Save recovery', () => {
  const onError = blockAfter(FORM, 'onError: (err, draft) =>');
  assert.doesNotMatch(onError, /autoSavePayload\.current = null/);
  assert.match(onError, /parseConflictError\(err\)/);
  assert.match(onError, /Click Save/);
  assert.match(onError, /err\.message/);
});

test('Esc already handled by a control does not close the panel', () => {
  const esc = blockAfter(FORM, 'const onKey = (e) =>');
  assert.match(esc, /if \(e\.defaultPrevented\) return;/,
    'Esc in a SearchableSelect (brand / category / supplier) must not also close the panel');
  assert.match(esc, /onCloseRef\.current\?\.\(\)/, 'the listener must read onClose from a ref');
  assert.match(FORM, /window\.removeEventListener\('keydown', onKey\);\s*\}, \[isEmpty, visible\]\);/,
    'the Esc listener must not re-register on every Library render');
});

test('Duplicate moves the panel, not the Image Workspace, to the copy', () => {
  assert.doesNotMatch(DUPLICATE, /setActiveProductId/,
    'the store\'s activeProductId is the Image Workspace\'s product, not the panel\'s');
  assert.match(DUPLICATE, /onDuplicated\?\.\(created\)/);
  assert.match(LIBRARY, /onDuplicated=\{handleDuplicated\}/, 'the Library must wire the duplicate jump');
  const handler = blockAfter(LIBRARY, 'const handleDuplicated = useCallback(async (created) =>');
  assert.match(handler, /window\.api\.products\.get\(created\.id\)/, 'the panel needs the full row, token included');
  assert.match(handler, /setEditing\(/);
});

test('the Library hands memoized children stable props', () => {
  assert.match(FORM, /export const ProductForm = memo\(function ProductForm\(/);
  const jsx = LIBRARY.slice(LIBRARY.indexOf('<ProductForm'), LIBRARY.indexOf('/>', LIBRARY.indexOf('<ProductForm')));
  assert.doesNotMatch(jsx, /=\{\s*\(/, 'ProductForm is memoized — an inline arrow prop defeats it');
  assert.match(LIBRARY, /const toggleSelected = useCallback\(/, 'toggleSelected reaches memoized rows');
  assert.match(LIBRARY, /onOpenCost=\{handleOpenCost\}/, 'onOpenCost reaches memoized rows');
});

test('the sort uses one shared collator with the old ordering', () => {
  // 0.1.94: the sort moved to librarySort.js, shared with Edit in table.
  const SORT = read('renderer/modules/ProductLibrary/librarySort.js');
  assert.match(LIBRARY, /import \{[^}]*sortProducts[^}]*\} from '\.\/librarySort\.js'/);
  assert.match(SORT, /const SORT_COLLATOR = new Intl\.Collator\(undefined, \{ numeric: true, sensitivity: 'base' \}\)/);
  assert.match(SORT, /SORT_COLLATOR\.compare\(String\(av\), String\(bv\)\)/);
  assert.doesNotMatch(SORT, /localeCompare\(String\(bv\), undefined, \{ numeric: true/);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const skus = ['AV-M8200', 'av-m81', 'AV-M8101', 'BBC-2', 'bbc-10', 'Épice', 'epice-1', ''];
  const viaCollator = skus.slice().sort((a, b) => collator.compare(a, b));
  const viaLocale = skus.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  assert.deepEqual(viaCollator, viaLocale);
});
