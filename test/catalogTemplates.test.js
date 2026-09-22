/**
 * v0.1.63: Catalog templates — the storage rules.
 *
 * "We can't build a template for the catalog too — it doesn't have a builder at
 * all", so the builder is the feature. These cases pin the half of it that can
 * fail silently once the screen exists: a template must never keep which
 * products it was designed against, and it must survive a round trip through
 * real SQLite unchanged.
 *
 * RUNNING THIS. Real database through the real modules, so it needs the native
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
let templates = null;
let projects = null;
let model = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  templates = require('../main/db/catalogTemplates');
  projects = require('../main/db/catalogProjects');
  model = require('../main/util/catalogModel');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function freshCompany(name = 'Catalog Co') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-catalogtpl-'));
  db.initDb(dataDir);
  return companies.create({ name, isActive: true });
}

const LOOK = {
  pageSize: 'Letter', orientation: 'landscape', columns: 4, gapMm: 3, marginMm: 12,
  groupBy: 'category', sortBy: 'sku', theme: 'retail',
  primaryColor: '#7c2d12', accentColor: '#f97316', priceGroup: 'wholesale',
  currencySymbol: '៛', coverEnabled: false,
  fields: [{ key: 'sku', label: 'SKU', visible: true }, { key: 'name', label: 'Name', bold: true }],
};

test('the table exists and starts empty (additive, no schema bump)', { skip: skipReason }, () => {
  const company = freshCompany();
  const cols = db.getDb().prepare('PRAGMA table_info(catalog_templates)').all().map((c) => c.name);
  for (const col of ['id', 'company_id', 'name', 'description', 'config', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(col), `catalog_templates.${col} missing`);
  }
  assert.deepEqual(templates.list(company.id), []);
  assert.equal(db.SCHEMA_VERSION, 2, 'a new table must not need a version bump');
});

test('a template stores the look and the description', { skip: skipReason }, () => {
  const company = freshCompany('Look Co');
  const row = templates.create({ companyId: company.id, name: 'Dealer 4-up', description: 'Trade pricing', config: LOOK });
  assert.equal(row.name, 'Dealer 4-up');
  assert.equal(row.description, 'Trade pricing');
  assert.equal(row.config.pageSize, 'Letter');
  assert.equal(row.config.columns, 4);
  assert.equal(row.config.theme, 'retail');
  assert.equal(row.config.priceGroup, 'wholesale');
  assert.equal(row.config.coverEnabled, false);
  assert.deepEqual(row.config.fields.map((f) => f.key), ['sku', 'name']);
  assert.deepEqual(templates.list(company.id).map((t) => t.id), [row.id]);
});

test('a template never keeps which products it was designed on', { skip: skipReason }, () => {
  const company = freshCompany('No Selection Co');
  const row = templates.create({
    companyId: company.id,
    name: 'Was a filtered catalog',
    config: {
      ...LOOK,
      selectionMode: 'explicit',
      productIds: ['p1', 'p2'],
      brandIds: ['b1'],
      categoryIds: ['c1'],
    },
  });
  for (const key of model.CATALOG_SELECTION_KEYS) {
    assert.deepEqual(row.config[key], model.SELECTION_DEFAULTS[key],
      `the template kept the selection key "${key}" — a catalog made from it would ignore its own products`);
  }
  const raw = JSON.parse(db.getDb().prepare('SELECT config FROM catalog_templates WHERE id = ?').get(row.id).config);
  assert.deepEqual(raw.productIds, []);
  assert.deepEqual(raw.brandIds, []);
  assert.equal(row.config.columns, 4, 'the look survived the strip');
});

test('an update normalises the config and cannot reintroduce a selection', { skip: skipReason }, () => {
  const company = freshCompany('Update Co');
  const row = templates.create({ companyId: company.id, name: 'First', config: LOOK });
  const renamed = templates.update(row.id, { name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.config.columns, 4, 'a rename must not reset the look');

  const patched = templates.update(row.id, { config: { theme: 'minimal', productIds: ['x'], selectionMode: 'all' } });
  assert.equal(patched.config.theme, 'minimal');
  assert.equal(patched.config.columns, 4, 'config patches merge over the stored look');
  assert.deepEqual(patched.config.productIds, [], 'a patch cannot add a selection');
});

test('an optimistic-concurrency token is honoured', { skip: skipReason }, () => {
  const company = freshCompany('Conflict Co');
  const row = templates.create({ companyId: company.id, name: 'Draft', config: LOOK });
  assert.throws(
    () => templates.update(row.id, { name: 'Nope', expectedUpdatedAt: row.updatedAt - 1 }),
    /CONFLICT\|/,
  );
  assert.equal(templates.update(row.id, { name: 'Yes', expectedUpdatedAt: row.updatedAt }).name, 'Yes');
});

test('duplicate copies the look and delete removes the row', { skip: skipReason }, () => {
  const company = freshCompany('Duplicate Co');
  const row = templates.create({ companyId: company.id, name: 'Base', description: 'desc', config: LOOK });
  const copy = templates.duplicate(row.id);
  assert.notEqual(copy.id, row.id);
  assert.equal(copy.name, 'Base copy');
  assert.equal(copy.description, 'desc');
  assert.equal(copy.config.columns, row.config.columns);

  assert.equal(templates.remove(copy.id), true);
  assert.equal(templates.get(copy.id), null);
  assert.equal(templates.remove(copy.id), false);
});

test('templates are scoped to their company', { skip: skipReason }, () => {
  // Two companies in ONE database — freshCompany() re-inits, which would delete
  // the first company (and its templates) underneath us.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-catalogtpl-two-'));
  db.initDb(dataDir);
  const a = companies.create({ name: 'Company A', isActive: true });
  const b = companies.create({ name: 'Company B' });
  templates.create({ companyId: a.id, name: 'A only', config: LOOK });
  assert.deepEqual(templates.list(b.id), []);
  templates.create({ companyId: b.id, name: 'B only', config: LOOK });
  assert.deepEqual(templates.list(a.id).map((t) => t.name), ['A only']);
});

test('a project created from a template keeps the look and its own products', { skip: skipReason }, () => {
  const company = freshCompany('From Template Co');
  const template = templates.create({ companyId: company.id, name: 'Two-up', config: { ...LOOK, columns: 2, selectionMode: 'explicit', productIds: ['ghost'] } });
  const project = projects.create({
    companyId: company.id,
    name: 'Spring catalog',
    config: model.applyCatalogDesign(template.config, { selectionMode: 'explicit', productIds: ['real-1'] }),
  });
  assert.equal(project.config.columns, 2);
  assert.equal(project.config.theme, 'retail');
  assert.deepEqual(project.config.productIds, ['real-1'], 'the project keeps its own products, not the template\'s');
  assert.equal(project.config.cover.title, 'Spring catalog', 'a new project is named after itself');
});

test('a new project gets a complete, clamped config even with no template', { skip: skipReason }, () => {
  const company = freshCompany('Defaults Co');
  const project = projects.create({ companyId: company.id, name: 'Bare catalog', config: { columns: 99 } });
  assert.equal(project.config.columns, 5, 'clamped to what the renderer can draw');
  assert.equal(project.config.pageSize, 'A4');
  assert.equal(project.config.cover.title, 'Bare catalog');
  assert.deepEqual(project.config.fields.map((f) => f.key), model.DEFAULT_FIELDS.map((f) => f.key));
});
