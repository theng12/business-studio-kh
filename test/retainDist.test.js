// Owner rule 2026-11-12: retention is automatic — keep the newest two
// installers in dist/, move anything older straight to the macOS Trash.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planRetention, retainDist } = require('../scripts/retain-dist.js');

const dmg = (v) => `Media Studio KH-${v}.dmg`;

test('the two newest installers are kept and older ones retire, newest first', () => {
  const plan = planRetention([dmg('0.1.9'), dmg('0.1.10'), dmg('0.1.107'), dmg('0.1.106'), 'notes.txt', 'Media Studio KH-0.1.107.dmg.blockmap']);
  assert.deepEqual(plan.kept, [dmg('0.1.107'), dmg('0.1.106')]);
  assert.deepEqual(plan.retired, [dmg('0.1.10'), dmg('0.1.9')]);
});

test('non-installer files are never considered', () => {
  const plan = planRetention(['latest-mac.yml', dmg('0.1.107')]);
  assert.deepEqual(plan.retired, []);
});

test('retainDist moves old installers into the Trash and keeps the newest two', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retain-dist-'));
  const distDir = path.join(root, 'dist');
  const trashDir = path.join(root, 'Trash');
  fs.mkdirSync(distDir);
  fs.mkdirSync(trashDir);
  for (const v of ['0.1.104', '0.1.105', '0.1.106', '0.1.107']) fs.writeFileSync(path.join(distDir, dmg(v)), 'x');
  fs.writeFileSync(path.join(distDir, 'builder-debug.yml'), 'x');

  const result = retainDist({ distDir, trashDir, log: () => {} });

  assert.deepEqual(result.kept, [dmg('0.1.107'), dmg('0.1.106')]);
  assert.deepEqual(fs.readdirSync(distDir).sort(), [dmg('0.1.106'), dmg('0.1.107'), 'builder-debug.yml'].sort());
  assert.deepEqual(fs.readdirSync(trashDir).sort(), [dmg('0.1.104'), dmg('0.1.105')].sort());
});
