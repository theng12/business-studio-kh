// Owner rule 2026-11-12 (corrected): retention is automatic — keep the newest
// two installers in dist/, move older ones to the app's own `_trash/<date>
// retention/`, and honour the protected-version guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planRetention, retainDist, protectedVersions } = require('../scripts/retain-dist.js');

const dmg = (v) => `Business Studio KH-${v}.dmg`;
const makeDist = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retain-dist-'));
  const distDir = path.join(root, 'dist');
  const trashDir = path.join(root, 'trash');
  fs.mkdirSync(distDir);
  return { root, distDir, trashDir };
};

test('the two newest installers are kept and older ones retire, newest first', () => {
  const plan = planRetention([dmg('0.1.9'), dmg('0.1.10'), dmg('0.1.105'), dmg('0.1.107'), dmg('0.1.106'), 'notes.txt', 'Business Studio KH-0.1.107.dmg.blockmap']);
  assert.deepEqual(plan.kept, [dmg('0.1.107'), dmg('0.1.106')]);
  assert.deepEqual(plan.retired, [dmg('0.1.105'), dmg('0.1.10'), dmg('0.1.9')]);
});

test('a protected version named by a pin or the ledger is never retired', () => {
  const plan = planRetention([dmg('0.1.103'), dmg('0.1.104'), dmg('0.1.105'), dmg('0.1.106'), dmg('0.1.107')], 2, new Set(['0.1.105']));
  assert.deepEqual(plan.retired, [dmg('0.1.104'), dmg('0.1.103')]);
});

test('protected versions come from release.json, previous-release.json and the ledger', () => {
  const { distDir } = makeDist();
  fs.writeFileSync(path.join(distDir, 'release.json'), JSON.stringify({ version: '0.1.107' }));
  fs.writeFileSync(path.join(distDir, 'previous-release.json'), JSON.stringify({ version: '0.1.106' }));
  fs.writeFileSync(path.join(distDir, '.release-dist.json'), JSON.stringify({ releases: [{ version: '0.1.105' }] }));
  const guarded = protectedVersions(distDir);
  for (const v of ['0.1.107', '0.1.106', '0.1.105']) assert.ok(guarded.has(v), `${v} must be protected`);
});

test('retainDist moves old installers to the rotation folder and logs hash and destination', () => {
  const { distDir, trashDir } = makeDist();
  for (const v of ['0.1.103', '0.1.104', '0.1.105', '0.1.106', '0.1.107']) fs.writeFileSync(path.join(distDir, dmg(v)), v);
  fs.writeFileSync(path.join(distDir, 'builder-debug.yml'), 'x');

  const result = retainDist({ distDir, trashDir, log: () => {} });

  assert.deepEqual(result.kept, [dmg('0.1.107'), dmg('0.1.106')]);
  assert.deepEqual(fs.readdirSync(distDir).filter((n) => n.endsWith('.dmg')).sort(), [dmg('0.1.106'), dmg('0.1.107')].sort());
  assert.deepEqual(fs.readdirSync(trashDir).sort(), [dmg('0.1.103'), dmg('0.1.104'), dmg('0.1.105')].sort());

  const receipt = JSON.parse(fs.readFileSync(path.join(distDir, '.retention-receipt.json'), 'utf8'));
  assert.equal(receipt.length, 3);
  for (const entry of receipt) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.to.startsWith(trashDir));
    assert.ok(entry.version);
  }
});
