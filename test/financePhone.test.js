/**
 * Finance on the phone page (`/f`): the expense flow's pure helpers in
 * webclient/fuel/logic.js and the wiring in app.js — money, branch scope,
 * capability visibility, the stable draft id, and the guard that keeps a
 * draft from crossing an account or company.
 * Plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../webclient/fuel/logic.js');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'webclient/fuel/app.js'), 'utf8');

/* ── money ───────────────────────────────────────────────────────── */

test('dollars become exact cents, riel stay whole', () => {
  assert.deepEqual(L.parseAmount('10', 'USD'), { ok: true, minor: 1000 });
  assert.deepEqual(L.parseAmount('10.25', 'USD'), { ok: true, minor: 1025 });
  assert.deepEqual(L.parseAmount('0.07', 'USD'), { ok: true, minor: 7 });
  assert.deepEqual(L.parseAmount('12.30', 'USD'), { ok: true, minor: 1230 });
  assert.deepEqual(L.parseAmount('4000', 'KHR'), { ok: true, minor: 4000 });
  // Riel are whole: 12.5 riel is not a thing.
  assert.deepEqual(L.parseAmount('12.5', 'KHR'), { ok: false, reason: 'whole' });
});

test('a cent is never lost to a floating point round trip', () => {
  // 0.1 + 0.2 = 0.30000000000000004 in a float; parsed as text it is exact.
  assert.equal(L.parseAmount('0.1', 'USD').minor + L.parseAmount('0.2', 'USD').minor, 30);
  assert.deepEqual(L.parseAmount('1.005', 'USD'), { ok: false, reason: 'cents' });
  assert.equal(L.parseAmount('19.99', 'USD').minor, 1999);
  assert.equal(L.parseAmount('0.01', 'USD').minor, 1);
});

test('a bad amount says why, and never becomes zero money', () => {
  assert.deepEqual(L.parseAmount('', 'USD'), { ok: false, reason: 'empty' });
  assert.deepEqual(L.parseAmount('abc', 'USD'), { ok: false, reason: 'format' });
  assert.deepEqual(L.parseAmount('-5', 'USD'), { ok: false, reason: 'format' });
  assert.deepEqual(L.parseAmount('0', 'USD'), { ok: false, reason: 'zero' });
  assert.deepEqual(L.parseAmount('0.00', 'USD'), { ok: false, reason: 'zero' });
  assert.deepEqual(L.parseAmount('0', 'KHR'), { ok: false, reason: 'zero' });
  // Thousands separators are a typing habit, not an error.
  assert.equal(L.parseAmount('1,250.50', 'USD').minor, 125050);
});

/* ── branch scope ────────────────────────────────────────────────── */

test('the branches an account may record on come from the context, narrowed by recordBranchIds', () => {
  const ctx = {
    branches: [
      { id: 'north', nameEn: 'North', status: 'active' },
      { id: 'south', nameEn: 'South', status: 'active' },
      { id: 'old', nameEn: 'Old', status: 'closed' },
    ],
    recordBranchIds: ['north'],
  };
  assert.deepEqual(L.scopeBranches(ctx).map((b) => b.id), ['north']);
  // The owner (recordBranchIds null) may use every open branch.
  assert.deepEqual(L.scopeBranches({ ...ctx, recordBranchIds: null }).map((b) => b.id), ['north', 'south']);
  // No context at all: nothing to record on.
  assert.deepEqual(L.scopeBranches(null), []);
});

test('a branch is defaulted only when there is exactly one', () => {
  assert.equal(L.defaultBranchId([{ id: 'north' }]), 'north');
  assert.equal(L.defaultBranchId([{ id: 'north' }, { id: 'south' }]), '');
  assert.equal(L.defaultBranchId([]), '');
  assert.equal(L.defaultBranchId(null), '');
});

/* ── capability visibility ───────────────────────────────────────── */

test('the phone riel minimum matches the desktop rule', () => {
  assert.equal(L.minKhrMinorForCent(4100), 21, 'ceil(4100/200) — the financeModel.js formula');
  assert.equal(L.minKhrMinorForCent(0), null);
  assert.equal(L.minKhrMinorForCent(null), null);
});

