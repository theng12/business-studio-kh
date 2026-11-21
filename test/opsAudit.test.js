/**
 * Ops & system screens audit (0.1.94) — the pure halves, run by plain
 * `npm test`. The database halves (PO list filters + line search, History
 * names across companies) are in test/opsAuditNative.test.js.
 *
 * What is pinned, and why:
 *   - Exchange rates under one cent are shown and typed as "1 USD = 4,100 KHR"
 *     but stored as the same exchangeRateToUsd (toFixed(4) printed "@ 0.0000").
 *   - The Cost Calculator compares a riel price only through a rate the
 *     viewer typed, and saves a retail price in the product's own currency.
 *   - Automatic weekly backups: due after 7 days, keep the newest 4 automatic
 *     backups, never touch a manual one, never run on a client, and send
 *     retired files to the Trash rather than erasing them.
 *   - Wiring the screens depend on (pending PO nav, Dashboard chips, the
 *     Recently deleted list, truthful delete copy, the scheduler at boot).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function loadEsm(rel) {
  const esbuild = require('esbuild');
  const out = esbuild.transformSync(read(rel), { format: 'cjs', loader: 'js' });
  const mod = { exports: {} };
  new Function('module', 'exports', out.code)(mod, mod.exports);
  return mod.exports;
}

function loadBackupManager() {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir(), getVersion: () => '0.1.94' } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('../main/backupManager'); }
  finally { Module._load = originalLoad; }
}

/* ─── exchange rates ───────────────────────────────────────────── */

test('small exchange rates read and type as "1 USD = N" but store the same rate-to-USD', () => {
  const fx = loadEsm('renderer/modules/PurchaseOrders/fxRate.js');
  assert.equal(fx.formatFx('KHR', 1 / 4100), `1 USD = ${(4100).toLocaleString()} KHR`);
  assert.equal(fx.formatFx('VND', 1 / 25000), `1 USD = ${(25000).toLocaleString()} VND`);
  assert.equal(fx.formatFx('CNY', 0.14), '1 CNY = 0.14 USD');
  // The shown direction follows the field's label (the currency), never the
  // size of the rate — a tiny THB rate stays "1 THB = … USD" (review fix 17).
  assert.equal(fx.formatFx('THB', 0.005), `1 THB = ${(0.005).toLocaleString()} USD`);
  assert.equal(fx.formatFx('USD', 1), 'USD');
  assert.equal(fx.formatFx('KHR', 0), '1 USD = ? KHR');

  assert.equal(fx.quotesPerUsd('khr'), true);
  assert.equal(fx.quotesPerUsd('CNY'), false);
  assert.equal(fx.fxLabel('KHR'), 'Exchange rate (1 USD = ? KHR)');
  assert.equal(fx.fxLabel('CNY'), 'Exchange rate (1 CNY = ? USD)');
  // The old placeholder said "0.14 for THB→USD" — 0.14 is the yuan's rate.
  assert.equal(fx.fxPlaceholder('CNY'), 'e.g. 0.14');
  assert.equal(fx.fxPlaceholder('KHR'), 'e.g. 4100');
  assert.notEqual(fx.fxPlaceholder('THB'), 'e.g. 0.14');

  const stored = fx.parseRateInput('KHR', '4100');
  assert.ok(Math.abs(stored - 1 / 4100) < 1e-12, 'typed per USD, stored per KHR');
  assert.equal(fx.perUsdText(stored), '4100', 'round-trips without float noise');
  assert.equal(fx.parseRateInput('CNY', '0.14'), 0.14);
  for (const bad of ['', '0', '-3', 'abc']) assert.equal(fx.parseRateInput('KHR', bad), '');
});

test('PO screens use the rate helpers instead of toFixed(4) and the wrong placeholder', () => {
  const detail = read('renderer/modules/PurchaseOrders/PODetail.jsx');
  const list = read('renderer/modules/PurchaseOrders/index.jsx');
  assert.doesNotMatch(detail, /exchangeRateToUsd\)\.toFixed\(4\)/);
  assert.doesNotMatch(detail, /fxRateToUsd \|\| 0\)\.toFixed\(4\)/);
  assert.doesNotMatch(list, /0\.14 for THB/);
  assert.match(detail, /formatFx\(header\.currency, header\.exchangeRateToUsd\)/);
  assert.match(list, /<FxRateInput/);
});

