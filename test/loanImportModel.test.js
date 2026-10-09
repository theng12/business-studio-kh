const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { runInNewContext } = require('node:vm');

const ROOT = path.join(__dirname, '..');
const out = esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'renderer/modules/People/loanImportModel.js')],
  bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
const M = mod.exports;

const columns = [
  { key: 'loanNo', label: 'Loan number', aliases: ['loan_no'] },
  { key: 'originalPrincipalMinor', label: 'Original principal (USD cents / KHR riel)', aliases: ['original_principal'] },
  { key: 'deductViaPayroll', label: 'Deduct via payroll', aliases: ['payroll'] },
];

test('mapping guesses aliases once and rejects duplicate target assignments', () => {
  const mapping = M.guessMapping(['loan_no', 'Original Principal', 'payroll'], columns);
  assert.deepEqual(mapping, { loan_no: 'loanNo', 'Original Principal': 'originalPrincipalMinor', payroll: 'deductViaPayroll' });
  assert.equal(M.hasUniqueTargets(mapping), true);
  assert.equal(M.hasUniqueTargets({ Loan: 'loanNo', Number: 'loanNo' }), false);
});

test('mapped rows keep numeric zero and false, skip blank cells, and preserve source row numbers', () => {
  const rows = M.buildImportRows([
    { Number: 'A-1', Amount: 0, Payroll: false, Note: '  ' },
    { Number: '', Amount: '', Payroll: null, Note: '   ' },
    { Number: 'A-3', Amount: '12500', Payroll: 'false' },
  ], { Number: 'loanNo', Amount: 'originalPrincipalMinor', Payroll: 'deductViaPayroll', Note: 'purpose' });
  assert.deepEqual(rows, [
    { loanNo: 'A-1', originalPrincipalMinor: 0, deductViaPayroll: false, rowNo: 2 },
    { loanNo: 'A-3', originalPrincipalMinor: 12500, deductViaPayroll: false, rowNo: 4 },
  ]);
});

test('malformed numeric and boolean strings remain invalid values instead of becoming zero or false', () => {
  const rows = M.buildImportRows([
    { Amount: '12abc', Payroll: 'maybe' },
    { Amount: '  ', Payroll: '' },
  ], { Amount: 'originalPrincipalMinor', Payroll: 'deductViaPayroll' });
  assert.deepEqual(rows, [
    { originalPrincipalMinor: '12abc', deductViaPayroll: 'maybe', rowNo: 2 },
  ]);
});

test('sample values use the first nonblank cell while retaining zero and false', () => {
  assert.deepEqual(M.sampleValues([{ Amount: '', Enabled: null }, { Amount: 0, Enabled: false }], ['Amount', 'Enabled']), { Amount: '0', Enabled: 'false' });
});

test('money previews convert integer USD cents through the shared minor-unit formatter', () => {
  assert.equal(M.formatImportCell(10000, 'originalPrincipalMinor', 'USD'), '10000 · $100.00');
  assert.equal(M.formatImportCell(10000, 'originalPrincipalMinor', 'KHR'), '10000 · ៛10,000');
  assert.equal(M.formatImportCell('bad', 'originalPrincipalMinor', 'USD'), 'bad');
  assert.equal(M.formatImportCell('  ', 'originalPrincipalMinor', 'USD'), '  ');
});

test('responses from a previous company context are discarded', () => {
  assert.equal(M.isImportCompanyCurrent('company-a', 'company-a'), true);
  assert.equal(M.isImportCompanyCurrent('company-a', 'company-b'), false);
});

test('an uncertain import retry keeps the same company, operation ID, and immutable row payload', () => {
  const rows = [{ loanNo: 'L-1', originalPrincipalMinor: 0, rowNo: 7 }];
  const operation = M.makeImportOperation('company-a', rows, 'operation-1');
  rows[0].loanNo = 'changed';
  assert.deepEqual(operation, { companyId: 'company-a', operationId: 'operation-1', rows: [{ loanNo: 'L-1', originalPrincipalMinor: 0, rowNo: 7 }] });
  assert.equal(M.retryImportOperation(operation), operation);
});