test('Finance capabilities decide what the phone offers', () => {
  const rec = L.pageAccess(['finance.record']);
  assert.equal(rec.finance, true, 'a recorder gets the expense form');
  assert.equal(rec.any, true, 'a finance-only phone is a phone');

  const view = L.pageAccess(['finance.view']);
  assert.equal(view.finance, false, 'a viewer cannot record');
  assert.equal(view.any, false, 'and the phone offers them nothing to record');

  // The owner ('*') may do both.
  const owner = L.pageAccess(['*']);
  assert.equal(owner.finance, true);

  // An attendance-only or fuel-only phone sees no Finance at all.
  assert.equal(L.pageAccess(['attendance.self']).finance, false);
  assert.equal(L.pageAccess(['fuel.record']).finance, false);
  assert.equal(L.pageAccess(['finance.record']).finance, true);
});

test('only an account with a Finance capability asks for the finance context', () => {
  const finance = L.bootReads(L.pageAccess(['finance.record'])).map((r) => r[0]);
  assert.ok(finance.includes('finance:context'), 'the context is read at boot');
  const fuel = L.bootReads(L.pageAccess(['fuel.record'])).map((r) => r[0]);
  assert.ok(!fuel.includes('finance:context'), 'a fuel-only phone must not call it');
  const att = L.bootReads(L.pageAccess(['attendance.self'])).map((r) => r[0]);
  assert.ok(!att.includes('finance:context'));
  // The context is asked for with an empty object (the validator wants that).
  const ctx = L.bootReads(L.pageAccess(['finance.record'])).find((r) => r[0] === 'finance:context');
  assert.deepEqual(ctx[1], {});
});

/* ── the form's wiring (app.js) ──────────────────────────────────── */

