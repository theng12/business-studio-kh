const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { runInNewContext } = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const testUrl = require('node:url').pathToFileURL(__filename);
let model, endOfMonth, filterLoans, formatMinor, makeOperation,
  pendingAfterFailure, parseMinorInput, requestIsCurrent, totalsByCurrency;
test.before(async () => {
  model = await import('../renderer/modules/People/loansModel.js');
  ({ endOfMonth, filterLoans, formatMinor, makeOperation, pendingAfterFailure,
    parseMinorInput, requestIsCurrent, totalsByCurrency } = model);
});

test('previous-month prefills use calendar months on day one and across the year boundary', () => {
  assert.equal(model.previousMonth('2026-10-01'), '2026-09');
  assert.equal(model.previousMonth('2026-10-31'), '2026-09');
  assert.equal(model.previousMonth('2026-01-01'), '2025-12');
  assert.throws(() => model.previousMonth('bad-date'));
});

async function loansHarness() {
  const state = [], refs = [], calls = [];
  let cursor = 0, refCursor = 0, tree;
  const context = { company: 'a', caps: ['loans.manage'] };
  const loan = { id: 'loan-a', companyId: 'a', status: 'draft', loanNo: 'LN-A', currency: 'USD', originalPrincipalMinor: 50000, installmentMinor: 2500, principalMinor: 0, interestMinor: 0, entries: [] };
  const initial = { 0: { companyId: 'a', loans: [loan], employees: [], policy: {} }, 3: 'all', 5: { companyId: 'a', id: loan.id }, 6: { key: 'a|loan-a', loan, loading: false } };
  const element = (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children.length ? children : props?.children } });
  const react = {
    createElement: element, Fragment: 'fragment', useEffect() {}, useMemo: (fn) => fn(),
    useState(value) { const i = cursor++; if (!(i in state)) state[i] = initial[i] ?? (typeof value === 'function' ? value() : value); return [state[i], (next) => { state[i] = typeof next === 'function' ? next(state[i]) : next; }]; },
    useRef(value) { return refs[refCursor++] ||= { current: value }; },
  };
  const ui = Object.fromEntries(['Badge', 'Button', 'Input', 'Select', 'EmptyState', 'Pagination'].map((name) => [name, (props) => element(name.toLowerCase(), props)]));
  ui.paginate = (length) => ({ pageStart: 0, pageEnd: length, currentPage: 1, maxPage: 1 });
  const store = (select) => select({ activeCompanyId: context.company, addToast() {} });
  store.getState = () => ({ activeCompanyId: context.company });
  const result = await build({ entryPoints: [new URL('../renderer/modules/People/Loans.jsx', testUrl).pathname], bundle: true, write: false, format: 'cjs', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', banner: { js: 'const React = require("react");' }, plugins: [{ name: 'boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, importer }) => importer && !/\/(?:loansModel|loanPending)\.js$/.test(path) ? { path, external: true } : undefined);
  } }] });
  const module = { exports: {} };
  const saved = new Map();
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Date, Intl, structuredClone, crypto: { randomUUID: () => 'operation-1' }, window: { localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) }, api: { loans: { voidDraft: async (args) => { calls.push(args); return loan; } } } }, require(path) {
    if (path === 'react') return react;
    if (path.endsWith('/ui.jsx')) return ui;
    if (path.endsWith('/store/index.js')) return { useAppStore: store };
    if (path.endsWith('/Sidebar.jsx')) return { useUserCaps: () => context.caps };
    if (path.endsWith('/capabilities.js')) return { hasCap: (caps, cap) => caps.includes('*') || caps.includes(cap) };
    if (path.endsWith('/hrHooks.js')) return { useHrTick: () => 0, usePager: () => ({ page: 0, pageSize: 50 }) };
    if (path.endsWith('/PageHeader.jsx')) return { PageHeader: (props) => element('header', {}, props.actions) };
    if (path.endsWith('/LoansModals.jsx')) return { LoansModals: (props) => element('loans-modals', props) };
    if (path.endsWith('/LoansImportModal.jsx')) return { LoansImportModal: () => null };
    if (path.endsWith('/NoCompanyState.jsx')) return { NoCompanyState: () => null };
    if (path.endsWith('/FuelShared.jsx')) return { LoadError: () => null };
    throw new Error(path);
  } });
  const expand = (node) => Array.isArray(node) ? node.flatMap(expand) : !node || typeof node !== 'object' ? node == null ? [] : [node] : typeof node.type === 'function' ? expand(node.type(node.props)) : [{ ...node, props: { ...node.props, children: expand(node.props.children) } }];
  const nodes = () => { const all = []; const visit = (n) => { if (typeof n !== 'object') return; all.push(n); n.props.children?.forEach(visit); }; tree.forEach(visit); return all; };
  const text = (n) => typeof n === 'object' ? n.props.children.map(text).join('') : String(n);
  const render = () => { cursor = 0; refCursor = 0; tree = expand(module.exports.Loans()); };
  render();
  return { context, calls, render, nodes, button: (label) => nodes().find((n) => n.type === 'button' && text(n) === label), modal: () => nodes().find((n) => n.type === 'loans-modals') };
}

