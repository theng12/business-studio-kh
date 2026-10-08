/**
 * Export profile image scope (All / Main only / First N) lives on the profile
 * (export_profiles.image_scope) so it syncs between Macs, and the store passes
 * it to every run and collision check.
 *
 * The DB cases need better-sqlite3 built for Electron's ABI: `npm run test:native`
 * (they SKIP under plain `npm test`). The rest is pure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const { normalizeProfileImageScope, serializeProfileImageScope } = require('../main/util/exportScope');
const { getValidator } = require('../main/server/validators');

test('normalizeProfileImageScope: valid shapes kept, everything else is "all"', () => {
  assert.deepEqual(normalizeProfileImageScope({ mode: 'all' }), { mode: 'all' });
  assert.deepEqual(normalizeProfileImageScope({ mode: 'main', count: 9 }), { mode: 'main' });
  assert.deepEqual(normalizeProfileImageScope({ mode: 'first', count: 3 }), { mode: 'first', count: 3 });
  assert.deepEqual(normalizeProfileImageScope({ mode: 'first', count: '4' }), { mode: 'first', count: 4 });
  assert.deepEqual(normalizeProfileImageScope({ mode: 'first', count: 400 }), { mode: 'first', count: 50 });
  assert.deepEqual(normalizeProfileImageScope({ mode: 'first', count: 0 }), { mode: 'all' });
  assert.deepEqual(normalizeProfileImageScope({ mode: 'first' }), { mode: 'all' });
  assert.deepEqual(normalizeProfileImageScope({ mode: 'odd' }), { mode: 'all' });
  for (const junk of [null, undefined, 7, [], 'not json', '{"mode":']) {
    assert.deepEqual(normalizeProfileImageScope(junk), { mode: 'all' }, String(junk));
  }
});

test('serialize round-trips through the column text', () => {
  const text = serializeProfileImageScope({ mode: 'first', count: 3 });
  assert.equal(text, '{"mode":"first","count":3}');
  assert.deepEqual(normalizeProfileImageScope(text), { mode: 'first', count: 3 });
  assert.equal(serializeProfileImageScope(undefined), '{"mode":"all"}');
});

test('profile create/update validators accept and reject imageScope', () => {
  const create = getValidator('exports:createProfile');
  assert.equal(create({ name: 'A' }), true);
  assert.equal(create({ name: 'A', imageScope: { mode: 'main' } }), true);
  assert.equal(create({ name: 'A', imageScope: null }), true);
  assert.match(String(create({ name: 'A', imageScope: { mode: 'first', count: 0 } })), /count/);
  assert.match(String(create({ name: 'A', imageScope: { mode: 'odd' } })), /mode/);
  const update = getValidator('exports:updateProfile');
  assert.equal(update({ id: 'p', patch: { imageScope: { mode: 'first', count: 2 } } }), true);
  assert.match(String(update({ id: 'p', patch: { imageScope: 'all' } })), /imageScope/);
});

test('the store sends the selected profile scope on run and collision check; the screen has no direct calls', () => {
  const store = read('renderer/store/exports.js');
  assert.match(store, /exportOutputRoot,\s*selectedProfileScope\(get\(\)\),/, 'checkCollisions gets the scope');
  assert.match(store, /runId,\s*selectedProfileScope\(get\(\)\),/, 'run gets the scope');
  const screen = read('renderer/modules/ExportCenter/index.jsx');
  assert.doesNotMatch(screen, /window\.api\.exports\.(run|checkCollisions)\(/);
  assert.doesNotMatch(screen, /saveImageScope|loadImageScope\(/);
  assert.match(screen, /updateProfile\(selectedId, \{ imageScope/);
});

/* ── DB-backed (test:native) ─────────────────────────────────────────── */

let db = null;
let companies = null;
let profiles = null;
let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  companies = require('../main/db/companies');
  profiles = require('../main/db/exportProfiles');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

function freshCompany() {
  db.initDb(fs.mkdtempSync(path.join(os.tmpdir(), 'msk-scope-')));
  return companies.create({ name: 'Scope Co', isActive: true });
}

test('image_scope column is additive and legacy NULL reads as all', { skip: skipReason }, () => {
  const company = freshCompany();
  const cols = db.getDb().prepare('PRAGMA table_info(export_profiles)').all().map((c) => c.name);
  assert.ok(cols.includes('image_scope'));
  const p = profiles.create({ companyId: company.id, name: 'Plain' });
  assert.deepEqual(p.imageScope, { mode: 'all' });
  db.getDb().prepare('UPDATE export_profiles SET image_scope = NULL WHERE id = ?').run(p.id);
  assert.deepEqual(profiles.get(p.id).imageScope, { mode: 'all' });
  db.getDb().prepare("UPDATE export_profiles SET image_scope = 'garbage' WHERE id = ?").run(p.id);
  assert.deepEqual(profiles.get(p.id).imageScope, { mode: 'all' });
});

test('imageScope is saved on create, update and duplicate', { skip: skipReason }, () => {
  const company = freshCompany();
  const p = profiles.create({ companyId: company.id, name: 'Scoped', imageScope: { mode: 'first', count: '3' } });
  assert.deepEqual(p.imageScope, { mode: 'first', count: 3 });
  assert.deepEqual(profiles.update(p.id, { imageScope: { mode: 'main' } }).imageScope, { mode: 'main' });
  assert.deepEqual(profiles.update(p.id, { name: 'Renamed' }).imageScope, { mode: 'main' }, 'untouched by other patches');
  assert.deepEqual(profiles.update(p.id, { imageScope: { mode: 'first', count: 999 } }).imageScope, { mode: 'first', count: 50 });
  assert.deepEqual(profiles.update(p.id, { imageScope: { mode: 'bogus' } }).imageScope, { mode: 'all' });
  profiles.update(p.id, { imageScope: { mode: 'first', count: 2 } });
  assert.deepEqual(profiles.duplicate(p.id).imageScope, { mode: 'first', count: 2 });
  assert.deepEqual(profiles.list(company.id).map((x) => x.imageScope.mode).sort(), ['first', 'first']);
});