/* ─── cost calculator ──────────────────────────────────────────── */

test('Cost Calculator margins compare riel prices only through a typed rate', () => {
  const m = loadEsm('renderer/modules/CostCalculator/costMath.js');
  const khr = { amount: 41000, currency: 'KHR' };
  assert.match(m.marginAgainst(khr, 5, {}).text, /price in KHR: add a rate/);
  const withRate = m.marginAgainst(khr, 5, { KHR: '4100' });
  assert.equal(withRate.text, '50.0%'); // ៛41,000 = $10 at 4,100; cost $5
  assert.equal(withRate.tone, 'emerald');
  assert.equal(m.marginAgainst({ amount: 10, currency: null }, 5).text, '50.0%', 'no currency reads as USD');
  assert.equal(m.marginAgainst({ amount: 4, currency: 'USD' }, 5).tone, 'rose');

  assert.deepEqual(m.retailInCurrency(10, 'KHR', { KHR: '4100' }), { amount: 41000, currency: 'KHR' });
  assert.deepEqual(m.retailInCurrency(10.005, 'KHR', {}), { amount: 10.01, currency: 'USD' }, 'no rate → USD');
  assert.deepEqual(m.retailInCurrency(12.5, 'USD', {}), { amount: 12.5, currency: 'USD' });
});

