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

const FLUSH = blockAfter(FORM, 'const flushOwed = useCallback(() =>');
const PRODUCT_EFFECT = blockAfter(FORM, 'useEffect(() => {\n    flushOwed();');
const SAVE = blockAfter(FORM, 'async function handleSave()');
const AUTOSAVE = blockAfter(FORM, 'autoSaveTimer.current = setTimeout(async () =>');
const DUPLICATE = blockAfter(FORM, 'async function handleDuplicate()');

test('a flush writes the payload to the id and token it was captured with', () => {
  assert.match(FLUSH, /updateProduct\(owed\.id, \{ \.\.\.owed\.payload, expectedUpdatedAt: owed\.expectedUpdatedAt \}\)/,
    'flushOwed must write to the payload\'s own id with its own token');
  assert.doesNotMatch(FLUSH, /activeProductIdRef\.current|lastSavedUpdatedAt\.current/,
    'flushOwed must not read the refs — they may already point at another product');
  assert.match(FLUSH, /clearTimeout\(autoSaveTimer\.current\)/, 'a flush must disarm the debounce');
  assert.match(FLUSH, /autoSavePayload\.current = null/, 'a flush must claim the payload so it is written once');
  assert.match(FORM, /autoSavePayload\.current = \{\s*id: activeProductId,\s*expectedUpdatedAt: lastSavedUpdatedAt\.current,\s*payload: buildPayload\(\),/,
    'the owed payload must carry its id and token from the moment it is built');
});

test('switching products flushes the owed edit before the refs move', () => {
  const flushAt = PRODUCT_EFFECT.indexOf('flushOwed();');
  const repointAt = PRODUCT_EFFECT.indexOf('activeProductIdRef.current = product.id');
  const tokenAt = PRODUCT_EFFECT.indexOf('lastSavedUpdatedAt.current = source.updatedAt');
  assert.ok(flushAt >= 0 && repointAt > flushAt && tokenAt > flushAt,
    'flushOwed() must run before the panel is re-pointed at the next product');
  assert.match(PRODUCT_EFFECT, /selectionGen\.current \+= 1/, 'a switch must start a new selection generation');
  assert.match(FORM, /useEffect\(\(\) => \(\) => flushOwed\(\), \[flushOwed\]\)/,
    'unmount must flush through the same path');
});

test('async completions are dropped once the selection has moved', () => {
  assert.doesNotMatch(FORM, /listByProduct\([^)]*\)\s*\.then\(setImages\)/,
    'an image list must not be applied without checking it is still for the product on screen');
  const guardedFetches = FORM.match(/listByProduct\([^)]*\)\s*\.then\(\(rows\) => \{ if \(gen === selectionGen\.current\) setImages\(rows\); \}\)/g) || [];
  assert.ok(guardedFetches.length >= 3, `expected the panel's image fetches to be generation-guarded, found ${guardedFetches.length}`);
  assert.match(FORM, /function noteSaved\(gen, id, updatedAt\) \{\s*if \(gen !== selectionGen\.current\) return false;/,
    'a token must only be recorded for the selection it was written for');
  assert.match(AUTOSAVE, /if \(!noteSaved\(gen, owed\.id, updated\?\.updatedAt\)\) return;/);
  assert.match(SAVE, /const gen = selectionGen\.current;/, 'Save must capture the selection before awaiting');
});

test('a finished create points the refs at the created row, not only the state', () => {
  const create = blockAfter(SAVE, 'if (isCreate)');
  assert.match(create, /if \(!current\(\)\) return;/, 'a create that resolves after a switch must not re-point the panel');
  assert.match(create, /setActiveProductId\(created\.id\)/);
  assert.match(create, /activeProductIdRef\.current = created\.id/);
  assert.match(create, /lastSavedUpdatedAt\.current = created\.updatedAt \?\? null/);
});

test('Save supersedes a pending autosave', () => {
  const clearAt = SAVE.indexOf('clearTimeout(autoSaveTimer.current)');
  const dropAt = SAVE.indexOf('autoSavePayload.current = null');
  const writeAt = SAVE.indexOf('await ');
  assert.ok(clearAt >= 0 && dropAt >= 0, 'Save must cancel the debounce and drop the owed payload');
  assert.ok(clearAt < writeAt && dropAt < writeAt, 'and must do it before it writes');
});

test('an autosave CONFLICT never toasts the raw sentinel', () => {
  const catchBlock = blockAfter(AUTOSAVE, '} catch (err)');
  assert.match(catchBlock, /if \(parseConflictError\(err\)\)/, 'the autosave must recognise a conflict');
  const conflictBranch = blockAfter(catchBlock, 'if (parseConflictError(err))');
  assert.doesNotMatch(conflictBranch, /err\.message/, 'a conflict must be explained, not printed');
  assert.match(conflictBranch, /Click Save/, 'the message must say how to resolve it');
});

test('Esc already handled by a control does not close the panel', () => {
  const esc = blockAfter(FORM, 'const onKey = (e) =>');
  assert.match(esc, /if \(e\.defaultPrevented\) return;/,
    'Esc in a SearchableSelect (brand / category / supplier) must not also close the panel');
  assert.match(esc, /onCloseRef\.current\?\.\(\)/, 'the listener must read onClose from a ref');
  assert.match(FORM, /window\.removeEventListener\('keydown', onKey\);\s*\}, \[isEmpty\]\);/,
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
  assert.match(LIBRARY, /const SORT_COLLATOR = new Intl\.Collator\(undefined, \{ numeric: true, sensitivity: 'base' \}\)/);
  assert.match(LIBRARY, /SORT_COLLATOR\.compare\(String\(av\), String\(bv\)\)/);
  assert.doesNotMatch(LIBRARY, /localeCompare\(String\(bv\), undefined, \{ numeric: true/);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const skus = ['AV-M8200', 'av-m81', 'AV-M8101', 'BBC-2', 'bbc-10', 'Épice', 'epice-1', ''];
  const viaCollator = skus.slice().sort((a, b) => collator.compare(a, b));
  const viaLocale = skus.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  assert.deepEqual(viaCollator, viaLocale);
});