test('a validation response with applied false is rejected, never reported as imported', () => {
  assert.equal(M.importApplyOutcome({ applied: true, created: 1, updated: 0, skipped: 0, failed: 0, rows: [] }), 'applied');
  assert.equal(M.importApplyOutcome({ applied: false, created: 0, updated: 0, skipped: 0, failed: 1, rows: [{ rowNo: 2, action: 'error' }] }), 'rejected');
  assert.equal(M.importApplyOutcome(null), 'unknown');
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const workbook = (fileName = 'fresh.xlsx') => ({ fileName, sheets: [{ name: 'Loans', headers: ['loan_no', 'original_principal', 'Other', 'currency'], rowCount: 1,
  rows: [{ loan_no: 'L-1', original_principal: 10000, Other: 5000, currency: 'USD' }] }] });
const preview = (rows) => ({ valid: true, summary: { total: rows.length, create: rows.length, update: 0, skip: 0, error: 0 },
  rows: rows.map((values) => ({ rowNo: values.rowNo, action: 'create', loanId: null, loanNo: values.loanNo, values, warnings: [], errors: [] })) });
const applied = { applied: true, created: 1, updated: 0, skipped: 0, failed: 0, rows: [] };

// Run the actual modal (and optionally its actual parent) with controlled hooks and IPC.
// Instances retain their own hooks, and disappearing/keyed children run effect cleanup.
async function importHarness({ loans = {}, files = {}, parent = false } = {}) {
  const context = { company: 'a', caps: ['loans.manage'], open: true };
  const pending = new Map(), toasts = [], done = [], calls = { apply: [], plan: [], list: [] };
  const instances = new Map();
  let active, tree = [], mounted = true, nextId = 0;
  const element = (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });
  const react = {
    createElement: element, Fragment: 'fragment', useMemo: (fn) => fn(), useCallback: (fn) => fn,
    useState(initial) { const owner = active, i = owner.cursor++; if (!(i in owner.slots)) owner.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [owner.slots[i], (next) => { owner.slots[i] = typeof next === 'function' ? next(owner.slots[i]) : next; }]; },
    useRef(initial) { const i = active.cursor++; return active.slots[i] ||= { current: initial }; },
    useEffect(fn, deps) { const owner = active, i = owner.cursor++, old = owner.slots[i];
      if (!old || deps.some((value, j) => value !== old.deps[j])) { const slot = { deps, cleanup: old?.cleanup }; owner.slots[i] = slot;
        owner.effects.push(() => { slot.cleanup?.(); slot.cleanup = fn(); }); } },
  };
  const ui = Object.fromEntries(['Badge', 'Button', 'Input', 'Select', 'EmptyState', 'Pagination'].map((name) => [name, (props) => ({ type: name.toLowerCase(), props })]));
  ui.Modal = (props) => props.open ? element('modal', props, props.children, props.footer) : null;
  ui.paginate = (length) => ({ currentPage: 0, maxPage: 0, pageStart: 0, pageEnd: length });
  const state = () => ({ activeCompanyId: context.company, addToast: (...args) => toasts.push(args) });
  const store = (select) => select(state()); store.getState = state;
  const loanApi = {
    importColumns: async () => [...columns, { key: 'currency', label: 'Currency' }],
    importPlan: async ({ rows }) => preview(rows), importApply: async () => applied,
    list: async () => [], listEmployees: async () => [], getPolicy: async () => ({}), ...loans,
  };
  for (const [method, key] of [['importPlan', 'plan'], ['importApply', 'apply'], ['list', 'list']]) {
    const fn = loanApi[method]; loanApi[method] = (args) => { calls[key].push(args); return fn(args); };
  }
  const output = await esbuild.build({ entryPoints: [path.join(ROOT, `renderer/modules/People/${parent ? 'Loans' : 'LoansImportModal'}.jsx`)], bundle: true, write: false,
    format: 'cjs', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', banner: { js: 'const React = require("react");' },
    plugins: [{ name: 'boundaries', setup(builder) { builder.onResolve({ filter: /.*/ }, ({ path: name, importer }) => importer && !/\/(?:LoansImportModal\.jsx|loanImportModel\.js|loansModel\.js|capabilities\.js)$/.test(name) ? { path: name, external: true } : undefined); } }],
  });
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, Date, Intl, crypto: { randomUUID: () => `operation-${++nextId}` },
    window: { api: { loans: loanApi, files: { pickWorkbook: async () => 'fresh.xlsx', parseWorkbook: async () => workbook(), ...files } } },
    require(name) {
      if (name === 'react') return react;
      if (name.endsWith('/ui.jsx')) return ui;
      if (name.endsWith('/store/index.js')) return { useAppStore: store };
      if (name.endsWith('/Sidebar.jsx')) return { useUserCaps: () => context.caps };
      if (name.endsWith('/hrHooks.js')) return { useHrTick: () => 0, usePager: () => ({ page: 0, pageSize: 50 }) };
      if (name.endsWith('/PageHeader.jsx')) return { PageHeader: (props) => element('header', {}, props.actions) };
      if (name.endsWith('/LoansModals.jsx')) return { LoansModals: () => null };
      if (name.endsWith('/NoCompanyState.jsx')) return { NoCompanyState: () => null };
      if (name.endsWith('/FuelShared.jsx')) return { LoadError: () => null };
      throw new Error(name);
    },
  });
  const retain = (operation, companyId = operation?.companyId, completed) => {
    if (operation) pending.set(companyId, operation);
    else if (!completed || pending.get(companyId)?.operationId === completed.operationId) pending.delete(companyId);
  };
  function expand(node, seen) {
    if (Array.isArray(node)) return node.flatMap((item) => expand(item, seen));
    if (!node || typeof node !== 'object') return node == null || node === false ? [] : [node];
    if (typeof node.type === 'function') {
      if (['Loans', 'LoansImportModal'].includes(node.type.name)) {
        const key = `${node.type.name}:${node.props.key || ''}`;
        const owner = instances.get(key) || { slots: [], effects: [] }; instances.set(key, owner); seen.add(key);
        const old = active; active = owner; owner.cursor = 0; const value = node.type(node.props); active = old;
        return expand(value, seen);
      }
      return expand(node.type(node.props), seen);
    }
    return [{ ...node, props: { ...node.props, children: expand(node.props.children, seen) } }];
  }
  function render() {
    const seen = new Set();
    tree = mounted ? expand(element(module.exports[parent ? 'Loans' : 'LoansImportModal'], { open: context.open, companyId: context.company,
      pendingOperation: pending.get(context.company), onClose: () => { context.open = false; }, onPendingOperation: retain, onDone: (id) => done.push(id) }), seen) : [];
    for (const [key, owner] of instances) if (!seen.has(key)) { owner.slots.forEach((slot) => slot?.cleanup?.()); instances.delete(key); }
    for (const owner of instances.values()) owner.effects.splice(0).forEach((fn) => fn());
  }
  const settle = async () => { await new Promise(setImmediate); render(); await new Promise(setImmediate); render(); };
  const nodes = () => { const all = []; const visit = (n) => { if (typeof n !== 'object') return; all.push(n); n.props.children.forEach(visit); }; tree.forEach(visit); return all; };
  const text = (n) => typeof n === 'object' ? n.props.children.map(text).join('') : String(n);
  const button = (label) => nodes().find((n) => n.type === 'button' && text(n) === label);
  const select = (label) => nodes().find((n) => n.type === 'select' && n.props['aria-label'] === label);
  const close = () => { nodes().find((n) => n.type === 'modal').props.onClose(); render(); };
  const open = async () => { if (parent) (button('Review and retry the same import') || button('Import opening balances…')).props.onClick(); else context.open = true; render(); await settle(); };
  render(); await settle(); if (parent) await open();
  return { context, calls, toasts, done, pending, nodes, text, button, select, render, settle, close, open,
    unmount: () => { mounted = false; render(); },
    review: async () => { await button('Choose a file…').props.onClick(); render(); await button('Check 1 row').props.onClick(); render(); },
  };
}

