const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const React = require('react');
const ROOT = path.join(__dirname, '..');

function load(file, hooks = React) {
  const entry = path.join(ROOT, 'renderer/modules/Kiosk', file);
  assert.ok(fs.existsSync(entry), `${file} must implement kiosk self-service`);
  const out = esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false,
    format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(id => id === 'react' ? hooks : require(id), mod, mod.exports);
  return mod.exports;
}

// Execute the actual components/effects; replace only React's scheduling and IPC.
// This lets tests inspect the render BEFORE effects clean up on a token change.
function harness(file, name, initialProps) {
  const slots = [], effects = [];
  let cursor = 0, props = initialProps, tree;
  const hooks = { ...React,
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect(fn, deps) {
      const i = cursor++, old = slots[i];
      if (!old || deps.some((d, n) => !Object.is(d, old.deps[n]))) {
        effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
    useCallback(fn, deps) {
      const i = cursor++, old = slots[i];
      if (!old || deps.some((d, n) => !Object.is(d, old.deps[n]))) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useReducer(reduce, initial) {
      const [value, set] = hooks.useState(initial);
      return [value, event => set(s => reduce(s, event))];
    },
  };
  const Component = load(file, hooks)[name];
  return {
    render(next = props) { props = next; cursor = 0; tree = Component(props); return tree; },
    effects() { effects.splice(0).forEach(fn => fn()); },
    unmount() { slots.forEach(s => s?.cleanup?.()); },
  };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function textOf(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(' ');
  return textOf(tree.props?.children);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const context = { lang: 'en', sessionToken: 'token-A', employee: { id: 'A', companyId: 'shop' }, onSessionEnded() {} };
const payslip = { id: 'line-A', runId: 'run-A', month: '2026-09', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  payDate: '2026-10-10', status: 'approved', currency: 'USD', netMinor: 12345, paidMinor: 10000, remainingMinor: 2345 };
const loan = { id: 'loan-A', loanNo: 'L001', currency: 'KHR', status: 'active', principalMinor: 400001, interestMinor: 1999 };

function child(tree, name) { return nodes(tree).find(n => n.type?.name === name); }
async function signedInKiosk(t, me) {
  const original = global.window;
  let h;
  t.after(() => { h?.unmount(); global.window = original; });
  const timers = [], listeners = new Map();
  t.mock.method(global, 'setInterval', fn => { timers.push(fn); return timers.length; });
  t.mock.method(global, 'clearInterval', () => {});
  global.window = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {}, api: { kiosk: {
    tiles: async () => [], signIn: async id => ({ sessionToken: `token-${id}`, employee: { id, companyId: 'shop', nameEn: id } }),
    signOut: async () => {}, me,
  } } };
  h = harness('index.jsx', 'Kiosk', { preview: true });
  h.render(); h.effects(); await flush();
  async function signIn(id) {
    child(h.render(), 'TilesScreen').props.onTap({ id, companyId: 'shop', hasPin: true });
    const pin = child(h.render(), 'PinScreen');
    for (const digit of '1234') pin.props.onKey({ type: 'digit', digit });
    child(h.render(), 'PinScreen').props.onKey({ type: 'submit' });
    await flush();
  }
  await signIn('A');
  return { h, signIn, timers, listeners };
}

test('parent My records wiring supplies the real PIN token and renders only its matching employee', async t => {
  const { h } = await signedInKiosk(t, async token => ({ employee: { id: token.slice(-1), companyId: 'shop' } }));
  child(h.render(), 'KioskCamera').props.onViewRecords(); await flush();
  const records = child(h.render(), 'KioskMe');
  assert.equal(records.props.sessionToken, 'token-A');
  assert.equal(records.props.view.employee.id, 'A');
  assert.equal(typeof records.props.onSessionEnded, 'function');
  assert.equal(typeof records.props.isSessionCurrent, 'function');
});

test('parent rejects a delayed My records response after logout and the next PIN login', async t => {
  const pending = deferred();
  const { h, signIn } = await signedInKiosk(t, token => token === 'token-A' ? pending.promise : Promise.resolve({ employee: { id: 'B', companyId: 'shop' } }));
  child(h.render(), 'KioskCamera').props.onViewRecords();
  child(h.render(), 'KioskMe').props.onDone();
  await signIn('B');
  child(h.render(), 'KioskCamera').props.onViewRecords(); await flush();
  pending.resolve({ employee: { id: 'A', companyId: 'shop' } }); await flush();
  const records = child(h.render(), 'KioskMe');
  assert.equal(records.props.view.employee.id, 'B');
  assert.equal(records.props.sessionToken, 'token-B');
});

test('parent discards stale keep-alive revocation without signing out the new person', async t => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const pending = deferred();
  const { h, signIn, timers, listeners } = await signedInKiosk(t, () => pending.promise);
  now += 60001;
  listeners.get('pointerdown')();
  h.render(); timers[1](); // actual parent keep-alive, not loadMe
  child(h.render(), 'KioskCamera').props.onCancel();
  await signIn('B');
  pending.reject(new Error('Your kiosk session has ended.')); await flush();
  assert.ok(child(h.render(), 'KioskCamera'), 'stale rejection must not reset B');
  now += 120001;
  timers[1]();
  assert.ok(child(h.render(), 'TilesScreen'), 'idle still resets the signed-in screen');
});

for (const selected of ['B', 'A']) {
  test(`abandoned PIN success is retired after idle reset and selecting ${selected} without its PIN`, async t => {
    let now = 1000000;
    t.mock.method(Date, 'now', () => now);
    const { h, signIn, timers } = await signedInKiosk(t, async () => { assert.fail('abandoned token must never load records'); });
    child(h.render(), 'KioskCamera').props.onCancel();
    const pending = deferred(), retired = [];
    global.window.api.kiosk.signIn = () => pending.promise;
    global.window.api.kiosk.signOut = async token => retired.push(token);
    await signIn('A');
    h.render(); now += 30001; timers[1]();
    child(h.render(), 'TilesScreen').props.onTap({ id: selected, companyId: 'shop', hasPin: true });
    h.render();
    pending.resolve({ sessionToken: 'abandoned-A', employee: { id: 'A', companyId: 'shop' } });
    await flush();
    assert.ok(child(h.render(), 'PinScreen'), 'a tile selection must still require its own PIN');
    assert.equal(child(h.render(), 'PinScreen').props.person.id, selected);
    assert.deepEqual(retired, ['abandoned-A']);
    assert.equal(child(h.render(), 'KioskMe'), undefined);
  });
}

test('an old PIN rejection cannot clear a later attempt busy state or show its failure', async t => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const { h, signIn, timers } = await signedInKiosk(t, async () => ({}));
  child(h.render(), 'KioskCamera').props.onCancel();
  const a = deferred(), b = deferred();
  global.window.api.kiosk.signIn = id => id === 'A' ? a.promise : b.promise;
  await signIn('A'); h.render(); now += 30001; timers[1]();
  await signIn('B'); h.render();
  a.reject(new Error('Your kiosk session has ended.')); await flush();
  const pin = child(h.render(), 'PinScreen');
  assert.ok(pin, 'B must remain on its PIN attempt');
  assert.equal(pin.props.busy, true);
  assert.equal(pin.props.message, null);
  b.resolve({ sessionToken: 'token-B', employee: { id: 'B', companyId: 'shop' } }); await flush();
  assert.ok(child(h.render(), 'KioskCamera'));
});

function fillRequestForm(h, name) {
  if (name === 'KioskLeaveForm') {
    nodes(h.render()).find(n => n.type === 'button' && n.props['aria-pressed'] === false).props.onClick();
  } else {
    nodes(h.render()).find(n => n.type === 'input' && n.props.type === 'time').props.onChange({ target: { value: '17:00' } });
    nodes(h.render()).find(n => n.type === 'textarea').props.onChange({ target: { value: 'Forgot to clock out' } });
  }
}

for (const name of ['KioskLeaveForm', 'KioskCorrectionForm']) {
  for (const outcome of ['success', 'sessionEnded']) {
    for (const unmount of [true, false]) {
    test(`${name}: delayed ${outcome} after idle logout ${unmount ? 'and unmount' : 'before cleanup'} cannot affect B`, async t => {
      let now = 1000000;
      t.mock.method(Date, 'now', () => now);
      const reads = [], pending = deferred(); let submitted = 0;
      const { h, signIn, timers } = await signedInKiosk(t, async token => {
        reads.push(token);
        return { employee: { id: token.slice(-1), companyId: 'shop' }, leave: [{ leaveTypeId: 'annual', nameEn: 'Annual' }] };
      });
      child(h.render(), 'KioskCamera').props.onViewRecords(); await flush();
      const me = child(h.render(), 'KioskMe');
      me.props[name === 'KioskLeaveForm' ? 'onLeave' : 'onCorrection']();
      const formNode = child(h.render(), name);
      const form = harness('KioskMe.jsx', name, formNode.props);
      form.render(); form.effects(); fillRequestForm(form, name);
      global.window.api.kiosk[name === 'KioskLeaveForm' ? 'requestLeave' : 'requestCorrection'] = args => {
        submitted++; assert.equal(args.sessionToken, 'token-A'); return pending.promise;
      };
      const submission = form.render().props.onSubmit({ preventDefault() {} });
      assert.equal(submitted, 1, 'the request must actually be pending before logout');
      h.render(); now += 120001; timers[1]();
      assert.ok(child(h.render(), 'TilesScreen'));
      if (unmount) form.unmount();
      await signIn('B'); h.render();
      if (outcome === 'success') pending.resolve({});
      else pending.reject(new Error('Your kiosk session has ended.'));
      await submission; await flush();
      assert.ok(child(h.render(), 'KioskCamera'), 'old form must neither sign B out nor open B records');
      assert.deepEqual(reads, ['token-A']);
      if (!unmount) form.unmount();
    });
    }
  }
}

for (const name of ['KioskLeaveForm', 'KioskCorrectionForm']) {
  for (const outcome of ['success', 'sessionEnded', 'error']) {
    test(`${name}: current ${outcome} still reaches its intended callback or visible failure`, async t => {
      const original = global.window;
      t.after(() => { global.window = original; });
      const pending = deferred(); let sent = 0, ended = 0, submitted = 0;
      const form = harness('KioskMe.jsx', name, { ...context,
        view: { employee: context.employee, leave: [{ leaveTypeId: 'annual', nameEn: 'Annual' }] },
        isSessionCurrent: key => key === JSON.stringify(['token-A', 'A', 'shop']),
        onSent: () => sent++, onSessionEnded: () => ended++,
      });
      form.render(); form.effects(); fillRequestForm(form, name);
      global.window = { api: { kiosk: { [name === 'KioskLeaveForm' ? 'requestLeave' : 'requestCorrection']: () => {
        submitted++; return pending.promise;
      } } } };
      const submission = form.render().props.onSubmit({ preventDefault() {} });
      assert.equal(submitted, 1);
      if (outcome === 'success') pending.resolve({});
      else pending.reject(new Error(outcome === 'sessionEnded' ? 'Your kiosk session has ended.' : 'Request dates overlap'));
      await submission;
      assert.equal(sent, outcome === 'success' ? 1 : 0);
      assert.equal(ended, outcome === 'sessionEnded' ? 1 : 0);
      assert.equal(nodes(form.render()).find(n => n.props?.type === 'submit').props.disabled, false);
      if (outcome === 'error') assert.match(textOf(form.render()), /Request dates overlap/);
      form.unmount();
    });
  }

  test(`${name}: unmount alone silences callbacks even while the parent session remains valid`, async t => {
    const original = global.window;
    t.after(() => { global.window = original; });
    for (const failure of [false, true]) {
      const pending = deferred(); let callbacks = 0, submitted = 0;
      const form = harness('KioskMe.jsx', name, { ...context,
        view: { employee: context.employee, leave: [{ leaveTypeId: 'annual', nameEn: 'Annual' }] },
        isSessionCurrent: () => true, onSent: () => callbacks++, onSessionEnded: () => callbacks++,
      });
      form.render(); form.effects(); fillRequestForm(form, name);
      global.window = { api: { kiosk: { [name === 'KioskLeaveForm' ? 'requestLeave' : 'requestCorrection']: () => {
        submitted++; return pending.promise;
      } } } };
      const submission = form.render().props.onSubmit({ preventDefault() {} });
      assert.equal(submitted, 1);
      form.unmount();
      if (failure) pending.reject(new Error('Your kiosk session has ended.'));
      else pending.resolve({});
      await submission;
      assert.equal(callbacks, 0);
    }
  });
}

test('minor money displays USD cents and whole KHR, never invents zero for bad amounts', () => {
  const M = load('kioskPayrollModel.js');
  assert.equal(M.kioskMoney(12345, 'USD'), 'USD 123.45');
  assert.equal(M.kioskMoney(400001, 'KHR'), 'KHR 400,001');
  assert.equal(M.kioskMoney(0, 'USD'), 'USD 0.00');
  for (const [amount, currency] of [[null, 'USD'], [-1, 'USD'], [1.5, 'KHR'], [Number.MAX_SAFE_INTEGER + 1, 'USD'], [100, 'EUR']]) {
    assert.equal(M.kioskMoney(amount, currency), '—');
  }
});

test('private records are inaccessible during render if token, employee or company changes', () => {
  const M = load('kioskPayrollModel.js');
  const key = M.kioskContext(context.sessionToken, context.employee);
  const data = { context: key, payroll: [payslip] };
  assert.equal(M.currentKioskData(data, key), data);
  assert.equal(M.currentKioskData(data, M.kioskContext('token-B', context.employee)), null);
  assert.equal(M.currentKioskData(data, M.kioskContext('token-A', { id: 'B', companyId: 'shop' })), null);
  assert.equal(M.currentKioskData(data, M.kioskContext('token-A', { id: 'A', companyId: 'other' })), null);
  assert.equal(M.currentKioskData(data, M.kioskContext(null, context.employee)), null);
});

test('pagination clamps shrinking lists and respects the 50-row boundary', () => {
  const M = load('kioskPayrollModel.js');
  const rows = Array.from({ length: 51 }, (_, i) => i);
  assert.deepEqual(M.kioskPage(rows, 2, 50), { items: [50], page: 2, pages: 2, from: 51, to: 51, total: 51 });
  assert.deepEqual(M.kioskPage(rows.slice(0, 2), 2, 50), { items: [0, 1], page: 1, pages: 1, from: 1, to: 2, total: 2 });
  assert.equal(M.kioskPage(rows, 1, 25).items.length, 25);
});

test('financial errors are localized by actual cause without exposing private backend text', () => {
  const M = load('kioskPayrollModel.js');
  assert.match(M.kioskPayrollError(new Error('You do not have permission to access payroll or loans'), 'en'), /permission/i);
  assert.match(M.kioskPayrollError(new Error('Approved payslip not found for this session'), 'en'), /available/i);
  assert.match(M.kioskPayrollError(new Error('Failed to fetch'), 'en'), /reach/i);
  for (const lang of ['km', 'en']) {
    const result = M.kioskPayrollError(new Error('SQL secret salary 90000 /Users/private/person.pdf'), lang);
    assert.doesNotMatch(result, /90000|SQL|private|person/);
    if (lang === 'km') assert.match(result, /[ក-៿]/);
  }
});

test('actual My records wiring passes authenticated context and session-ended callback', () => {
  const h = harness('KioskMe.jsx', 'KioskMe', { ...context, view: { employee: context.employee }, status: 'ready' });
  const financial = nodes(h.render()).find(n => n.type?.name === 'KioskPayroll');
  assert.ok(financial, 'payroll must be inside My records');
  assert.equal(financial.props.sessionToken, 'token-A');
  assert.equal(financial.props.employee, context.employee);
  assert.equal(financial.props.onSessionEnded, context.onSessionEnded);
});

test('load uses only token-scoped kiosk APIs, hides drafts and shows separate loan balances', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  const calls = [];
  global.window = { api: { kiosk: {
    payroll: async args => { calls.push(['payroll', args]); return [payslip, { ...payslip, id: 'draft', status: 'draft', netMinor: 999999 }]; },
    loans: async args => { calls.push(['loans', args]); return [loan]; },
  } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', context);
  h.render(); h.effects(); await flush();
  const text = textOf(h.render());
  assert.deepEqual(calls, [['payroll', { sessionToken: 'token-A' }], ['loans', { sessionToken: 'token-A' }]]);
  assert.match(text, /USD 123\.45/); assert.doesNotMatch(text, /9,999\.99/);
  assert.match(text, /KHR 400,001/); assert.match(text, /KHR 1,999/);
  assert.match(text, /KHR 402,000/);
  assert.equal(nodes(h.render()).filter(n => n.type === 'button' && /Download/.test(textOf(n))).length, 1);
  h.unmount();
});

test('a delayed load cannot paint old salary across a render-time token/context change', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  const pending = deferred();
  global.window = { api: { kiosk: { payroll: () => pending.promise, loans: async () => [loan] } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', context);
  h.render(); h.effects();
  const next = { ...context, sessionToken: 'token-B', employee: { id: 'B', companyId: 'other' } };
  h.render(next); // deliberately before cleanup
  pending.resolve([payslip]); await flush();
  assert.doesNotMatch(textOf(h.render(next)), /123\.45|400,001/);
  h.unmount();
});

test('ready salary is hidden immediately when company changes even with the same token', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  global.window = { api: { kiosk: { payroll: async () => [payslip], loans: async () => [] } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', context);
  h.render(); h.effects(); await flush();
  assert.match(textOf(h.render()), /123\.45/);
  assert.doesNotMatch(textOf(h.render({ ...context, employee: { id: 'A', companyId: 'other' } })), /123\.45/);
  h.unmount();
});

test('revocation ends the current parent session but stale failures never end a later one', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  const pending = deferred(); let ended = 0;
  global.window = { api: { kiosk: { payroll: () => pending.promise, loans: async () => [] } } };
  const props = { ...context, onSessionEnded: () => ended++ };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', props);
  h.render(); h.effects();
  pending.reject(new Error('Your kiosk session has ended.')); await flush();
  assert.equal(ended, 1);
  h.unmount();
  const stale = deferred();
  global.window.api.kiosk.payroll = () => stale.promise;
  const other = harness('KioskPayroll.jsx', 'KioskPayroll', props);
  other.render(); other.effects(); other.render({ ...props, sessionToken: 'token-B' });
  stale.reject(new Error('Your kiosk session has ended.')); await flush();
  assert.equal(ended, 1);
  other.unmount();
});

test('PDF save is explicit, token-only and delayed results discarded', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  const pending = deferred(), calls = [];
  global.window = { api: { kiosk: { payroll: async () => [payslip], loans: async () => [],
    savePayslipPdf: args => { calls.push(args); return pending.promise; } } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', context);
  h.render(); h.effects(); await flush();
  assert.equal(calls.length, 0, 'loading never exports');
  const button = nodes(h.render()).find(n => n.type === 'button' && /Download/.test(textOf(n)));
  const saving = button.props.onClick();
  assert.deepEqual(calls, [{ sessionToken: 'token-A', id: 'line-A' }]);
  h.render({ ...context, sessionToken: 'token-B' });
  pending.resolve('/Users/private/Salary-A.pdf'); await saving; await flush();
  assert.doesNotMatch(textOf(h.render()), /Saved|Salary-A|123\.45|private/);
  h.unmount();
});

test('pagination controls render 50 rows, navigate to the remainder and reset on size change', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  global.window = { api: { kiosk: {
    payroll: async () => Array.from({ length: 51 }, (_, n) => ({ ...payslip, id: `line-${n}` })),
    loans: async () => [],
  } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', context);
  h.render(); h.effects(); await flush();
  const downloads = tree => nodes(tree).filter(n => n.type === 'button' && /Download/.test(textOf(n)));
  assert.equal(downloads(h.render()).length, 50);
  let pagination = nodes(h.render()).find(n => n.type?.name === 'KioskFinancialPagination' && n.props.title === 'payroll_title');
  let controls = pagination.type(pagination.props);
  assert.match(textOf(controls), /Showing 1–50 of 51.*Page 1 of 2/);
  nodes(controls).find(n => n.type === 'button' && textOf(n) === 'Next').props.onClick();
  assert.equal(downloads(h.render()).length, 1);
  pagination = nodes(h.render()).find(n => n.type?.name === 'KioskFinancialPagination' && n.props.title === 'payroll_title');
  controls = pagination.type(pagination.props);
  nodes(controls).find(n => n.type === 'select').props.onChange({ target: { value: '25' } });
  assert.equal(downloads(h.render()).length, 25);
  pagination = nodes(h.render()).find(n => n.type?.name === 'KioskFinancialPagination' && n.props.title === 'payroll_title');
  assert.equal(pagination.props.page.page, 1);
  h.unmount();
});

test('independent read failures keep the available section and display a safe localized cause', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  global.window = { api: { kiosk: { payroll: async () => [payslip],
    loans: async () => { throw new Error('Failed to fetch /Users/private/balance-50000'); } } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', context);
  h.render(); h.effects(); await flush();
  assert.match(textOf(h.render()), /123\.45/);
  assert.match(textOf(h.render()), /reach/);
  assert.doesNotMatch(textOf(h.render()), /private|50000|No loans/);
  assert.match(textOf(h.render({ ...context, lang: 'km' })), /[ក-៿]/);
  h.unmount();
});

test('late reads after unmount cannot set private data or invoke session-ended', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  const payroll = deferred(), loans = deferred(); let ended = 0;
  global.window = { api: { kiosk: { payroll: () => payroll.promise, loans: () => loans.promise } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', { ...context, onSessionEnded: () => ended++ });
  h.render(); h.effects(); h.unmount();
  payroll.resolve([payslip]); loans.reject(new Error('Your kiosk session has ended.')); await flush();
  assert.doesNotMatch(textOf(h.render()), /123\.45/);
  assert.equal(ended, 0);
});

test('save cancellation is quiet, repeated taps cannot export twice, and live revocation clears amounts', async t => {
  const original = global.window;
  t.after(() => { global.window = original; });
  let result = deferred(), calls = 0, ended = 0;
  global.window = { api: { kiosk: { payroll: async () => [payslip], loans: async () => [loan],
    savePayslipPdf: () => { calls++; return result.promise; } } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', { ...context, onSessionEnded: () => ended++ });
  h.render(); h.effects(); await flush();
  let button = nodes(h.render()).find(n => n.type === 'button' && /Download/.test(textOf(n)));
  const saving = button.props.onClick();
  button.props.onClick(); assert.equal(calls, 1);
  result.resolve(null); await saving;
  assert.doesNotMatch(textOf(h.render()), /saved\./i);
  result = deferred();
  button = nodes(h.render()).find(n => n.type === 'button' && /Download/.test(textOf(n)));
  const revoked = button.props.onClick();
  result.reject(new Error('Your kiosk session has ended.')); await revoked;
  assert.equal(ended, 1);
  assert.doesNotMatch(textOf(h.render()), /123\.45|400,001/);
  h.unmount();
});

test('save failures identify disk/folder causes without echoing the chosen path', async t => {
  const M = load('kioskPayrollModel.js');
  assert.match(M.kioskPayrollError(new Error('ENOSPC /Users/private'), 'en', true), /Storage is full/);
  assert.match(M.kioskPayrollError(new Error('EACCES: permission denied /Users/private'), 'en', true), /Cannot write/);
  const original = global.window;
  t.after(() => { global.window = original; });
  global.window = { api: { kiosk: { payroll: async () => [payslip], loans: async () => [],
    savePayslipPdf: async () => { throw new Error('ENOSPC /Users/private/Salary.pdf'); } } } };
  const h = harness('KioskPayroll.jsx', 'KioskPayroll', context);
  h.render(); h.effects(); await flush();
  const button = nodes(h.render()).find(n => n.type === 'button' && /Download/.test(textOf(n)));
  await button.props.onClick();
  assert.match(textOf(h.render()), /Storage is full/);
  assert.doesNotMatch(textOf(h.render()), /private|Salary\.pdf/);
  assert.equal(nodes(h.render()).find(n => n.type === 'button' && /Download/.test(textOf(n))).props.disabled, false);
  h.unmount();
});