test('loans.manage may cancel a draft and keeps the draft bound to its company before effects', async () => {
  const h = await loansHarness();
  assert.ok(h.button('Cancel draft…'));
  h.button('Cancel draft…').props.onClick(); h.render();
  const oldModal = h.modal().props;
  assert.equal(oldModal.dialog.companyId, 'a');
  h.context.company = 'b'; h.render();
  assert.equal(h.modal().props.dialog, null);
  assert.equal(await oldModal.onSubmit('voidDraft', { id: 'loan-a', reason: 'mistake' }, 'a'), false);
  assert.equal(h.calls.length, 0);
});

test('a loan dialog submits its bound company and rejects stale callbacks after permission loss', async () => {
  const h = await loansHarness();
  h.context.caps = ['*']; h.render();
  h.button('Cancel draft…').props.onClick(); h.render();
  const oldModal = h.modal().props;
  assert.equal(await oldModal.onSubmit('voidDraft', { id: 'loan-a', reason: 'mistake' }, 'a'), true);
  assert.equal(h.calls[0].companyId, 'a');
  h.context.caps = []; h.render();
  assert.equal(await oldModal.onSubmit('voidDraft', { id: 'loan-a', reason: 'another' }, 'a'), false);
  assert.equal(h.calls.length, 1);
});

test('parses whole minor units strictly for USD and KHR', () => {
  assert.equal(parseMinorInput('12.34', 'USD'), 1234);
  assert.equal(parseMinorInput('12', 'KHR'), 12);
  for (const [value, currency] of [['1.234', 'USD'], ['1.2', 'KHR'], ['1e2', 'USD'], ['-1', 'USD'], ['', 'USD'], ['90071992547410', 'USD']]) {
    assert.throws(() => parseMinorInput(value, currency));
  }
});

test('formats amounts without mixing currencies and returns only whole major units for KHR', () => {
  assert.equal(formatMinor(1234, 'USD'), '$12.34');
  assert.equal(formatMinor(50000, 'USD'), '$500.00');
  assert.equal(formatMinor(1200, 'KHR'), '៛1,200');
  assert.throws(() => formatMinor(Number.MAX_SAFE_INTEGER + 1, 'USD'));
});

test('actual loan approval modal keeps the formatter fix and hides a different company before effects', async () => {
  const result = await build({ entryPoints: [new URL('../renderer/modules/People/LoansModals.jsx', testUrl).pathname], bundle: true, write: false, format: 'cjs', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', banner: { js: 'const React = require("react");' }, plugins: [{ name: 'boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, importer }) => importer && !path.endsWith('loansModel.js') ? { path, external: true } : undefined);
  } }] });
  const ui = Object.fromEntries(['Badge', 'Button', 'Input', 'Select', 'Textarea'].map((name) => [name, ({ children }) => React.createElement('span', null, children)]));
  ui.Modal = ({ title, children, footer }) => React.createElement('section', null, title, children, footer);
  ui.Field = ({ children }) => children({ id: React.useId() });
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Date, Intl, require: (path) => path === 'react' ? React : ui });
  const dialog = { type: 'approve', companyId: 'a', loan: { id: 'loan-a', companyId: 'a', loanNo: 'LN-A', currency: 'USD', originalPrincipalMinor: 50000, installmentMinor: 2500, interestMethod: 'none' } };
  const html = (companyId) => renderToStaticMarkup(React.createElement(module.exports.LoansModals, { dialog, companyId, employees: [] }));
  assert.match(html('a'), /Principal: .*\$500\.00/);
  assert.match(html('a'), /Monthly instalment: .*\$25\.00/);
  assert.equal(html('b'), '');
});

