/**
 * v0.1.84: "Stop access" — what happens to the accounts an owner inherits or
 * outgrows.
 *
 * The owner's situation, in his words: he restored a bundle from the previous
 * app, so the old accounts came with it — including one belonging to someone
 * who has stopped, and several he made while testing under names he has since
 * changed his mind about. His questions were: can I rename them, can I delete
 * them, which should I do, and do old records keep the old name?
 *
 * The answers this file pins, because they are properties of the data model
 * rather than of the screen:
 *
 *   1. RENAME FOLLOWS THE ACCOUNT. Products, brands, categories and companies
 *      store `updated_by_user_id`, and the audit log stores `user_id`. Both are
 *      ids, and the display name is looked up live from the users list, so one
 *      rename fixes the name shown against every past edit at once. Nothing
 *      needs rewriting, and no record keeps a stale name.
 *   2. DELETE DROPS THE NAME. `users:remove` deletes the row, so those ids stop
 *      resolving and History falls back to "Unknown user" (pinned in
 *      test/userAccessWiring.test.js, which reads the renderer's fallback).
 *      That is the right trade for a test account and the wrong one for a
 *      person whose work you may need to read later.
 *   3. STOP ACCESS KEEPS BOTH. `deactivated_at` is set, `getByToken` refuses
 *      the token — the single gate the HTTP API and the phone viewer's
 *      WebSocket both pass through — and the row (so the name) stays.
 *
 * RUNNING THIS. It drives the real module against a real temporary SQLite
 * database, because the property under test is a SQL WHERE clause: mirroring it
 * in a stub would reproduce the bug rather than catch it. That needs the native
 * `better-sqlite3` binding, which this project builds for Electron's ABI, so
 * plain `node --test` cannot load it:
 *
 *     npm run test:native
 *
 * Under `npm test` these cases SKIP with that command as the reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let db = null;
let users = null;
let skipReason = false;

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  db = require('../main/db/index');
  users = require('../main/db/users');
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

let counter = 0;
function freshDb() {
  counter += 1;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `msk-users-${counter}-`));
  db.initDb(dataDir);
  return dataDir;
}

test('the deactivated_at column is added to an existing users table', { skip: skipReason }, () => {
  freshDb();
  const cols = db.getDb().prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('deactivated_at'),
    'additive migration: an install that predates v0.1.84 gets the column without a schema bump');
  assert.equal(db.SCHEMA_VERSION, 2, 'and the schema version is untouched — a bump would wipe the catalog');
});

test('a stopped account keeps its name but its token stops authenticating', { skip: skipReason }, () => {
  freshDb();
  const assistant = users.create({ name: 'Sokha (testing)', role: 'editor' });
  const token = assistant.token;

  // Sanity: the token works while the account is active.
  assert.equal(users.getByToken(token)?.id, assistant.id);

  const stopped = users.setDeactivated(assistant.id, true);
  assert.ok(stopped.deactivatedAt, 'the timestamp is set');
  assert.equal(stopped.name, 'Sokha (testing)', 'the name is untouched');

  // Every authentication path goes through getByToken, so this one assertion
  // covers the desktop client API and the phone viewer's WebSocket.
  assert.equal(users.getByToken(token), null, 'a stopped account cannot sign in');
  assert.equal(users.getByToken(''), null, 'an empty token is still nobody');
  assert.equal(users.getByToken('not-a-real-token'), null);

  // The account is still there, still listed, and still resolvable by id — that
  // is what keeps History reading a real name.
  assert.equal(users.get(assistant.id).name, 'Sokha (testing)');
  assert.ok(users.list().some((u) => u.id === assistant.id), 'the admin must still see it to restore it');
  const attribution = users.list().find((u) => u.id === assistant.id);
  assert.equal(attribution.name, 'Sokha (testing)');
  assert.equal(attribution.role, 'editor', 'stopping access is not a role change');

  // And it is reversible with the SAME token — stopping access is not a
  // substitute for regenerating a token that leaked.
  const restored = users.setDeactivated(assistant.id, false);
  assert.equal(restored.deactivatedAt, null);
  assert.equal(users.getByToken(token)?.id, assistant.id, 'the original token works again');
});

test('a stopped account keeps the name on the records it wrote', { skip: skipReason }, () => {
  freshDb();
  const worker = users.create({ name: 'Employee 2', role: 'editor' });
  const admin = users.create({ name: 'Owner', role: 'admin' });

  // Stand in for a product the worker edited: the attribution column is the
  // account id, exactly as `main/ipc/products.js` writes it.
  const companies = require('../main/db/companies');
  const products = require('../main/db/products');
  const company = companies.create({ name: 'Shop', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'W-1', name: 'Widget' });
  db.getDb().prepare('UPDATE products SET updated_by_user_id = ? WHERE id = ?').run(worker.id, product.id);

  const attributionUsers = () => Object.fromEntries(users.list().map((u) => [u.id, u.name]));

  assert.equal(attributionUsers()[worker.id], 'Employee 2');

  // Rename: the id is stable, so the name against that record changes with it.
  users.update(worker.id, { name: 'Sokha' });
  assert.equal(attributionUsers()[worker.id], 'Sokha', 'a rename follows the record, it does not fork it');
  assert.equal(users.get(worker.id).id, worker.id);

  // Stop access: the name is still there for the record to resolve.
  users.setDeactivated(worker.id, true);
  assert.equal(attributionUsers()[worker.id], 'Sokha',
    'a stopped account still names its work — this is the whole point of stopping instead of deleting');

  // Delete: now the name is gone, which is what the UI warns about.
  users.remove(worker.id);
  assert.equal(attributionUsers()[worker.id], undefined, 'the deleted account no longer resolves');
  assert.equal(users.get(worker.id), null);
  const orphan = db.getDb().prepare('SELECT updated_by_user_id FROM products WHERE id = ?').get(product.id);
  assert.equal(orphan.updated_by_user_id, worker.id,
    'the record keeps the id it was given — the row is not rewritten or nulled by the delete');
  assert.ok(users.get(admin.id), 'and deleting one account never touches another');
});

test('stop and delete are different actions, and neither one breaks the accounts that remain', { skip: skipReason }, () => {
  freshDb();
  const owner = users.create({ name: 'Owner', role: 'admin' });
  const tester = users.create({ name: 'asdf', role: 'viewer' });

  users.setDeactivated(tester.id, true);
  assert.equal(users.list().length, 2, 'stop access does not remove the account');
  assert.equal(users.getByToken(owner.token)?.id, owner.id, 'the admin is unaffected');

  users.remove(tester.id);
  assert.equal(users.list().length, 1);
  assert.equal(users.getByToken(owner.token)?.id, owner.id);

  // Names must stay unique among the accounts that exist, which is what makes
  // "rename the test account to something real" safe to do in any order.
  const again = users.create({ name: 'asdf', role: 'viewer' });
  assert.ok(again.id, 'a deleted name can be reused');
  assert.throws(() => users.create({ name: 'ASDF' }), /already exists/, 'but not while it exists');
  assert.throws(() => users.setDeactivated('no-such-id', true), /not found/);
});
