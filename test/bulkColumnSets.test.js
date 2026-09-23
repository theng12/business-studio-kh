/**
 * v0.1.71: Bulk table column sets.
 *
 * The bulk edit table's column selection started as a localStorage-only
 * preference. The owner runs two Macs and a client Mac, so the NAMED sets are
 * company-scoped rows in the database; only the last-used selection stays
 * local. These cases pin the storage contract:
 *
 *   - the table is additive (created without a SCHEMA_VERSION bump),
 *   - a set stores an ordered array of keys and round-trips it,
 *   - optimistic concurrency is honoured on rename/reorder,
 *   - a set is scoped to its company and cannot leak across companies.
 *
 * RUNNING THIS. Real SQLite through the real modules, so it needs the native
 * binding built for ELECTRON's ABI:
 *
 *     npm run test:native
 *
 * Under plain `npm test` it SKIPs with that command as the reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let companies = null;
let sets = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  sets = require('../main/db/bulkColumnSets');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function freshCompany(name = 'Columns Co') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-bulkcols-'));
  db.initDb(dataDir);
  return companies.create({ name, isActive: true });
}

const VIEW = ['sku', 'name', 'status', 'price:export', 'image'];

test('the table exists and starts empty (additive, no schema bump)', { skip: skipReason }, () => {
  const company = freshCompany();
  const cols = db.getDb().prepare('PRAGMA table_info(bulk_column_sets)').all().map((c) => c.name);
  for (const col of ['id', 'company_id', 'name', 'columns', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(col), `bulk_column_sets.${col} missing`);
  }
  assert.deepEqual(sets.list(company.id), []);
});

test('the widths table exists (additive, no schema bump)', { skip: skipReason }, () => {
  const company = freshCompany();
  const cols = db.getDb().prepare('PRAGMA table_info(bulk_column_widths)').all().map((c) => c.name);
  for (const col of ['company_id', 'widths', 'updated_at']) {
    assert.ok(cols.includes(col), `bulk_column_widths.${col} missing`);
  }
  assert.equal(sets.getWidths(company.id), null, 'a company with no row has no stored widths');
});

test('a set round-trips its ordered column list', { skip: skipReason }, () => {
  const company = freshCompany('Roundtrip Co');
  const row = sets.create({ companyId: company.id, name: 'Export desk', columns: VIEW });
  assert.equal(row.name, 'Export desk');
  assert.deepEqual(row.columns, VIEW, 'order must survive — a hand-arranged view is the point');
  assert.deepEqual(sets.list(company.id).map((s) => s.id), [row.id]);
  assert.deepEqual(sets.get(row.id).columns, VIEW);
});

test('a blank/duplicate/non-string key is dropped, never fatal', { skip: skipReason }, () => {
  const company = freshCompany('Normalize Co');
  const row = sets.create({
    companyId: company.id, name: 'Messy',
    columns: ['sku', 'sku', '', '  ', 7, null, 'name', 'name'],
  });
  assert.deepEqual(row.columns, ['sku', 'name']);
});

test('a rename keeps the columns; a columns patch keeps the name', { skip: skipReason }, () => {
  const company = freshCompany('Patch Co');
  const row = sets.create({ companyId: company.id, name: 'First', columns: VIEW });
  const renamed = sets.update(row.id, { name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');
  assert.deepEqual(renamed.columns, VIEW, 'a name-only patch must not reset the view');

  const reordered = sets.update(row.id, { columns: ['image', 'sku'] });
  assert.equal(reordered.name, 'Renamed', 'a columns-only patch must keep the name');
  assert.deepEqual(reordered.columns, ['image', 'sku']);
});

test('an optimistic-concurrency token is honoured', { skip: skipReason }, () => {
  const company = freshCompany('Conflict Co');
  const row = sets.create({ companyId: company.id, name: 'Draft', columns: VIEW });
  assert.throws(
    () => sets.update(row.id, { name: 'Nope', expectedUpdatedAt: row.updatedAt - 1 }),
    /CONFLICT\|/,
  );
  const ok = sets.update(row.id, { name: 'Yes', expectedUpdatedAt: row.updatedAt });
  assert.equal(ok.name, 'Yes');
});

test('duplicate copies the columns and delete removes it', { skip: skipReason }, () => {
  const company = freshCompany('Duplicate Co');
  const row = sets.create({ companyId: company.id, name: 'Squares', columns: VIEW });
  const copy = sets.duplicate(row.id);
  assert.notEqual(copy.id, row.id);
  assert.equal(copy.name, 'Squares copy');
  assert.deepEqual(copy.columns, VIEW);
  assert.equal(copy.companyId, company.id);

  assert.equal(sets.remove(copy.id), true);
  assert.equal(sets.get(copy.id), null);
  assert.equal(sets.remove(copy.id), false, 'deleting twice reports no change');
});

test('sets are scoped to their company', { skip: skipReason }, () => {
  // Two companies in ONE database — freshCompany() re-inits the DB, so calling
  // it twice would delete the first company (and its sets) underneath us.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-bulkcols-two-'));
  db.initDb(dataDir);
  const a = companies.create({ name: 'Company A', isActive: true });
  const b = companies.create({ name: 'Company B' });
  sets.create({ companyId: a.id, name: 'A only', columns: VIEW });
  assert.deepEqual(sets.list(b.id), []);
  sets.create({ companyId: b.id, name: 'B only', columns: ['sku'] });
  assert.deepEqual(sets.list(a.id).map((s) => s.name), ['A only']);
  assert.deepEqual(sets.list(b.id).map((s) => s.name), ['B only']);
});

test('deleting a company cascades to its sets', { skip: skipReason }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-bulkcols-cascade-'));
  db.initDb(dataDir);
  const company = companies.create({ name: 'Cascade Co', isActive: true });
  const row = sets.create({ companyId: company.id, name: 'Temp', columns: VIEW });
  db.getDb().prepare('DELETE FROM companies WHERE id = ?').run(company.id);
  assert.equal(sets.get(row.id), null, 'orphan rows must not survive the company');
});

/* ── v0.1.72: duplicate naming ──────────────────────────────────────── */