test('filters by status and searchable staff and loan fields', () => {
  const loans = [
    { id: 'a', employeeId: 'e1', status: 'active', loanNo: 'LN-1', currency: 'USD' },
    { id: 'b', employeeId: 'e2', status: 'draft', loanNo: 'LN-2', currency: 'KHR' },
  ];
  const staff = new Map([['e1', { nameEn: 'Dara Sok' }], ['e2', { nameKm: 'សុខ' }]]);
  assert.deepEqual(filterLoans(loans, { status: 'active', search: 'dara' }, staff), [loans[0]]);
  assert.deepEqual(filterLoans(loans, { status: 'all', search: 'ln-2' }, staff), [loans[1]]);
});

test('totals remain separated by currency', () => {
  assert.deepEqual(totalsByCurrency([
    { currency: 'USD', principalMinor: 1000, interestMinor: 200 },
    { currency: 'USD', principalMinor: 300, interestMinor: 50 },
    { currency: 'KHR', principalMinor: 4000, interestMinor: 100 },
  ]), {
    USD: { principalMinor: 1300, interestMinor: 250, totalMinor: 1550 },
    KHR: { principalMinor: 4000, interestMinor: 100, totalMinor: 4100 },
  });
});

test('month-end projection date validates the month', () => {
  assert.equal(endOfMonth('2024-02'), '2024-02-29');
  assert.equal(endOfMonth('2026-10'), '2026-10-31');
  assert.throws(() => endOfMonth('2026-13'));
});

test('uncertain mutation retry retains its exact company, operation id and payload', () => {
  const payload = { id: 'loan-1', amountMinor: 2500, entryDate: '2026-10-09', source: 'cash' };
  const command = makeOperation('repay', 'company-a', 'operation-1', payload);
  assert.deepEqual(makeOperation('repay', 'company-a', 'operation-1', payload), command);
  assert.deepEqual(command.payload, payload);
  assert.notEqual(command.payload, payload);
  assert.equal(command.operationId, 'operation-1');
  assert.equal(command.companyId, 'company-a');
  assert.equal(pendingAfterFailure(command, new Error('Connection closed')), command);
});

test('definite IPC rejections release the pending key so a corrected payload can be submitted', () => {
  const command = makeOperation('repay', 'company-a', 'operation-1', { id: 'loan-1', amountMinor: 2500 });
  assert.equal(pendingAfterFailure(command, new Error('Bad request: Repayment exceeds outstanding debt (overpayment)')), null);
  assert.equal(pendingAfterFailure(command, new Error("Error invoking remote method 'loans:repay': Error: Bad request: Future financial postings are not supported")), null);
  assert.equal(pendingAfterFailure(command, new Error('You do not have permission to access payroll or loans')), null);
  assert.equal(pendingAfterFailure(command, new Error('Timed out waiting for the server')), command);
});

test('the actual repayment allocator overpayment is a definite rejection unless the RPC outcome is unknown', () => {
  const command = makeOperation('repay', 'company-a', 'operation-1', { id: 'loan-1', amountMinor: 50001 });
  let failure;
  try { require('../main/util/loanCalc').allocateRepayment({ principalMinor: 50000, interestMinor: 0, amountMinor: 50001 }); }
  catch (error) { failure = error; }
  assert.equal(failure.message, 'Repayment exceeds outstanding debt (overpayment)');
  assert.equal(pendingAfterFailure(command, failure), null);
  assert.equal(pendingAfterFailure(command, new Error(`Error invoking remote method 'loans:repay': Error: ${failure.message}`)), null);
  assert.equal(pendingAfterFailure(command, Object.assign(new Error(failure.message), { code: 'RPC_OUTCOME_UNKNOWN' })), command);
  assert.equal(pendingAfterFailure(command, new Error(`${failure.message}; operation may still have completed`)), command);
  assert.equal(pendingAfterFailure(command, new Error(`Unconfirmed: ${failure.message}`)), command);
});

test('late results are accepted only for the current request and company', () => {
  assert.equal(requestIsCurrent({ requestId: 8, currentRequestId: 8, companyId: 'a', activeCompanyId: 'a' }), true);
  assert.equal(requestIsCurrent({ requestId: 7, currentRequestId: 8, companyId: 'a', activeCompanyId: 'a' }), false);
  assert.equal(requestIsCurrent({ requestId: 8, currentRequestId: 8, companyId: 'a', activeCompanyId: 'b' }), false);
});
