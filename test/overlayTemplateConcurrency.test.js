const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let db; let templates; let skip = false;
try {
  new (require('better-sqlite3'))(':memory:').close();
  db = require('../main/db'); templates = require('../main/db/imageTemplates');
} catch (error) {
  if (error.code !== 'ERR_DLOPEN_FAILED') throw error;
  skip = "Run under Electron's Node via test:native";
}

test('global overlay templates reject stale drafts and advance revisions within one millisecond', { skip }, () => {
  // Isolated disposable DB; retain the temp fixture rather than deleting files.
  db.initDb(fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-overlay-revision-')));
  const realNow = Date.now;
  try {
    Date.now = () => 1000;
    const original = templates.create({ name: 'Global layout', elements: [{ id: 'el', x: 0 }] });
    const a = templates.update(original.id, { elements: [{ id: 'el', x: 1 }], expectedUpdatedAt: original.updatedAt });
    assert.equal(a.updatedAt, 1001);
    assert.throws(() => templates.update(original.id, { ...original, name: 'Stale Mac B', expectedUpdatedAt: original.updatedAt }), /CONFLICT\|/);
    assert.deepEqual(templates.get(original.id).elements, a.elements);
    assert.throws(() => templates.update(original.id, { name: 'Malformed', expectedUpdatedAt: '1001' }), /finite number/);
    const b = templates.update(original.id, { name: 'Latest', expectedUpdatedAt: a.updatedAt });
    assert.equal(b.updatedAt, 1002);
    assert.equal(templates.update(original.id, { name: 'Explicit overwrite' }).name, 'Explicit overwrite');
    const { validateArgs } = require('../main/util/validateArgs');
    for (const patch of [null, [], 'bad', { expectedUpdatedAt: null }, { expectedUpdatedAt: '1001' }, { expectedUpdatedAt: NaN }]) {
      assert.throws(() => validateArgs('templates:update', { id: original.id, patch }), /Bad request/);
    }
    validateArgs('templates:update', { id: original.id, patch: { name: 'Intentional overwrite' } });
  } finally { Date.now = realNow; db.closeDb(); }
});