test('duplicate produces "<name> copy" and uniquifies a taken name', { skip: skipReason }, () => {
  const company = freshCompany('Uniquify Co');
  const row = sets.create({ companyId: company.id, name: 'Squares', columns: VIEW });
  const first = sets.duplicate(row.id);
  assert.equal(first.name, 'Squares copy');
  const second = sets.duplicate(row.id);
  assert.equal(second.name, 'Squares copy 2', 'a taken copy name must not shadow the first copy');
  const third = sets.duplicate(row.id);
  assert.equal(third.name, 'Squares copy 3');
  assert.deepEqual(second.columns, VIEW);
  assert.equal(second.companyId, company.id);
});

/* ── v0.1.72: company-scoped column widths ──────────────────────────── */

test('widths round-trip, overwrite and normalize', { skip: skipReason }, () => {
  const company = freshCompany('Widths Co');
  assert.equal(sets.getWidths(company.id), null, 'nothing stored yet');
  assert.deepEqual(sets.setWidths(company.id, { name: 260, sku: 130 }), { name: 260, sku: 130 });
  assert.deepEqual(sets.getWidths(company.id), { name: 260, sku: 130 });
  // The map is written whole, not merged — a removed key disappears.
  assert.deepEqual(sets.setWidths(company.id, { name: 300 }), { name: 300 });
  assert.deepEqual(sets.getWidths(company.id), { name: 300 });
  // Junk is dropped, never fatal; fractions round to whole pixels.
  assert.deepEqual(
    sets.normalizeWidths({ a: '120', b: -5, c: 0, d: NaN, e: 130.6, f: 'x', '  ': 10 }),
    { a: 120, e: 131 },
  );
  assert.deepEqual(sets.normalizeWidths(['not', 'a', 'map']), {});
});

test('an empty width map clears the stored row', { skip: skipReason }, () => {
  const company = freshCompany('Clear Widths Co');
  sets.setWidths(company.id, { name: 260 });
  assert.equal(sets.setWidths(company.id, {}), null);
  assert.equal(sets.getWidths(company.id), null,
    'Reset columns must clear the DB row, not leave an empty "{}" behind');
  assert.equal(
    db.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_column_widths').get().n, 0,
    'the row itself must be gone',
  );
});

test('widths are scoped to their company', { skip: skipReason }, () => {
  // Two companies in ONE database — freshCompany() re-inits the DB, so a second
  // call would delete the first company (and its widths) underneath us.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-bulkwidths-two-'));
  db.initDb(dataDir);
  const a = companies.create({ name: 'Width A', isActive: true });
  const b = companies.create({ name: 'Width B' });
  sets.setWidths(a.id, { name: 260 });
  assert.deepEqual(sets.getWidths(a.id), { name: 260 });
  assert.equal(sets.getWidths(b.id), null, "one company must never read another's layout");
  sets.setWidths(b.id, { sku: 130 });
  assert.deepEqual(sets.getWidths(a.id), { name: 260 }, "B's write must not touch A");
  assert.deepEqual(sets.getWidths(b.id), { sku: 130 });
});

test('deleting a company cascades to its widths row', { skip: skipReason }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-bulkwidths-cascade-'));
  db.initDb(dataDir);
  const company = companies.create({ name: 'Width Cascade', isActive: true });
  sets.setWidths(company.id, { name: 260 });
  db.getDb().prepare('DELETE FROM companies WHERE id = ?').run(company.id);
  assert.equal(sets.getWidths(company.id), null, 'orphan width rows must not survive the company');
  assert.equal(db.getDb().prepare('SELECT COUNT(*) AS n FROM bulk_column_widths').get().n, 0);
});