test('remapping during preview invalidates the stale result and Apply uses the new reviewed snapshot', async () => {
  const old = deferred(); let count = 0;
  const h = await importHarness({ loans: { importPlan: ({ rows }) => ++count === 1 ? old.promise : Promise.resolve(preview(rows)) } });
  await h.button('Choose a file…').props.onClick(); h.render();
  const remap = h.select('Column for Other').props.onChange;
  const task = h.button('Check 1 row').props.onClick(); h.render();
  // Invoke a captured handler too: disabled controls alone cannot establish correctness.
  remap({ target: { value: 'originalPrincipalMinor' } }); h.render();
  old.resolve(preview(h.calls.plan[0].rows)); await task; h.render();
  assert.equal(h.button('Import 1 row'), undefined);
  await h.button('Check 1 row').props.onClick(); h.render();
  assert.ok(h.nodes().some((n) => h.text(n).includes('$50.00')));
  await h.button('Import 1 row').props.onClick(); h.render();
  assert.equal(h.calls.apply[0].rows[0].originalPrincipalMinor, 5000);
  assert.deepEqual(h.calls.apply[0].rows, h.calls.plan[1].rows);
});

test('Apply sends the immutable reviewed rows even if the parsed workbook changes afterward', async () => {
  const data = workbook();
  const h = await importHarness({ files: { parseWorkbook: async () => data } });
  await h.review();
  data.sheets[0].rows[0].original_principal = 5000;
  h.render();
  await h.button('Import 1 row').props.onClick(); h.render();
  assert.equal(h.calls.apply[0].rows[0].originalPrincipalMinor, 10000);
  assert.equal(Object.isFrozen(h.calls.plan[0].rows), true);
  assert.equal(Object.isFrozen(h.calls.plan[0].rows[0]), true);
});

