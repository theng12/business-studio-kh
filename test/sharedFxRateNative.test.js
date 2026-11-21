/**
 * Finance §5: the company's shared exchange rate against a real database.
 *
 *   1. The first read seeds the company's house rate ONCE from the data-owning
 *      Mac's legacy Settings value (4,100 outside the app) and never re-seeds.
 *   2. Two companies keep separate rates; no call falls back to the active
 *      company (fuel's fxKhrPerUsd requires the caller's company id).
 *   3. Setting a rate is dated: older dated rows and posted journal entries are
 *      never repriced; a same-date re-set voids the previous row, keeps it.
 *
 * RUNNING THIS. Real SQLite: `npm run test:native` (add this file to that
 * script — package.json is owned outside this change), or directly:
 *   ELECTRON_RUN_AS_NODE=1 npx electron --test test/sharedFxRateNative.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
} catch (err) {
  if (err && (err.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err.message)))) {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

let counter = 0;
const fixtureDirs = [];
test.afterEach(() => {
  if (!db) return;
  db.closeDb();
  const trash = path.join(os.tmpdir(), 'msk-test-fixtures', 'finance-tests');
  fs.mkdirSync(trash, { recursive: true });
  for (const dir of fixtureDirs.splice(0)) fs.renameSync(dir, path.join(trash, path.basename(dir)));
});
function fixture() {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-shared-fx-${counter}-`));
  fixtureDirs.push(dataDir);
  db.initDb(dataDir);
  const companies = require('../main/db/companies');
  const company = companies.create({ name: `Shared FX Co ${counter}`, isActive: true });
  return {
    dataDir, company, companies,
    fx: require('../main/db/fxRates'),
    fuel: require('../main/db/fuel'),
    ledger: require('../main/db/ledger'),
  };
}

function opening(ledger, companyId, key, date, rate) {
  return ledger.post({
    companyId, entryDate: date, sourceKind: 'asset_open', sourceId: 'a1', idempotencyKey: key, fxKhrPerUsd: rate, memo: 'Opening value',
    lines: [
      { accountKey: 'fa.cost.vehicle', debitMinor: 3_000_000, lineRole: 'cost' },
      { accountKey: 'fa.accum.vehicle', creditMinor: 1_777_500, lineRole: 'accum_dep' },
      { accountKey: 'equity.opening', creditMinor: 1_222_500, lineRole: 'equity' },
    ],
  });
}

test('the first read seeds the company rate once from the legacy Settings value', { skip: skipReason }, () => {
  const { company, fx } = fixture();
  const first = fx.sharedRate(company.id);
  assert.equal(first.khrPerUsd, 4100, '4,100 is the documented default outside the app');
  assert.equal(first.source, 'house');
  assert.equal(first.sourceNote, 'from Settings');
  assert.match(first.rateDate, /^\d{4}-\d{2}-\d{2}$/);

  const second = fx.sharedRate(company.id);
  assert.equal(second.id, first.id, 'a read never seeds a second row');
  assert.equal(fx.list(company.id, { includeVoided: true }).length, 1);

  // A legacy config value that is not the default would have been the seed; the
  // point here is that after the first row exists, re-reads are pure DB reads.
  fx.setRate({ companyId: company.id, rateDate: '2026-01-01', khrPerUsd: 4230 });
  assert.equal(fx.sharedRate(company.id).khrPerUsd, 4230);
  assert.equal(fx.list(company.id, { includeVoided: true }).length, 2);
});

test('two companies keep separate rates; fuel never reads the active company by default', { skip: skipReason }, () => {
  const { company: a, companies, fx, fuel } = fixture();
  const b = companies.create({ name: 'Second Co' });

  fx.setRate({ companyId: a.id, rateDate: '2026-01-01', khrPerUsd: 4200 });
  fx.setRate({ companyId: b.id, rateDate: '2026-01-01', khrPerUsd: 4050 });

  assert.equal(fx.sharedRate(a.id).khrPerUsd, 4200);
  assert.equal(fx.sharedRate(b.id).khrPerUsd, 4050);
  assert.equal(fuel.fxKhrPerUsd(a.id), 4200);
  assert.equal(fuel.fxKhrPerUsd(b.id), 4050);

  // The caller must name its company: a missing id throws instead of borrowing
  // the active company's rate.
  assert.throws(() => fuel.fxKhrPerUsd(), /Company is required/);

  // Changing one company's rate leaves the other alone.
  fx.setRate({ companyId: a.id, rateDate: '2026-02-01', khrPerUsd: 4300 });
  assert.equal(fuel.fxKhrPerUsd(a.id), 4300);
  assert.equal(fuel.fxKhrPerUsd(b.id), 4050);
});

test('a future-only house rate never supplies today or an older posting', { skip: skipReason }, () => {
  const { company, fx } = fixture();
  fx.setRate({ companyId: company.id, rateDate: '2099-01-01', khrPerUsd: 9000 });
  assert.equal(fx.sharedRate(company.id, { seed: false }), null);
  assert.equal(fx.sharedRate(company.id).khrPerUsd, 4100);
  assert.equal(fx.houseRateFor(company.id, '2026-03-01').khrPerUsd, 4100);
  assert.equal(fx.rateOn(company.id, '2099-01-02').khrPerUsd, 9000);
});

test('rates are dated: older rows and posted entries are never repriced', { skip: skipReason }, () => {
  const { company, fx, ledger } = fixture();
  fx.setRate({ companyId: company.id, rateDate: '2026-01-01', khrPerUsd: 4000 });
  const entry = opening(ledger, company.id, 'hist-1', '2026-03-01', 4000);

  // A LATER rate becomes the shared one, but the January rate still answers for
  // June, and the posted entry keeps the rate it stored.
  fx.setRate({ companyId: company.id, rateDate: '2026-06-01', khrPerUsd: 4200 });
  assert.equal(fx.sharedRate(company.id).khrPerUsd, 4200, 'the rate in force today');
  assert.equal(fx.rateOn(company.id, '2026-03-15').khrPerUsd, 4000, 'March still uses the January rate');
  assert.equal(ledger.getEntry(entry.id).fxKhrPerUsd, 4000, 'a posted figure is immutable');

  // A FUTURE-dated rate is not in force yet: the shared rate stays the one in
  // force today, so the screens and the book entries cannot disagree.
  fx.setRate({ companyId: company.id, rateDate: '2030-12-31', khrPerUsd: 4500 });
  assert.equal(fx.sharedRate(company.id).khrPerUsd, 4200, 'a future rate does not become the active one');

  // Re-setting the SAME date replaces it: the old row is voided, not deleted.
  fx.setRate({ companyId: company.id, rateDate: '2026-01-01', khrPerUsd: 4010 });
  assert.equal(fx.rateOn(company.id, '2026-03-15').khrPerUsd, 4010);
  const jan = fx.list(company.id, { source: 'house', includeVoided: true, from: '2026-01-01', to: '2026-01-01' });
  assert.equal(jan.length, 2);
  assert.deepEqual(jan.map((r) => r.voided).sort(), [false, true]);
  assert.equal(ledger.getEntry(entry.id).fxKhrPerUsd, 4000, 'still untouched');
});
