const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../renderer/modules/ProductLibrary/index.jsx'), 'utf8');
const blocks = [
  ['handleOpen', '  const handleOpen =', '  const startNewProduct =', 'handleOpen({ id: "B" })'],
  ['startNewProduct', '  const startNewProduct =', '  useEffect(() => {\n    if (!pendingLibraryProductId', 'startNewProduct()'],
  ['closePanel', '  const closePanel =', '  // v0.26.13:', 'closePanel()'],
];
for (const [name, start, end, call] of blocks) test(`${name} cancels obsolete search intent only after draft guard succeeds`, async () => {
  for (const allowed of [false, true]) {
    let pending = 'A'; let editing = { id: 'A' }; let shown = false;
    const ctx = { useCallback: (fn) => fn, beforePanelChange: async () => allowed,
      revealPanel: () => { shown = true; }, setCreateNonce() {},
      useAppStore: { getState: () => ({ clearPendingLibraryNav: () => { pending = null; } }) },
      setEditing: (next) => { editing = typeof next === 'function' ? next(editing) : next; } };
    vm.createContext(ctx);
    const a = source.indexOf(start); const b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, 'extract the actual handler');
    vm.runInContext(source.slice(a, b), ctx);
    await vm.runInContext(call, ctx);
    assert.equal(pending, allowed ? null : 'A', 'an older request cannot replay on Library remount');
    if (!allowed) { assert.equal(editing.id, 'A'); assert.equal(shown, false); }
    else if (name === 'handleOpen') assert.equal(editing.id, 'B');
    else if (name === 'startNewProduct') assert.equal(editing, 'new');
    else assert.equal(editing, null);
  }
});