test('a captured Apply handler cannot submit again after the reviewed batch was rejected', async () => {
  const h = await importHarness({ loans: { importApply: async () => ({ applied: false, created: 0, updated: 0, skipped: 0, failed: 1,
    rows: [{ rowNo: 2, action: 'error', errors: ['Loan changed since preview'] }] }) } });
  await h.review();
  const apply = h.button('Import 1 row').props.onClick;
  await apply(); h.render();
  await apply();
  assert.equal(h.calls.apply.length, 1);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.done, []);
});

test('a captured Apply handler cannot submit a plan invalidated by going Back and remapping', async () => {
  const h = await importHarness(); await h.review();
  const apply = h.button('Import 1 row').props.onClick;
  h.button('Back').props.onClick(); h.render();
  h.select('Column for Other').props.onChange({ target: { value: 'originalPrincipalMinor' } }); h.render();
  await apply(); assert.equal(h.calls.apply.length, 0);
});

for (const delay of ['picker', 'parser']) {
  test(`old ${delay} completion cannot replace a fresh file after Cancel and reopen`, async () => {
    const old = deferred(); let picks = 0;
    const h = await importHarness({ files: {
      pickWorkbook: () => ++picks === 1 && delay === 'picker' ? old.promise : Promise.resolve(picks === 1 ? 'old.xlsx' : 'fresh.xlsx'),
      parseWorkbook: (name) => name === 'old.xlsx' && delay === 'parser' ? old.promise : Promise.resolve(workbook(name)),
    } });
    const task = h.button('Choose a file…').props.onClick(); await h.settle();
    assert.ok(!h.button('Cancel').props.disabled);
    h.button('Cancel').props.onClick(); h.render(); await h.open();
    assert.ok(h.button('Choose a file…') && !h.button('Choose a file…').props.disabled, 'a new opening can choose a fresh file while the old parser is pending');
    await h.button('Choose a file…').props.onClick(); h.render();
    old.resolve(delay === 'picker' ? 'old.xlsx' : workbook('old.xlsx')); await task; h.render();
    assert.ok(h.nodes().some((n) => h.text(n).includes('fresh.xlsx')));
    assert.ok(!h.nodes().some((n) => h.text(n).includes('old.xlsx')));
  });
}

for (const leave of ['revoke', 'unmount', 'A-B-A', 'close-reopen']) {
  test(`Apply completion after ${leave} clears known bookkeeping without stale success callbacks`, async () => {
    const delayed = deferred(); const h = await importHarness({ loans: { importApply: () => delayed.promise } });
    await h.review(); const task = h.button('Import 1 row').props.onClick(); h.render();
    if (leave === 'revoke') { h.context.caps = []; h.render(); }
    if (leave === 'unmount') h.unmount();
    if (leave === 'A-B-A') { h.context.company = 'b'; h.render(); h.context.company = 'a'; h.render(); }
    if (leave === 'close-reopen') { h.close(); await h.open(); }
    delayed.resolve(applied); await task; h.render();
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(h.done, []);
    assert.equal(h.pending.has('a'), false);
  });
}

