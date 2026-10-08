/**
 * Fixed Assets desktop screens — the pure view model
 * (renderer/modules/Assets/assetsModel.js) and the Home tile's badge
 * (renderer/lib/modules.js): money and dates, the "Depreciate this item"
 * words, the details form's patch (draft vs active), a new asset's payloads,
 * which actions an asset offers, the schedule and run states, the import
 * mapping, the report tables and the register's cells. Plain `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
function load(rel) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}
const M = load('renderer/modules/Assets/assetsModel.js');
const reg = load('renderer/lib/modules.js');

const draft = (over = {}) => ({ id: 'a1', recordState: 'draft', status: 'in_use', acquisitionKind: 'purchase', costCurrency: 'USD', quantity: 1, ...over });
const active = (over = {}) => ({ id: 'a2', recordState: 'active', status: 'in_use', accountingTreatment: 'capitalised', acquisitionKind: 'purchase', categoryKey: 'truck', quantity: 1, inServiceDate: '2026-01-05', depreciationStartPeriod: '2026-01', nbvMinor: 100000, ...over });

test('money: dollars from cents, riel from whole riel, signs kept, riel at the house rate', () => {
  assert.equal(M.fmtUsd(123456), '$1,234.56');
  assert.equal(M.fmtUsd(-1200), '−$12.00');
  assert.equal(M.fmtUsd(null), '—');
  assert.equal(M.fmtKhr(1250000), '៛1,250,000');
  assert.equal(M.fmtKhr(-500), '−៛500');
  assert.equal(M.fmtMoneyIn(1200000, 'KHR'), '៛1,200,000');
  assert.equal(M.rielOf(10000, 4100), 410000);
  assert.equal(M.rielOf(10000, null), null);
  assert.equal(M.rielHint(10000, 4100), '≈ ៛410,000');
  assert.equal(M.rielHint(10000, 0), '');
});

test('typed amounts: blank, cents, riel, bad and negative', () => {
  assert.deepEqual(M.parseMoney(''), { minor: null });
  assert.deepEqual(M.parseMoney('1,250.5'), { minor: 125050 });
  assert.deepEqual(M.parseMoney('1200000', 'KHR'), { minor: 1200000 });
  assert.match(M.parseMoney('12a').error, /type a number/);
  assert.match(M.parseMoney('-3').error, /cannot be negative/);
  assert.match(M.parseMoney('0', 'USD', { allowZero: false }).error, /more than zero/);
  assert.equal(M.minorToInput(125050), '1250.50');
  assert.equal(M.minorToInput(1200000, 'KHR'), '1200000');
  assert.equal(M.minorToInput(null), '');
  assert.deepEqual(M.parseWhole('36', { min: 1 }), { value: 36 });
  assert.match(M.parseWhole('2.5').error, /whole number/);
  assert.match(M.parseWhole('0', { label: 'Life', min: 1, max: 9 }).error, /Life must be 1–9/);
});

test('dates and periods are calendar days in Phnom Penh, never shifted by the Mac', () => {
  assert.match(M.fmtYmd('2026-03-12'), /12/);
  assert.match(M.fmtYmd('2026-03-12'), /2026/);
  assert.equal(M.fmtYmd('bad'), '—');
  assert.equal(M.addMonths('2026-01', -1), '2025-12');
  assert.equal(M.addMonths('2026-11', 3), '2027-02');
  // 8 Oct 2026, 01:00 in Phnom Penh is still 7 Oct in UTC.
  const at = Date.UTC(2026, 9, 7, 18, 0);
  assert.equal(M.todayKey(at), '2026-10-08');
  assert.equal(M.lastEndedPeriod(at), '2026-09');
  assert.equal(M.fmtLife(96), '8 years');
  assert.equal(M.fmtLife(42), '3 years 6 months');
  assert.equal(M.fmtLife(1), '1 month');
});

test('"Depreciate this item" in plain words (§13a: $300 threshold, the tick overrides it either way)', () => {
  assert.match(M.depreciateExplain({ costUsdMinor: 95000 }), /^Depreciated: it cost \$950\.00, which is \$300\.00 or more/);
  assert.match(M.depreciateExplain({ costUsdMinor: 29268 }), /^Tracked only: it cost \$292\.68, under \$300\.00/);
  assert.match(M.depreciateExplain({ costUsdMinor: null }), /Decided when it is activated/);
  assert.match(M.depreciateExplain({ override: true, costUsdMinor: 5000 }), /whatever it cost/);
  assert.match(M.depreciateExplain({ override: false, costUsdMinor: 900000 }), /not on the books/);
  assert.match(M.depreciateExplain({ bookMethod: 'none' }), /never depreciated \(land\)/);
  assert.equal(M.depreciateChoice(true), 'yes');
  assert.equal(M.depreciateChoice(null), 'auto');
  assert.equal(M.depreciateValue('no'), false);
  assert.equal(M.depreciateValue('auto'), null);
});

test('the details form: a draft edits everything, an active asset only identity and paperwork', () => {
  const d = draft({ costMinor: 95000, salvageMinor: 0, usefulLifeMonths: 36 });
  const f = { ...M.assetToForm(d), name: ' Dell laptop ', cost: '1,000', salvage: '50', depreciate: 'yes', usefulLifeMonths: '48', branchId: 'b1' };
  const { patch, errors } = M.formPatch(f, ['name', 'cost', 'salvage', 'depreciate', 'usefulLifeMonths', 'branchId'], d);
  assert.deepEqual(errors, {});
  assert.deepEqual(patch, { name: 'Dell laptop', costMinor: 100000, salvageMinor: 5000, depreciateOverride: true, usefulLifeMonths: 48, branchId: 'b1' });

  const a = active();
  const g = { ...M.assetToForm(a), name: 'Truck 9', cost: '5', branchId: 'b2', notes: '  ', serialNo: 'SN1' };
  const r = M.formPatch(g, ['name', 'cost', 'branchId', 'notes', 'serialNo'], a);
  assert.deepEqual(r.patch, { name: 'Truck 9', notes: null, serialNo: 'SN1' }, 'money and place change through events');
  assert.equal(M.canEditField(a, 'branchId'), false);
  assert.equal(M.canEditField(a, 'inServiceDate'), false, 'already in service');
  assert.equal(M.canEditField(active({ inServiceDate: null, depreciationStartPeriod: null }), 'inServiceDate'), true, 'once, when it had none');
  assert.equal(M.canEditField(active({ inServiceDate: null, depreciationStartPeriod: null, acquisitionKind: 'opening' }), 'inServiceDate'), false, 'openings never');
  assert.equal(M.canEditField({ recordState: 'cancelled' }, 'name'), false);

  const bad = M.formPatch({ ...M.assetToForm(d), name: '', cost: 'x', purchaseDate: '12/3/2026' }, ['name', 'cost', 'purchaseDate'], d);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['cost', 'name', 'purchaseDate']);
  // Switching the currency re-sends the typed amount in the new unit.
  const cur = M.formPatch({ ...M.assetToForm(d), cost: '1200000', costCurrency: 'KHR' }, ['costCurrency'], d);
  assert.deepEqual(cur.patch, { costCurrency: 'KHR', costMinor: 1200000 });
});

test('a new asset: purchase, opening with and without a known cost, separate items or one group', () => {
  const today = '2026-10-08';
  const base = { ...M.newAssetForm(), categoryId: 'c1', name: 'iMac' };
  let r = M.validateNewAsset({ ...base, cost: '1,450', purchaseDate: '2026-09-01', inServiceDate: '2026-09-02', usefulLifeMonths: '36' }, { today });
  assert.deepEqual(r.errors, {});
  assert.equal(r.inputs.length, 1);
  assert.deepEqual(r.inputs[0], { categoryId: 'c1', name: 'iMac', acquisitionKind: 'purchase', costBasis: 'actual', depreciateOverride: null, purchaseDate: '2026-09-01', inServiceDate: '2026-09-02', costMinor: 145000, costCurrency: 'USD', usefulLifeMonths: 36 });

  r = M.validateNewAsset({ ...base, kind: 'opening', knowsCost: 'no', cost: '600', usefulLifeMonths: '24', salvage: '50', purchaseDate: '2022-01-01' }, { today });
  assert.deepEqual(r.errors, {});
  assert.equal(r.inputs[0].costBasis, 'deemed');
  assert.equal(r.inputs[0].purchaseDate, undefined, 'a deemed value has no purchase date');
  assert.equal(r.inputs[0].costMinor, 60000);
  assert.equal(r.inputs[0].salvageMinor, 5000);

  r = M.validateNewAsset({ ...base, kind: 'opening', knowsCost: 'yes', cost: '30000' }, { today });
  assert.match(r.errors.purchaseDate, /When was it bought/);
  r = M.validateNewAsset({ ...base, kind: 'opening', knowsCost: 'no' }, { today });
  assert.ok(r.errors.cost && r.errors.usefulLifeMonths);

  r = M.validateNewAsset({ ...base, quantity: '3' }, { today });
  assert.equal(r.inputs.length, 3, 'separate items, each with its own tag');
  assert.ok(r.inputs.every((x) => x.quantity === undefined));
  r = M.validateNewAsset({ ...base, quantity: '200', split: 'group' }, { today });
  assert.equal(r.inputs.length, 1);
  assert.equal(r.inputs[0].quantity, 200);
  r = M.validateNewAsset({ ...base, quantity: '51' }, { today });
  assert.match(r.errors.quantity, /Up to 50 separate items/);

  r = M.validateNewAsset({ ...M.newAssetForm(), purchaseDate: '2027-01-01', inServiceDate: '2026-01-01' }, { today });
  assert.ok(r.errors.categoryId && r.errors.name);
  assert.match(r.errors.purchaseDate, /future/);
  assert.match(r.errors.inServiceDate, /before it was bought/);
});

test('an asset offers only the actions its state allows, and none without assets.manage', () => {
  const keys = (a, o = { canManage: true }) => M.assetActions(a, o).map((x) => x.key);
  assert.deepEqual(keys(active(), { canManage: false }), []);
  assert.deepEqual(keys(draft()), ['activate', 'cancelDraft']);
  assert.deepEqual(keys(active()), ['transfer', 'custodian', 'status', 'repair', 'capex', 'life', 'impair', 'note', 'dispose', 'markLost']);
  assert.ok(keys(active({ categoryKey: 'building' })).includes('revalue'), 'land and buildings can be revalued');
  assert.ok(keys(active({ quantity: 200 })).includes('partialDispose'));
  const tracked = keys(active({ accountingTreatment: 'tracked_only' }));
  assert.ok(!tracked.includes('capex') && !tracked.includes('life') && !tracked.includes('impair'), 'nothing posts for a tracked-only item');
  const land = keys(active({ accountingTreatment: 'not_depreciated', categoryKey: 'land' }));
  assert.ok(land.includes('revalue') && !land.includes('life'));
  assert.deepEqual(keys(active({ status: 'lost' })), ['markFound', 'note']);
  assert.deepEqual(keys(active({ status: 'disposed' })), ['note']);
  assert.deepEqual(keys({ ...draft(), recordState: 'cancelled' }), []);
  assert.ok(M.assetActions(draft(), { canManage: true })[0].primary);
});

test('events: void what posted nothing, reverse what posted; the timeline line reads', () => {
  const k = (e) => M.eventActions(e, { canManage: true }).map((x) => x.key);
  assert.deepEqual(k({ kind: 'transfer' }), ['void']);
  assert.deepEqual(k({ kind: 'capex', journalEntryId: 'j' }), ['reverse']);
  assert.deepEqual(k({ kind: 'dispose', journalEntryId: 'j' }), ['reverse']);
  assert.deepEqual(k({ kind: 'dispose', journalEntryId: 'j', reversedByEventId: 'r' }), []);
  assert.deepEqual(k({ kind: 'transfer', voided: true }), []);
  assert.deepEqual(M.eventActions({ kind: 'transfer' }, { canManage: false }), []);
  const branches = new Map([['b1', { code: 'PP1', nameEn: 'Head office' }]]);
  const staff = new Map([['e1', { nameEn: 'Dara', staffCode: 'S01' }]]);
  assert.equal(M.eventSummary({ kind: 'transfer', fromBranchId: null, toBranchId: 'b1' }, { branches, staff }), 'no branch → PP1 · Head office');
  assert.equal(M.eventSummary({ kind: 'custodian', fromEmployeeId: null, toEmployeeId: 'e1' }, { branches, staff }), 'nobody → Dara · S01');
  assert.equal(M.eventSummary({ kind: 'dispose', amountUsdMinor: 500000, buyer: 'Mr. Dara', detail: { kind: 'sale', gainMinor: 16666 } }), 'Sold · for $5,000.00 · gain $166.66 · to Mr. Dara');
  assert.equal(M.eventSummary({ kind: 'dispose', amountUsdMinor: 0, detail: { kind: 'scrap', gainMinor: -1200 } }), 'Scrapped · loss $12.00');
  assert.equal(M.eventLabel('lost'), 'Written off as lost');
  assert.equal(M.eventSummary({ kind: 'note', reason: 'Checked' }), 'Checked');
  const events = new Map([['e9', { kind: 'dispose', eventDate: '2026-10-08' }]]);
  assert.match(M.eventSummary({ kind: 'reversal', reversesEventId: 'e9', amountMinor: 1 }, { events }), /^Reverses “Disposed of” of /);
});

test('the book schedule: posted, part posted, not posted yet (caught up next run), planned', () => {
  const s = { rows: [
    { period: '2026-07', amountMinor: 1000, accumMinor: 1000, nbvMinor: 9000, postedMinor: 1000 },
    { period: '2026-08', amountMinor: 1000, accumMinor: 2000, nbvMinor: 8000, postedMinor: 400 },
    { period: '2026-09', amountMinor: 1000, accumMinor: 3000, nbvMinor: 7000, postedMinor: 0 },
    { period: '2026-10', amountMinor: 1000, accumMinor: 4000, nbvMinor: 6000, postedMinor: 0 },
  ] };
  const v = M.scheduleView(s, '2026-09');
  assert.deepEqual(v.rows.map((r) => r.state), ['posted', 'part', 'due', 'future']);
  assert.equal(v.postedTotal, 1400);
  assert.equal(v.dueTotal, 1600);
  assert.equal(v.rows[0].openingNbv, 10000);
  assert.equal(M.scheduleChangeText({ period: '2026-04', lifeMonths: 24 }), 'Life changed to 2 years left from April 2026');
  assert.match(M.scheduleChangeText({ period: '2026-04', addBasisMinor: 50000, extendMonths: 12 }), /^Improvement \+\$500\.00, \+1 year of life/);
});

test('depreciation runs: newest first, the due months, and the catch-up in words', () => {
  const v = M.runsView({ nextDuePeriod: '2026-01', lastEndedPeriod: '2026-02', months: [
    { period: '2025-12', status: 'posted', run: { totalMinor: 1 } }, { period: '2026-02', status: 'due' }, { period: '2026-01', status: 'due' }, { period: '2026-03', status: 'open' },
  ] });
  assert.deepEqual(v.rows.map((r) => r.period), ['2026-03', '2026-02', '2026-01', '2025-12']);
  assert.deepEqual(v.due, ['2026-01', '2026-02']);
  assert.equal(v.latestPostedPeriod, '2025-12');
  const lines = M.catchUpExplanation({ start: '2026-01-01', due: v.due });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /starts on/);
  assert.match(lines[1], /catch-up/);
  assert.match(lines[2], /^2 months are due \(January 2026 to February 2026\)/);
  assert.match(M.catchUpExplanation({ start: '2026-01-01', due: [], lastEnded: '2026-09' })[2], /Everything up to September 2026 is posted/);
  assert.equal(M.runStatusOf('locked').label, 'Closed');
});

test('tax year: pools as rows, an unconfirmed estimate blocks filing, the years offered', () => {
  const year = { pools: {
    2: { openingWdvKhr: 100, openingSource: 'estimate', confirmedByAccountant: false },
    3: { openingWdvKhr: 0, openingSource: 'estimate', confirmedByAccountant: false },
    4: { openingWdvKhr: 50, openingSource: 'entered', confirmedByAccountant: true },
  } };
  const rows = M.poolRows(year);
  assert.deepEqual(rows.map((r) => r.taxClass), ['2', '3', '4']);
  assert.equal(rows[0].source.label, 'Estimate');
  assert.equal(M.hasUnconfirmedEstimate(year), true);
  year.pools[2].confirmedByAccountant = true;
  assert.equal(M.hasUnconfirmedEstimate(year), false, 'an empty estimate does not block');
  assert.deepEqual(M.taxYears('2025-01-01', Date.UTC(2026, 5, 1)), [2026, 2025]);
  assert.deepEqual(M.taxYears('2026-01-01', Date.UTC(2026, 5, 1)), [2026]);
});

test('import: headers are guessed by key, label or alias, each column once; blank cells left out', () => {
  const columns = [
    { key: 'tag_code', label: 'Tag code', aliases: ['tag', 'asset tag'] },
    { key: 'name', label: 'Name', aliases: ['asset name'] },
    { key: 'in_service_date', label: 'In-service date', aliases: ['in service'] },
    { key: 'cost', label: 'Cost', aliases: [] },
  ];
  const map = M.guessMapping(['Tag', 'Asset name', 'In service', 'COST', 'Cost', 'Colour'], columns);
  assert.deepEqual(map, { Tag: 'tag_code', 'Asset name': 'name', 'In service': 'in_service_date', COST: 'cost', Cost: '', Colour: '' });
  const rows = [{ Tag: '', 'Asset name': 'Laptop', COST: 950, Colour: 'red' }, { Tag: ' ', 'Asset name': '' }, { Tag: 'KT-00068', COST: '' }];
  assert.deepEqual(M.buildImportRows(rows, map), [{ name: 'Laptop', cost: '950' }, { tag_code: 'KT-00068' }]);
  assert.deepEqual(M.sampleValues(rows, ['Tag', 'COST']), { Tag: 'KT-00068', COST: '950' });
});

test('reports: arguments per kind and one table each, with totals where they add up', () => {
  const v = M.defaultReportArgs(Date.UTC(2026, 9, 8, 3));
  assert.deepEqual(v, { asOf: '2026-10-08', from: '2026-01-01', to: '2026-10-08', year: 2026, branchId: '', categoryId: '' });
  assert.deepEqual(M.reportArgs('register', { ...v, branchId: 'b1' }), { kind: 'register', asOf: '2026-10-08', branchId: 'b1' });
  assert.deepEqual(M.reportArgs('movements', v), { kind: 'movements', from: '2026-01-01', to: '2026-10-08' });
  assert.deepEqual(M.reportArgs('book_vs_tax', { ...v, branchId: 'b1' }), { kind: 'book_vs_tax', year: 2026 }, 'no branch filter on tax');
  assert.deepEqual(M.reportArgs('attention', v), { kind: 'attention' });
  assert.equal(M.REPORTS.length, 8);
  for (const r of M.REPORTS) {
    const t = M.reportTable({ kind: r.kind, rows: [], totals: {}, pools: {} });
    assert.ok(t.columns.length >= 5, `${r.kind} has columns`);
  }
  const reg2 = M.reportTable({ kind: 'register', rows: [{ assetId: 'a', costMinor: 100 }], totals: { assets: 1, costMinor: 100, nbvMinor: 60, accumMinor: 40, impairmentMinor: 0, trackedOnly: 2 } });
  assert.equal(reg2.totals.costMinor, 100);
  assert.match(reg2.totals.name, /2 tracked only/);
  const mv = M.reportTable({ kind: 'movements', rows: [{ categoryName: 'Trucks', cost: { opening: 5, additions: 1 }, accum: { disposals: -2, revaluation: -1 } }], totals: { accumDisposals: -2, accumRevaluation: -1 } });
  const col = mv.columns.find((c) => c.key === 'accumDisposals');
  assert.equal(M.cellValue(col, mv.rows[0]), -3);
  assert.equal(mv.totals.accumDisposals, -3);
  assert.equal(M.cellText({ type: 'usd' }, 12345), '$123.45');
  assert.equal(M.cellText({ type: 'khr' }, 4100), '៛4,100');
  assert.equal(M.cellText({ type: 'period' }, '2026-03'), 'March 2026');
  assert.equal(M.cellText({ type: 'status' }, 'in_repair'), 'In repair');
  const by = M.reportTable({ kind: 'by_branch', rows: [{ assets: 2, trackedOnly: 1, costMinor: 10, nbvMinor: 5 }, { assets: 3, trackedOnly: 0, costMinor: 20, nbvMinor: 7 }] });
  assert.deepEqual([by.totals.assets, by.totals.costMinor, by.totals.nbvMinor], [5, 30, 12]);
});

test('register cells: book cost and value only for what is on the books', () => {
  assert.deepEqual(M.rowCost(active({ bookCostMinor: 4500000, costUsdMinor: 4000000 })), { minor: 4500000, currency: 'USD', note: '' });
  assert.equal(M.rowNbv(active({ nbvMinor: 1140625 })), 1140625);
  const d = M.rowCost(draft({ costMinor: 1200000, costCurrency: 'KHR' }));
  assert.deepEqual([d.minor, d.currency, d.note, d.muted], [1200000, 'KHR', 'not posted yet', true]);
  assert.equal(M.rowCost(draft()).note, 'needs a cost');
  assert.equal(M.rowNbv(draft({ nbvMinor: 5 })), null);
  assert.equal(M.rowCost(active({ accountingTreatment: 'tracked_only', costUsdMinor: 29268 })).note, 'tracked only');
  assert.equal(M.rowNbv(active({ accountingTreatment: 'tracked_only', nbvMinor: 29268 })), null);
  assert.equal(M.rowCost(active({ status: 'disposed', costUsdMinor: 1 })).note, 'disposed of');
  assert.equal(M.rowNbv(active({ status: 'lost' })), null);
  assert.equal(M.totalsCaption({ assets: 303, onBooks: 241, trackedOnly: 34, drafts: 0 }), '303 assets · 241 on the books · 34 tracked only');
  assert.deepEqual(M.listArgs({ ...M.EMPTY_FILTERS, q: ' KT ', branchId: 'none' }, 2, 50), { limit: 50, offset: 100, q: 'KT', branchId: 'none' });
  assert.equal(M.filtersActive(M.EMPTY_FILTERS), false);
});

test('the server sentence is shown without the IPC wrapper', () => {
  assert.equal(M.errText(new Error("Error invoking remote method 'assets:dispose': Error: Pick a date")), 'Pick a date');
  assert.equal(M.errText(new Error('Plain')), 'Plain');
});

test('Home tile: drafts without a cost and months to post; words beyond the count', async () => {
  assert.equal(reg.assetsBadge({ needsCost: 0 }, { months: [{ status: 'posted' }] }), null);
  assert.deepEqual(reg.assetsBadge({ needsCost: 1 }, { months: [{ status: 'due' }, { status: 'due' }, { status: 'open' }] }), { count: 3, label: '1 needs a cost · 2 months to post' });
  assert.deepEqual(reg.assetsBadge({ needsCost: 2 }, null), { count: 2, label: '2 need a cost' });
  const mod = reg.getModule('assets');
  let calls = 0;
  const api = { assets: {
    // The badge counts the backend's needs_cost flag (counts.needsCost) — the
    // register's "Needs a cost" filter — not every cost-less draft on a page.
    list: async (f) => { calls += 1; assert.equal(f.limit, 1); return { items: [{ recordState: 'draft', costMinor: null }], total: 3, counts: { needsCost: 1 } }; },
    listRuns: async () => ({ months: [{ status: 'due' }] }),
  } };
  reg.clearBadgeCache();
  assert.equal(await reg.loadBadge(mod, { api, caps: ['assets.count'], companyId: 'c' }), null, 'a counter sees no values');
  assert.deepEqual(await reg.loadBadge(mod, { api, caps: ['assets.view'], companyId: 'c', now: 1 }), { count: 2, label: '1 needs a cost · 1 month to post', tone: 'amber' });
  assert.equal(calls, 1);
  // Other badges still return a plain number.
  const po = reg.getModule('purchasing');
  assert.deepEqual(await reg.loadBadge(po, { api: { purchaseOrders: { list: async () => [{}] } }, caps: ['*'], companyId: 'c', now: 1 }), { count: 1, label: '1 open order', tone: 'slate' });
});