test('Cost Calculator: one searchable picker over every product, and a conflict-safe Save as retail', () => {
  const src = read('renderer/modules/CostCalculator/index.jsx');
  assert.match(src, /<SearchableSelect/);
  assert.doesNotMatch(src, /slice\(0, 50\)/, 'no 50-product cap');
  assert.match(src, /expectedUpdatedAt: p\.updatedAt/);
  assert.match(src, /resolveSaveConflict\(/);
  assert.match(src, /priceRetailCurrency: target\.currency/);
});

/* ─── automatic weekly backups ─────────────────────────────────── */

const DAY = 24 * 3600 * 1000;

test('automatic backups: due after a week, named apart, and retention keeps the newest 4 automatic only', () => {
  const b = loadBackupManager();
  assert.equal(b.AUTO_BACKUP_KEEP, 4);
  assert.equal(b.AUTO_BACKUP_INTERVAL_MS, 7 * DAY);

  const name = b.autoBackupFilename('2026-10-08-0900', '0.1.94');
  assert.equal(name, 'business-studio-kh-backup-auto-v0.1.94-2026-10-08-0900.iskhbackup');
  assert.equal(b.isAutoBackupName(name), true);
  assert.equal(b.isAutoBackupName('business-studio-kh-backup-v0.1.94-2026-10-08-0900.iskhbackup'), false);
  // Still a backup the list and the restore path accept.
  assert.equal(require('../main/util/backupSafety').isBackupFilename(name), true);

  const now = Date.UTC(2026, 9, 8);
  assert.equal(b.autoBackupDue({ lastAutoAt: null, now }), true, 'never backed up');
  assert.equal(b.autoBackupDue({ lastAutoAt: now - 6 * DAY, now }), false);
  assert.equal(b.autoBackupDue({ lastAutoAt: now - 7 * DAY, now }), true);
  // A future time counts as just made; lastAutoBackupAt skips future-dated
  // files, so it cannot postpone backups either (review fix 12).
  assert.equal(b.autoBackupDue({ lastAutoAt: now + DAY, now }), false);
  assert.equal(b.lastAutoBackupAt([{ fileName: 'business-studio-kh-backup-auto-v1-f.iskhbackup', createdAt: now + 400 * DAY, auto: true }], now), null);

  const auto = (i) => ({ fileName: `business-studio-kh-backup-auto-v1-${i}.iskhbackup`, backupPath: `/b/auto-${i}`, createdAt: now - i * 7 * DAY, auto: true });
  const manual = (i) => ({ fileName: `business-studio-kh-backup-v1-${i}.iskhbackup`, backupPath: `/b/manual-${i}`, createdAt: now - i * DAY - 1, auto: false });
  const listing = [auto(0), manual(0), auto(1), auto(2), manual(30), auto(3), auto(4), auto(5)];
  const prune = b.autoBackupsToPrune(listing);
  assert.deepEqual(prune.map((x) => x.backupPath), ['/b/auto-4', '/b/auto-5']);
  assert.ok(prune.every((x) => x.auto), 'a manual backup is never retired');
  assert.deepEqual(b.autoBackupsToPrune([auto(0), auto(1)]), []);
  assert.equal(b.lastAutoBackupAt([manual(0), auto(2), auto(3)]), auto(2).createdAt);
});

test('runAutoBackupIfDue: backs up when due, retires old automatic ones to the Trash, skips clients and when off', async () => {
  const b = loadBackupManager();
  const now = Date.UTC(2026, 9, 8);
  const autos = [1, 2, 3, 4].map((w) => ({
    fileName: `business-studio-kh-backup-auto-v1-w${w}.iskhbackup`, backupPath: `/b/auto-w${w}`, createdAt: now - w * 7 * DAY, auto: true,
  }));
  const manualOld = { fileName: 'business-studio-kh-backup-v1-old.iskhbackup', backupPath: '/b/manual-old', createdAt: now - 400 * DAY, auto: false };

  function harness(cfg, initial) {
    let files = [...initial];
    const calls = { created: 0, trashed: [] };
    const deps = {
      config: { loadConfig: () => ({ dataDir: '/data', mode: 'standalone', autoBackupEnabled: true, ...cfg }) },
      listBackups: async () => ({ backups: [...files].sort((x, y) => y.createdAt - x.createdAt) }),
      createBackup: async ({ auto }) => {
        assert.equal(auto, true, 'the scheduler always asks for an automatic backup');
        calls.created += 1;
        const fresh = { fileName: 'business-studio-kh-backup-auto-v1-now.iskhbackup', backupPath: '/b/auto-now', createdAt: now, auto: true, sizeBytes: 10 };
        files.push(fresh);
        return fresh;
      },
      trashPath: async (p) => { calls.trashed.push(p); files = files.filter((f) => f.backupPath !== p); return 'trashed'; },
      runTracked: (fn) => fn(),
      exists: () => true,
    };
    return { deps, calls, files: () => files };
  }

  // Due (newest automatic is a week old): one backup, then the 5th-newest
  // automatic goes to the Trash; the year-old manual backup stays.
  const h = harness({}, [...autos, manualOld]);
  const res = await b.runAutoBackupIfDue({ now, deps: h.deps });
  assert.equal(h.calls.created, 1);
  assert.deepEqual(h.calls.trashed, ['/b/auto-w4']);
  assert.ok(h.files().some((f) => f.backupPath === '/b/manual-old'));
  assert.equal(res.pruned[0].outcome, 'trashed');

  // Not due: nothing made, nothing retired.
  const fresh = harness({}, [{ ...autos[0], createdAt: now - DAY }]);
  await b.runAutoBackupIfDue({ now, deps: fresh.deps });
  assert.equal(fresh.calls.created, 0);
  assert.deepEqual(fresh.calls.trashed, []);

  // A client never backs up (the server Mac does); off means off.
  const client = harness({ mode: 'client' }, []);
  assert.deepEqual(await b.runAutoBackupIfDue({ now, deps: client.deps }), { skipped: 'client' });
  assert.equal(client.calls.created, 0);
  const off = harness({ autoBackupEnabled: false }, []);
  assert.deepEqual(await b.runAutoBackupIfDue({ now, deps: off.deps }), { skipped: 'disabled' });

  // A custom folder on a drive that is not connected: reported, not created.
  const unplugged = harness({ backupsDir: '/Volumes/Gone/backups' }, []);
  unplugged.deps.exists = () => false;
  const failed = await b.runAutoBackupIfDue({ now, deps: unplugged.deps });
  assert.match(failed.error, /not available/);
  assert.equal(unplugged.calls.created, 0);
});

test('automatic backups are wired: started on the data-owning boot path, shown in Settings, default on', () => {
  const index = read('main/index.js');
  const boot = index.slice(index.indexOf('Standalone / server boot'));
  assert.match(boot, /startAutoBackupScheduler\(/, 'started after the client-mode early return');
  assert.match(read('main/config.js'), /autoBackupEnabled: true/);
  const panel = read('renderer/modules/Settings/BackupsPanel.jsx');
  assert.match(panel, /setOne\('autoBackupEnabled'/);
  assert.match(panel, /sameDiskAsData/);
  assert.match(panel, /!isClient \? \(\s*<label className="toggle">/, 'the switch is only on the Mac that runs them');
  // Retired files go through the Trash helper, never rm.
  const mgr = read('main/backupManager.js');
  assert.match(mgr, /require\('\.\/util\/fileTrash'\)\.trashPath/);
});

/* ─── screen wiring ────────────────────────────────────────────── */

test('Purchase Orders reacts to pending navigation while already open, and filters from the Dashboard', () => {
  const list = read('renderer/modules/PurchaseOrders/index.jsx');
  assert.match(list, /\}, \[pendingPoId, pendingPoSupplierId, pendingPoStatus, clearPendingPoNav\]\);/);
  assert.doesNotMatch(list, /if \(pendingPoId \|\| pendingPoSupplierId\) clearPendingPoNav\(\);\n\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\n\s*\}, \[\]\);/);
  const dash = read('renderer/modules/Dashboard/index.jsx');
  for (const status of ["onOpen('open')", "onOpen('in_transit')", "onOpen('owed')"]) assert.ok(dash.includes(status), status);
  assert.match(dash, /brandIds: \[b\.id\]/, 'a recent brand opens the Library filtered to it');
  assert.match(dash, /toLocaleString\(\)/);
  // New POs only go to active suppliers; the list keeps rows while loading.
  assert.match(list, /suppliers=\{activeSuppliers\}/);
  assert.match(list, /loading && rows\.length === 0 && <div className="muted">Loading…<\/div>/);
  assert.match(read('renderer/modules/Suppliers/index.jsx'), /loading && sorted\.length === 0 \?/);
});