for (const outcome of ['applied', 'unknown']) {
  test(`actual parent retains only unresolved imports when Apply becomes ${outcome} under revocation`, async () => {
    const delayed = deferred(); const h = await importHarness({ parent: true, loans: { importApply: () => delayed.promise } });
    await h.review(); const task = h.button('Import 1 row').props.onClick(); h.render();
    h.context.caps = []; h.render(); await h.settle();
    const reads = h.calls.list.length;
    if (outcome === 'applied') delayed.resolve(applied); else delayed.reject(new Error('Connection lost'));
    await task; h.render(); await h.settle();
    assert.deepEqual(h.toasts, []);
    assert.equal(h.calls.list.length, reads);
    h.context.caps = ['loans.manage']; h.render(); await h.settle();
    assert.equal(Boolean(h.button('Review and retry the same import')), outcome === 'unknown');
    assert.equal(h.button('Import opening balances…').props.disabled, outcome === 'unknown');
    if (outcome === 'unknown') {
      await h.open(); await h.button('Retry the same import').props.onClick();
      assert.deepEqual(h.calls.apply[0], h.calls.apply[1]);
    }
  });
}

test('late failure from an earlier attempt cannot resurrect an exact batch resolved after reopening', async () => {
  const old = deferred(); let count = 0;
  const h = await importHarness({ parent: true, loans: { importApply: () => ++count === 1 ? old.promise : Promise.resolve(applied) } });
  await h.review(); const task = h.button('Import 1 row').props.onClick(); h.render();
  h.close(); await h.open();
  await h.button('Retry the same import').props.onClick(); h.render();
  assert.deepEqual(h.calls.apply[0], h.calls.apply[1]);
  old.reject(new Error('Original connection lost')); await task; h.render();
  assert.equal(h.button('Review and retry the same import'), undefined);
  assert.equal(h.toasts.length, 1);
});

test('an older settled attempt cannot clear a newer company import barrier', async () => {
  const old = deferred(), newer = deferred(); let count = 0;
  const h = await importHarness({ parent: true, loans: { importApply: () => ++count === 1 ? old.promise : count === 2 ? Promise.resolve(applied) : newer.promise } });
  await h.review(); const first = h.button('Import 1 row').props.onClick(); h.render();
  h.close(); await h.open(); await h.button('Retry the same import').props.onClick(); h.render();
  h.close(); await h.open(); await h.review();
  const next = h.button('Import 1 row').props.onClick(); h.render();
  assert.notEqual(h.calls.apply[0].operationId, h.calls.apply[2].operationId);
  old.resolve(applied); await first; h.render();
  assert.ok(h.button('Review and retry the same import'));
  assert.equal(h.button('Import opening balances…').props.disabled, true);
  newer.reject(new Error('New result unknown')); await next; h.render();
  assert.ok(h.button('Review and retry the same import'));
});

test('unknown Apply survives closing and reopens as an exact retry, never a new batch', async () => {
  let attempts = 0;
  const h = await importHarness({ parent: true, loans: { importApply: async () => {
    if (++attempts === 1) throw new Error('Connection lost');
    return applied;
  } } });
  await h.review(); await h.button('Import 1 row').props.onClick(); h.render();
  h.close(); await h.open();
  assert.equal(h.button('Choose a file…'), undefined);
  await h.button('Retry the same import').props.onClick(); h.render();
  assert.deepEqual(h.calls.apply[0], h.calls.apply[1]);
  assert.equal(h.button('Review and retry the same import'), undefined);
  assert.equal(h.toasts.length, 1);
});

test('late retained preview cannot replace rejection errors from an exact retry', async () => {
  const latePreview = deferred(); let previews = 0, applies = 0;
  const h = await importHarness({ loans: {
    importPlan: ({ rows }) => ++previews === 1 ? Promise.resolve(preview(rows)) : latePreview.promise,
    importApply: async () => {
      if (++applies === 1) throw new Error('Connection lost');
      return { applied: false, created: 0, updated: 0, skipped: 0, failed: 1,
        rows: [{ rowNo: 2, action: 'error', errors: ['Loan changed since preview'] }] };
    },
  } });
  await h.review(); await h.button('Import 1 row').props.onClick(); h.render();
  h.close(); await h.open();
  await h.button('Retry the same import').props.onClick(); h.render();
  latePreview.resolve(preview(h.calls.plan[1].rows)); await h.settle();
  assert.ok(h.nodes().some((n) => h.text(n).includes('Loan changed since preview')));
  assert.equal(h.button('Import 0 rows').props.disabled, true);
});
