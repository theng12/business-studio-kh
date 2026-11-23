/**
 * 0.1.120 rename — the profile folder must arrive under the new name with its
 * settings intact, and nothing the user owns may be overwritten.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adoptProfile } = require('../main/util/profileMigration');

const OLD = 'Media Studio KH';
const NEW = 'Business Studio KH';

function base() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'profile-migration-'));
}

test('the old profile moves to the new name, config intact', () => {
  const root = base();
  const from = path.join(root, OLD);
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, 'config.json'), '{"openaiApiKey":"k"}');
  fs.writeFileSync(path.join(from, 'data'), 'x');

  const r = adoptProfile({ base: root, fromName: OLD, toName: NEW });
  assert.equal(r.status, 'moved');
  assert.equal(fs.existsSync(from), false, 'the old folder is gone, not duplicated');
  assert.equal(fs.readFileSync(path.join(root, NEW, 'config.json'), 'utf8'), '{"openaiApiKey":"k"}');
  assert.equal(fs.readFileSync(path.join(root, NEW, 'data'), 'utf8'), 'x');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a new profile with no settings takes the old settings; a newer one is never overwritten', () => {
  const root = base();
  fs.mkdirSync(path.join(root, OLD));
  fs.writeFileSync(path.join(root, OLD, 'config.json'), '{"from":"old"}');
  fs.mkdirSync(path.join(root, NEW));

  const copied = adoptProfile({ base: root, fromName: OLD, toName: NEW });
  assert.equal(copied.status, 'config-copied');
  assert.equal(fs.readFileSync(path.join(root, NEW, 'config.json'), 'utf8'), '{"from":"old"}');
  fs.rmSync(root, { recursive: true, force: true });

  const root2 = base();
  fs.mkdirSync(path.join(root2, OLD));
  fs.writeFileSync(path.join(root2, OLD, 'config.json'), '{"from":"old"}');
  fs.mkdirSync(path.join(root2, NEW));
  fs.writeFileSync(path.join(root2, NEW, 'config.json'), '{"from":"new"}');

  const kept = adoptProfile({ base: root2, fromName: OLD, toName: NEW });
  assert.equal(kept.status, 'kept-both');
  assert.equal(fs.readFileSync(path.join(root2, NEW, 'config.json'), 'utf8'), '{"from":"new"}', 'the newer profile wins');
  fs.rmSync(root2, { recursive: true, force: true });
});

test('nothing to migrate is not an error', () => {
  const root = base();
  assert.equal(adoptProfile({ base: root, fromName: OLD, toName: NEW }).status, 'nothing-to-do');
  fs.rmSync(root, { recursive: true, force: true });
});