test('the expenses tile appears only with a Finance capability', () => {
  assert.match(app, /if \(A\.finance\) \{\s*\n\s*more\.push\(homeTile\('expenses'/);
  assert.match(app, /homeTile\('expenses', 'cash', tr\('home_expenses'\), tr\('home_expenses_sub'\), showExpenseForm\)/);
  assert.match(app, /'data-expense-field': name/);
  assert.match(app, /'data-expense-field': 'expenseDate'/);
  assert.match(app, /pick\('exp_branch', 'branchId'/);
  assert.match(app, /pick\('exp_account', 'accountId'/);
  assert.match(app, /pick\('exp_category', 'categoryId'/);
  assert.match(app, /text\('exp_amount', 'amount', 'amountText'/);
  assert.match(app, /text\('exp_memo', 'memo', 'memo'/);
  assert.match(app, /'data-expense-submit': '1'/);
  assert.match(app, /'data-expense-save-draft': '1'/);
});

test('the receipt photo uses the existing camera picker and the shrink on the phone', () => {
  assert.match(app, /type: 'file', accept: 'image\/\*', capture: 'environment'/);
  assert.match(app, /shrinkPhoto\(file\)/);
  // The bytes travel as the existing binary RPC envelope.
  assert.match(app, /bytes: \{ __bin: true, b64: d\.photo\.b64 \}/);
  assert.match(app, /originalName: d\.photo\.name/);
});

test('the draft id is made once and reused, so a retry cannot record twice', () => {
  assert.match(app, /id: L\.uuid\(\)/);
  // The submit uses the id the server handed back, never a fresh one.
  assert.match(app, /rpc\('finance:submit', \{ id: d\.serverId \|\| d\.id \}\)/);
  // The draft survives a failed photo upload, so the person can retry.
  assert.match(app, /d\.photoError = true;\s*writeDraft\(d\);/);
  // A photo that failed to upload never blocks the record itself.
  assert.match(app, /if \(!d\.photo\) return submit \? submitDraft\(d\) : null;/);
});

test('a draft is saved first and recorded on an explicit second step', () => {
  // Save draft is its own call; Record expense saves, uploads and then submits.
  assert.match(app, /rpc\('finance:saveDraft', draftArgs\(d\)\)/);
  assert.match(app, /rpc\('finance:setReceipt'/);
  assert.match(app, /rpc\('finance:submit'/);
  // The order: the receipt is uploaded before the submit.
  const saveAt = app.indexOf("rpc('finance:saveDraft'");
  const receiptAt = app.indexOf("rpc('finance:setReceipt'");
  const submitAt = app.indexOf("rpc('finance:submit'");
  assert.ok(saveAt < receiptAt && receiptAt < submitAt, 'save → receipt → submit');
});

test('the result says plainly whether it is recorded, awaiting approval, or still a draft', () => {
  assert.match(app, /'data-expense-result': 'posted'/);
  assert.match(app, /'data-expense-result': 'pending'/);
  assert.match(app, /tr\('exp_recorded'\)/);
  assert.match(app, /tr\('exp_pending'\)/);
  assert.match(app, /tr\('exp_draft_result'\)/);
});

test('a draft never crosses an account or a company', () => {
  // The stored draft carries both, and is refused if either differs.
  assert.match(app, /if \(!d \|\| d\.companyId !== S\.companyId\) return null;/);
  assert.match(app, /if \(d\.userId !== \(S\.user && S\.user\.id\)\) return null;/);
  // Switching company or signing out drops the draft.
  assert.match(app, /function switchCompany\(id\) \{[\s\S]{0,140}clearDraft\(\);/);
  assert.match(app, /function signOut\(\) \{[\s\S]{0,300}clearDraft\(\);/);
  assert.match(app, /function readDraft\(\) \{[\s\S]{0,220}d\.companyId !== S\.companyId/);
  assert.match(app, /d\.userId !== \(S\.user && S\.user\.id\)/);
});

test('no offline queue: an expense is submitted online or not at all', () => {
  // The outbox (IndexedDB, offline sends) is for fuel and attendance only.
  assert.doesNotMatch(app, /outbox\.add\(\{[\s\S]{0,400}finance:/);
  const outboxAdds = [...app.matchAll(/outbox\.add\(\{\s*channel: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(!outboxAdds.some((c) => c.startsWith('finance:')), 'no finance item is queued offline');
});

test('the accounts a branch may pay from are its own and the company-wide banks', () => {
  assert.match(app, /return all\.filter\(function \(a\) \{ return a\.branchId == null \|\| a\.branchId === branchId; \}\);/);
  // An account of another branch is dropped when the branch changes.
  assert.match(app, /if \(d\.accountId && !finAccounts\(d\.branchId\)\.some\(function \(a\) \{ return a\.id === d\.accountId; \}\)\) d\.accountId = '';/);
});

test('the threshold above which an expense waits for the owner is shown', () => {
  assert.match(app, /approvalThresholdMinor/);
  assert.match(app, /'data-expense-above-limit': '1'/);
  // A riel amount is compared at the company rate, not warned about blindly.
  assert.match(app, /p\.minor > limit \* rate \/ 100/);
});

test('the missing-fields banner speaks, and sub-cent riel is refused before Record', () => {
  const src = app.slice(app.indexOf('  function draftMissing(d)'), app.indexOf('  function showExpenseForm()'));
  const draftMissing = new Function('L', 'tr', 'finCtx', 'finAccounts', 'byId', `${src}\nreturn draftMissing;`)(
    L,
    (k, vars) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
    () => ({ rate: { khrPerUsd: 4100 } }),
    () => [{ id: 'a1', currency: 'KHR' }],
    (list, id2) => list.find((x) => x.id === id2),
  );
  const base = { branchId: 'b1', accountId: 'a1', categoryId: 'c1', currency: 'KHR' };
  assert.deepEqual(draftMissing({ ...base, amountText: '21' }), [], '21 riel is one US cent at 4100');
  const small = draftMissing({ ...base, amountText: '20' });
  assert.ok(small.some((m) => m.startsWith('exp_amount_min')), '20 riel says the minimum before Record');
  const noBranch = draftMissing({ ...base, branchId: '', amountText: '100' });
  assert.equal(noBranch.length, 1);
  assert.ok(!noBranch.includes('exp_need_branch'), 'the banner never shows a raw key');
  assert.ok(noBranch[0].startsWith('exp_need:'));
});

test('switching currency on the phone clears an account and amount of the other currency', () => {
  const seg = app.slice(app.indexOf("'data-expense-currency': c"), app.indexOf("nodes.push(h('div', { class: 'stack' }, rows.flat()));"));
  assert.match(seg, /d\.accountId = ''/);
  assert.match(seg, /d\.amountText = ''/);
});

test('the phone result shows the rate actually used', () => {
  assert.match(app, /e\.fxKhrPerUsd != null/, 'the row field is fxKhrPerUsd, never fxRate');
  assert.match(app, /exp_rate_used/);
  assert.match(app, /L\.formatMoney\(e\.usdMinor, 'USD'\)/);
});

test('receipt bytes survive a draft reload and storage failure stays visible', () => {
  const source = app.slice(app.indexOf('var expenseDraft = null;'), app.indexOf('  function clearDraft()'));
  let stored = null; let refuse = false;
  const warnings = [];
  const storage = { getItem: () => stored, setItem: (_key, value) => { if (refuse) throw new Error('quota'); stored = value; }, removeItem: () => { stored = null; } };
  const load = () => new Function('window', 'S', 'LS', 'lsGet', 'toast', 'tr', source + '\nreturn { readDraft, writeDraft };')(
    { localStorage: storage }, { companyId: 'co', user: { id: 'user' } }, { expense: 'draft' }, () => stored, v => warnings.push(v), v => v,
  );
  const photo = { name: 'receipt.jpg', b64: Buffer.from([0, 255, 32, 16]).toString('base64') };
  load().writeDraft({ companyId: 'co', userId: 'user', photo });
  assert.deepEqual(load().readDraft().photo, photo, 'fresh page restores exact binary envelope');
  refuse = true;
  const page = load();
  page.writeDraft({ companyId: 'co', userId: 'user', memo: 'kept in memory', photo });
  assert.equal(page.readDraft().memo, 'kept in memory');
  assert.deepEqual(warnings, ['storage_warning']);
});

test('phone submission errors render again and lost replies reuse the server state', () => {
  assert.ok(app.indexOf('if (screen.error) { render(); return; }', app.indexOf('function saveDraft')) < app.indexOf('if (submit) return;', app.indexOf('function saveDraft')));
  assert.match(app, /rpc\('finance:get', d\.serverId\)/);
  assert.match(app, /expense\.status === 'draft' \? rpc\('finance:saveDraft'/);
});

test('the expense form mounts real controls using the phone DOM helper', () => {
  class Element {
    constructor() { this.attrs = {}; this.children = []; }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener() {}
    appendChild(child) {
      assert.ok(child instanceof Element, 'appendChild requires a DOM node');
      this.children.push(child);
    }
  }
  const document = { createElement: () => new Element(), createTextNode: () => new Element() };
  let mounted;
  const code = app.slice(app.indexOf('  function h('), app.indexOf('  function svg('))
    + app.slice(app.indexOf('  function renderExpenseForm()'), app.indexOf('  /** Save the draft, upload'));
  new Function('env', `const { document, screen, L, setTitle, tr, finBranches, finAccounts, finCategories, finCtx, mount } = env;
    ${code}\nrenderExpenseForm();`)(
    { document, screen: { draft: { currency: 'USD', amountText: '1.00' } }, L, setTitle: () => {}, tr: v => v,
      finBranches: () => [{ id: 'branch', nameEn: 'Branch' }], finAccounts: () => [], finCategories: () => [],
      finCtx: () => ({ settings: { approvalThresholdMinor: 10000 } }), mount: nodes => { mounted = nodes; } },
  );
  const all = [];
  function visit(node) { all.push(node); node.children.forEach(visit); }
  mounted.forEach(visit);
  assert.deepEqual(all.filter(n => n.attrs['data-expense-field']).map(n => n.attrs['data-expense-field']),
    ['branchId', 'expenseDate', 'accountId', 'categoryId', 'amount', 'memo']);
  assert.ok(all.some(n => n.attrs['data-expense-submit'] === '1'));
});

test('the phone page still fits its size budget', () => {
  const { buildFuelHtml } = require('../scripts/build-webclient');
  const zlib = require('node:zlib');
  const html = buildFuelHtml(ROOT);
  const bytes = Buffer.byteLength(html);
  const gz = zlib.gzipSync(html).length;
  assert.ok(bytes < 200 * 1024, `page is ${bytes} bytes`);
  assert.ok(gz < 50 * 1024, `gzipped page is ${gz} bytes`);
});
