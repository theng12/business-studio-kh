/**
 * v0.1.62: Social Grid templates.
 *
 * The customer's report was "the social grid doesn't have a template and we
 * can't pick and apply it from the product library". A saved post has always
 * been "these products, drawn like this"; a template is only "drawn like this",
 * which is what makes it reusable and what makes it applicable to a hand-picked
 * selection in the Library.
 *
 * The rule these cases pin down is the one that can silently break the feature:
 * a template must NEVER carry a product selection. If `designOnly()` ever stops
 * stripping those keys, applying a template would quietly drag in whatever
 * brand/category/hand-picked list it was designed on — and it would look like
 * the Library's selection was being ignored.
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
let templates = null;
let presets = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  templates = require('../main/db/socialGridTemplates');
  presets = require('../main/db/socialGridPresets');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function freshCompany(name = 'Social Co') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-socialtpl-'));
  db.initDb(dataDir);
  return companies.create({ name, isActive: true });
}

const LOOK = {
  width: 1080, height: 1350, columns: 2, rows: 3,
  showPrice: false, showBrand: true, title: 'Sale', sortBy: 'priceLow',
  background: '#0f172a',
};

test('the table exists and starts empty (additive, no schema bump)', { skip: skipReason }, () => {
  const company = freshCompany();
  const cols = db.getDb().prepare('PRAGMA table_info(social_grid_templates)').all().map((c) => c.name);
  for (const col of ['id', 'company_id', 'name', 'config', 'created_at', 'updated_at']) {
    assert.ok(cols.includes(col), `social_grid_templates.${col} missing`);
  }
  assert.deepEqual(templates.list(company.id), []);
});

test('a template stores the look', { skip: skipReason }, () => {
  const company = freshCompany('Look Co');
  const row = templates.create({ companyId: company.id, name: 'Portrait promo', config: LOOK });
  assert.equal(row.name, 'Portrait promo');
  assert.equal(row.config.width, 1080);
  assert.equal(row.config.height, 1350);
  assert.equal(row.config.columns, 2);
  assert.equal(row.config.rows, 3);
  assert.equal(row.config.showPrice, false);
  assert.equal(row.config.title, 'Sale');
  assert.equal(row.config.sortBy, 'priceLow');
  // Surfaced by list() too, not just get().
  assert.deepEqual(templates.list(company.id).map((t) => t.id), [row.id]);
});

test('a template never keeps which products it was designed on', { skip: skipReason }, () => {
  const company = freshCompany('No Selection Co');
  const row = templates.create({
    companyId: company.id,
    name: 'Was on a brand',
    config: {
      ...LOOK,
      source: 'brand',
      brandId: 'brand-123',
      categoryId: 'cat-9',
      subcategory: 'Taps',
      productIds: ['p1', 'p2'],
      stockScope: 'low',
      lowStockAt: 3,
      stockMin: 2,
      stockMax: 8,
      limit: 12,
      excludeInactive: false,
    },
  });
  const defaults = require('../main/util/socialGridModel').DEFAULTS;
  for (const key of ['source', 'brandId', 'categoryId', 'subcategory', 'productIds',
    'stockScope', 'lowStockAt', 'stockMin', 'stockMax', 'limit', 'excludeInactive']) {
    assert.deepEqual(row.config[key], defaults[key],
      `template kept the selection key "${key}" — applying it would ignore the Library's selection`);
  }
  // And the stored JSON is clean, not just the returned object.
  const raw = JSON.parse(db.getDb().prepare('SELECT config FROM social_grid_templates WHERE id = ?').get(row.id).config);
  assert.equal(raw.brandId, null);
  assert.deepEqual(raw.productIds, []);
  // The look survived the strip.
  assert.equal(row.config.height, 1350);
});

test('an update normalises the config and keeps the name when only the look is patched', { skip: skipReason }, () => {
  const company = freshCompany('Update Co');
  const row = templates.create({ companyId: company.id, name: 'First', config: LOOK });
  const renamed = templates.update(row.id, { name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.config.columns, 2, 'a name-only patch must not reset the look');

  const recoloured = templates.update(row.id, { config: { background: '#ffffff', source: 'picked', productIds: ['x'] } });
  assert.equal(recoloured.config.background, '#ffffff');
  assert.equal(recoloured.config.columns, 2, 'config patches merge over the stored look');
  assert.equal(recoloured.config.source, 'all', 'a config patch cannot reintroduce a selection');
  assert.deepEqual(recoloured.config.productIds, []);
});

test('an optimistic-concurrency token is honoured', { skip: skipReason }, () => {
  const company = freshCompany('Conflict Co');
  const row = templates.create({ companyId: company.id, name: 'Draft', config: LOOK });
  assert.throws(
    () => templates.update(row.id, { name: 'Nope', expectedUpdatedAt: row.updatedAt - 1 }),
    /CONFLICT\|/,
  );
  const ok = templates.update(row.id, { name: 'Yes', expectedUpdatedAt: row.updatedAt });
  assert.equal(ok.name, 'Yes');
});

test('duplicate copies the look, not the products, and delete removes it', { skip: skipReason }, () => {
  const company = freshCompany('Duplicate Co');
  const row = templates.create({ companyId: company.id, name: 'Squares', config: LOOK });
  const copy = templates.duplicate(row.id);
  assert.notEqual(copy.id, row.id);
  assert.equal(copy.name, 'Squares copy');
  assert.equal(copy.config.columns, row.config.columns);
  assert.equal(copy.companyId, company.id);

  assert.equal(templates.remove(copy.id), true);
  assert.equal(templates.get(copy.id), null);
  assert.equal(templates.remove(copy.id), false, 'deleting twice reports no change');
});

test('templates are scoped to their company', { skip: skipReason }, () => {
  // Two companies in ONE database — freshCompany() re-inits the DB, so calling
  // it twice would delete the first company (and its templates) underneath us.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-socialtpl-two-'));
  db.initDb(dataDir);
  const a = companies.create({ name: 'Company A', isActive: true });
  const b = companies.create({ name: 'Company B' });
  templates.create({ companyId: a.id, name: 'A only', config: LOOK });
  assert.deepEqual(templates.list(b.id), []);
  templates.create({ companyId: b.id, name: 'B only', config: LOOK });
  assert.deepEqual(templates.list(a.id).map((t) => t.name), ['A only']);
  assert.deepEqual(templates.list(b.id).map((t) => t.name), ['B only']);
});

test('a post and a template are independent rows with independent looks', { skip: skipReason }, () => {
  const company = freshCompany('Both Co');
  const post = presets.create({
    companyId: company.id, name: 'My post',
    config: { ...LOOK, source: 'brand', brandId: 'b7', columns: 4 },
  });
  const tpl = templates.create({ companyId: company.id, name: 'My look', config: post.config });

  // Editing one must not touch the other.
  presets.update(post.id, { name: 'My post (edited)', config: { ...post.config, columns: 5 } });
  assert.equal(templates.get(tpl.id).config.columns, 4, 'template changed when the post did');
  assert.equal(presets.get(post.id).config.brandId, 'b7', 'post lost its own selection');
  // The template kept the look and dropped the selection, as always.
  assert.equal(templates.get(tpl.id).config.source, 'all');
});
