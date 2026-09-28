/**
 * v0.1.85: product deletion must be hard to trigger by accident.
 *
 * The owner's report: "someone accidentally deleted a product. it seems product
 * deletion and image deletion is so close together they can easily make a
 * mistake." Two places had a red Delete sitting in a row of everyday controls:
 * the panel footer (`Delete | Duplicate | … | Cancel | Save`) and the bulk
 * toolbar (`AI Studio | Image operations ▾ | Edit fields | Delete N | Clear`).
 *
 * The fix is structural, not a colour change, so it is checked structurally:
 * the footer and the toolbar must NOT contain a delete button any more, the
 * action must live inside a menu, and both paths must pass a `requireText` to
 * the confirmation. The last one is the load-bearing bit — a menu only moves
 * the button, while typing the SKU (or DELETE) is what makes the confirm a
 * decision instead of a reflex.
 *
 * It also pins the copy that says where the files go, because that sentence is
 * the user's only clue that a mistake is recoverable at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const FORM = read('renderer/modules/ProductLibrary/ProductForm.jsx');
const LIBRARY = read('renderer/modules/ProductLibrary/index.jsx');
const CONFIRM = read('renderer/components/ConfirmModal.jsx');
const PRODUCTS_DB = read('main/db/products.js');
const TRASH = read('main/util/fileTrash.js');

test('no product-delete button is left in a row of everyday controls', () => {
  // The panel footer: no bare destructive button, and Delete is inside the menu.
  assert.doesNotMatch(FORM, /<Button variant="danger" onClick=\{handleDelete\}>/);
  assert.match(FORM, /data-product-more-menu/, 'the panel needs a menu to hold it');
  assert.match(FORM, /className="copy-menu__item copy-menu__item--danger"[\s\S]{0,400}handleDelete\(\)/,
    'the menu item is what calls handleDelete');

  // The bulk toolbar: same rule, and it must not be the primary-styled trigger.
  assert.doesNotMatch(LIBRARY, /<Button variant="danger" onClick=\{handleBulkDelete\}/);
  assert.match(LIBRARY, /label="⋯ More ▾"/);
  assert.match(LIBRARY, /danger: true,\s*\n\s*onClick: handleBulkDelete/,
    'the bulk delete item must be marked destructive');
  assert.match(LIBRARY, /variant="default"[\s\S]{0,200}label="⋯ More ▾"/,
    'a destructive action must not be dressed as the primary button');
  assert.match(LIBRARY, /searchable=\{false\}/, 'one row does not need a filter field');
});

test('both delete paths require the name to be typed', () => {
  // Single product: the SKU (or the name, then DELETE, as fallbacks).
  assert.match(FORM, /requireText: sku \|\| form\.name \|\| 'DELETE'/);
  // Bulk: a fixed word, because there is no single name to type.
  assert.match(LIBRARY, /requireText: 'DELETE'/);

  // And the dialog actually enforces it rather than accepting the prop.
  assert.match(CONFIRM, /requireText = null,/);
  assert.match(CONFIRM, /const typeSatisfied = !typeTarget \|\| typed\.trim\(\)\.toLowerCase\(\) === typeTarget\.toLowerCase\(\)/);
  assert.match(CONFIRM, /disabled=\{busy \|\| !typeSatisfied\}/,
    'the confirm button must stay disabled until the text matches');
  assert.match(CONFIRM, /requireText=\{opts\.requireText \?\? null\}/,
    'the imperative confirm() helper must forward it, or callers silently lose the gate');
});

test('the copy promises recovery, and the code provides it', () => {
  // v0.1.86 moved the promise on: the files are not merely trashed, the whole
  // item is restorable from the app. The copy has to say where.
  assert.match(FORM, /Settings →\s*Recently deleted/);
  assert.match(LIBRARY, /Settings → Recently deleted/);
  // …and the mechanism is one call in the delete path.
  assert.match(PRODUCTS_DB, /require\('\.\.\/deletedItems'\)\.holdProduct\(/);
  assert.doesNotMatch(PRODUCTS_DB, /fs\.rmSync\(abs, \{ recursive: true, force: true \}\)/,
    'the rm-rf of v0.1.84 and earlier must not come back');
  assert.match(TRASH, /const shell = explicit \? opts\.shell : electronShell\(\)/,
    'the Trash comes from Electron (or a test), never from a hard-coded path');

  // The Trash helper is now the PURGE path (the recycle bin calls it when an
  // item is removed for good), and it must never quietly erase when the Trash
  // refuses — that is the difference between "recoverable" and "gone".
  const refusedBranch = TRASH.slice(TRASH.indexOf("return 'trashed'"));
  assert.doesNotMatch(refusedBranch, /rmSync/,
    'a refused Trash must leave the files, not delete them as a consolation prize');

  // The single-image path holds its file too, so the pin above is not the only
  // one — see test/deletedItemsWiring.test.js for the ordering check.
  assert.match(read('main/db/productImages.js'), /holdImage\(/);
});