test('PO lines: price required (0 only after a confirm), Enter submits, duplicate warned, close-without-receive explicit', () => {
  const detail = read('renderer/modules/PurchaseOrders/PODetail.jsx');
  assert.match(detail, /<form id="po-line-form"/);
  assert.match(detail, /priceMissing/);
  assert.match(detail, /Save this line with a unit price of 0\?/);
  assert.match(detail, /duplicateOf/);
  assert.match(detail, /Save &amp; add next/);
  assert.match(detail, /Close a purchase order that was never received\?/);
  assert.match(detail, /runStatusChange\(\['received', 'closed'\]/);
  assert.match(detail, /Duplicate as draft/);
});

test('Recently deleted: own row classes (no monospace break-all), bulk restore, search, company named', () => {
  const panel = read('renderer/modules/Settings/DeletedItemsPanel.jsx');
  assert.doesNotMatch(panel, /backups-row__file/);
  assert.match(panel, /handleRestoreSelected/);
  assert.match(panel, /Search deleted items/);
  assert.match(panel, /Nothing deleted \{where\}/);
  const css = read('renderer/index.css');
  const rule = css.slice(css.indexOf('.deleted-row__detail {'), css.indexOf('}', css.indexOf('.deleted-row__detail {')));
  assert.doesNotMatch(rule, /break-all|font-mono/);
});

test('delete confirms next to Recently deleted no longer say the delete cannot be undone', () => {
  assert.doesNotMatch(read('renderer/components/BackupReminder.jsx'), /can't be undone|cannot be undone/);
});

test('History names come from the server across companies', () => {
  assert.match(read('main/db/auditLog.js'), /return attachEntityNames\(db, rows\.map\(rowToEntry\)\);/);
  assert.match(read('renderer/modules/History/index.jsx'), /const live = entry\.entity;/);
});

test('global polish: themed links, readable muted text, dark SaveStatus, sidebar keeps the active page in view', () => {
  const css = read('renderer/index.css');
  assert.match(css, /\na \{ color: var\(--c-brand\);/);
  assert.match(css, /\.muted \{ color: var\(--c-text-muted\); \}/);
  assert.match(css, /\[data-theme="dark"\] \.save-status \{ color: var\(--c-emerald\); \}/);
  assert.match(css, /\.sidebar__nav\.sidebar__nav--more/);
  assert.match(css, /grid-template-columns: minmax\(220px, 30%\) 1fr;/);
  const sidebar = read('renderer/components/Sidebar.jsx');
  assert.match(sidebar, /scrollIntoView\?\.\(\{ block: 'nearest' \}\)/);
});
