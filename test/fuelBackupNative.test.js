/**
 * Fuel F1: backups and server bundles carry fuel/ (evidence photos) and hr/
 * (staff photos) — and RESTORE them. The first F1 build added both folders to
 * BACKUP_DATA_ENTRIES but not to the archive validator's top-level whitelist,
 * so a backup containing them was written fine and then refused on restore.
 * This drives the real backup → restore and bundle export → import with a
 * fuel photo and a staff photo, and checks both files come back byte-identical.
 *
 * RUNNING THIS. Real SQLite + real tar: `npm run test:native`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err?.message))) {
    skipReason = "better-sqlite3 is built for Electron's ABI — run `npm run test:native`";
  } else {
    throw err;
  }
}

let userDataRoot = '';
const fakeElectron = { app: { getPath: () => userDataRoot, getVersion: () => 'test' } };

let db; let companies; let employees; let fuel; let records; let photos; let createBackup; let restoreBackup; let exportBundle; let importBundle;
if (!skipReason) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  db = require('../main/db');
  companies = require('../main/db/companies');
  employees = require('../main/db/employees');
  fuel = require('../main/db/fuel');
  records = require('../main/db/fuelRecords');
  photos = require('../main/fuelPhotos');
  ({ createBackup, restoreBackup } = require('../main/backupManager'));
  ({ exportBundle, importBundle } = require('../main/serverBundle'));
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
function closeDb() { try { db.closeDb(); } catch (_) { /* not open */ } }

async function fixture() {
  closeDb();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mskh-fuel-backup-'));
  userDataRoot = path.join(root, 'user-data');
  const dataDir = path.join(root, 'data');
  await fsp.mkdir(userDataRoot, { recursive: true });
  await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir, firstLaunchHandled: true }));
  db.initDb(dataDir);
  return { root, dataDir };
}

async function seed(dataDir) {
  const sharp = require('sharp');
  const jpg = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 90, b: 160 } } }).jpeg().toBuffer();
  const company = companies.create({ name: 'Backup Farm', isActive: true });
  const emp = employees.create({ companyId: company.id, staffCode: 'S1', nameEn: 'Dara' });
  employees.setPhoto(emp.id, await photos.saveStaffPhoto(emp.id, jpg));
  const tank = fuel.createLocation({ companyId: company.id, name: 'Tank', kind: 'tank' });
  const { dip } = records.createDip({ companyId: company.id, locationId: tank.id, litres: 900 });
  const prepared = await photos.prepareUploads('dip', [{ kind: 'stick', bytes: jpg }]);
  const staged = photos.stagePhotos({ recordId: dip.id, at: dip.takenAt, photos: prepared });
  records.insertPhotoRow({ ...staged.rows[0], companyId: company.id, ownerKind: 'dip', ownerId: dip.id });
  staged.commit();
  const staffRel = employees.getRow(emp.id).photo_path;
  const fuelRel = staged.rows[0].relPath;
  return {
    staffRel, fuelRel,
    staffSha: sha(fs.readFileSync(path.join(dataDir, staffRel))),
    fuelSha: sha(fs.readFileSync(path.join(dataDir, fuelRel))),
  };
}

function assertBack(dataDir, s) {
  assert.ok(s.staffRel.startsWith('hr/'));
  assert.ok(s.fuelRel.startsWith('fuel/'));
  assert.equal(sha(fs.readFileSync(path.join(dataDir, s.staffRel))), s.staffSha);
  assert.equal(sha(fs.readFileSync(path.join(dataDir, s.fuelRel))), s.fuelSha);
}

test('backup → restore brings back fuel/ and hr/ photos byte-identical', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const s = await seed(env.dataDir);
    const archive = await createBackup({ destDir: path.join(env.root, 'backups') });
    // Damage the live copies so the restore has to put them back.
    fs.writeFileSync(path.join(env.dataDir, s.fuelRel), 'changed');
    fs.writeFileSync(path.join(env.dataDir, s.staffRel), 'changed');
    const restored = await restoreBackup({ backupPath: archive.backupPath });
    assert.equal(restored.success, true);
    closeDb();
    assertBack(env.dataDir, s);
  } finally {
    closeDb();
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});

test('server bundle export → import carries fuel/ and hr/', { skip: skipReason }, async () => {
  const env = await fixture();
  try {
    const s = await seed(env.dataDir);
    const bundle = await exportBundle({ outputPath: path.join(env.root, 'farm.iskhbundle') });
    closeDb();
    const target = path.join(env.root, 'import-target');
    await fsp.writeFile(path.join(userDataRoot, 'config.json'), JSON.stringify({ dataDir: target, firstLaunchHandled: true }));
    const imported = await importBundle({ bundlePath: bundle.bundlePath, targetDataDir: target });
    assert.equal(imported.success, true);
    assertBack(target, s);
  } finally {
    closeDb();
    await fsp.rm(env.root, { recursive: true, force: true });
  }
});
