/**
 * Fixed Assets A1 over IPC/RPC (docs/ASSETS_AND_BRANCHES_PLAN.md §3–§5, §8, §9).
 *
 * Every data channel is `expose()`d — client Macs (and, from A3, the `/a`
 * phone page) call them over `/api/rpc`; the capability gate decides who may
 * (main/util/capabilities.js):
 *   assets.view    the register, asset pages, schedules, events (read-only, with values)
 *   assets.manage  everything that writes, plus the import
 *   assets.count   `assets:getFile` only, narrowed to photos (A3 adds the count channels)
 * The local-only channels are `assets:saveImportSample` and
 * `assets:saveWorkbook` (a Save dialog on the Mac you sit at).
 *
 * The full channel list lives at the end of docs/ASSETS_AND_BRANCHES_PLAN.md
 * ("Assets API").
 */

const fixedAssets = require('../db/fixedAssets');
const config = require('../db/assetConfig');
const fileIndex = require('../db/assetFileIndex');
const identity = require('../db/assetIdentity');
const assetImport = require('../db/assetImport');
const ledger = require('../db/ledger');
const assetFiles = require('../assetFiles');
const dep = require('../db/assetDepreciation');
const disposals = require('../db/assetDisposals');
const assetTax = require('../db/assetTax');
const reports = require('../db/assetReports');
const { has, callerCanView, callerIsAdmin, assetCompany, inCompany, emitAssetChange } = require('./assetAccess');

const INTERNAL_CREATE_KEYS = ['origin', 'fuelAssetId', 'needsCost', 'companyId'];

function strip(input, keys) {
  const out = { ...(input || {}) };
  for (const k of keys) delete out[k];
  return out;
}

function assetIn(id) {
  assetCompany();
  return inCompany(fixedAssets.get(id), 'Asset');
}

function fuelSummary(a) {
  if (!a.fuelAssetId) return null;
  try {
    const f = require('../db/fuel').getAsset(a.fuelAssetId);
    return f ? { id: f.id, name: f.name, typeName: f.typeName, status: f.status, fuelType: f.fuelType, meterUnit: f.meterUnit } : null;
  } catch (_) { return null; }
}

function register({ expose, exposeLocal }) {
  /* ─── settings + categories ─── */
  expose('assets:getSettings', () => config.getSettings(assetCompany()));
  expose('assets:updateSettings', (patch = {}) => {
    const companyId = assetCompany();
    const s = config.updateSettings(companyId, patch || {});
    emitAssetChange('settings', 'update', companyId, companyId);
    return s;
  });
  expose('assets:listCategories', (opts = {}) => config.listCategories(assetCompany(), opts || {}));
  expose('assets:createCategory', (input = {}) => {
    const companyId = assetCompany(input.companyId);
    const c = config.createCategory({ ...input, companyId });
    emitAssetChange('category', 'create', c.id, companyId);
    return c;
  });
  expose('assets:updateCategory', ({ id, patch } = {}) => {
    assetCompany();
    inCompany(config.getCategory(id), 'Category');
    // §9: once assets in it have posted, its tax class / accounts are the admin's to change.
    const c = config.updateCategory(id, patch || {}, { allowPostedChanges: callerIsAdmin() });
    emitAssetChange('category', 'update', id, c.companyId);
    return c;
  });

  /* ─── the register ─── */
  expose('assets:list', (filters = {}) => fixedAssets.list(assetCompany(), filters || {}));
  expose('assets:get', (id) => {
    const a = assetIn(id);
    return {
      ...a,
      files: fileIndex.list(a.id).map(fileIndex.publicFile),
      events: fixedAssets.listEvents(a.companyId, { assetId: a.id, limit: 100 }),
      ledger: ledger.assetLedgerTotals(a.id),
      fuel: fuelSummary(a),
    };
  });
  expose('assets:create', (input = {}) => {
    const companyId = assetCompany(input.companyId);
    const a = fixedAssets.create({ ...strip(input, INTERNAL_CREATE_KEYS), companyId });
    emitAssetChange('asset', 'create', a.id, companyId);
    return a;
  });
  expose('assets:update', ({ id, patch } = {}) => {
    assetIn(id);
    const a = fixedAssets.update(id, patch || {});
    emitAssetChange('asset', 'update', id, a.companyId);
    return a;
  });
  expose('assets:previewActivation', (id) => {
    assetIn(id);
    return fixedAssets.previewActivation(id);
  });
  expose('assets:activate', (id) => {
    const before = assetIn(id);
    const res = fixedAssets.activate(id);
    emitAssetChange('asset', 'activate', id, before.companyId);
    return res;
  });
  expose('assets:cancelDraft', ({ id, reason } = {}) => {
    const before = assetIn(id);
    const a = fixedAssets.cancelDraft(id, reason);
    emitAssetChange('asset', 'cancel', id, before.companyId);
    return a;
  });

  /* ─── photos and documents (evidence under fixed-assets/) ─── */
  expose('assets:addFile', async ({ assetId, kind, bytes, originalName = null } = {}) => {
    const a = assetIn(assetId);
    if (a.recordState === 'cancelled') throw new Error('A cancelled draft takes no more files');
    const settings = config.getSettings(a.companyId);
    const isPhoto = kind === 'photo';
    const have = fileIndex.countLive(a.id, isPhoto);
    const cap = isPhoto ? settings.photoCapPerAsset : assetFiles.MAX_DOCUMENTS_PER_ASSET;
    if (have >= cap) throw new Error(`This asset already has ${have} ${isPhoto ? 'photos' : 'documents'} — the most is ${cap}`);
    const prepared = await assetFiles.prepareFile(kind, bytes);
    const staged = assetFiles.stageFile({ assetId: a.id, kind, prepared, originalName });
    let file;
    try {
      require('../db/index').getDb().transaction(() => {
        file = fileIndex.insert({ companyId: a.companyId, assetId: a.id, row: staged.row });
      })();
    } catch (err) {
      staged.abort();
      throw err;
    }
    staged.commit();
    require('../db/_assetUtil').audit('fixed_asset', a.id, 'file:add', { after: { fileId: file.id, kind, sha256: file.sha256, mime: file.mime } });
    emitAssetChange('asset', 'update', a.id, a.companyId);
    return fileIndex.publicFile(file);
  });
  /**
   * A file's bytes (or a 320 px thumbnail of a photo). assets.view / manage:
   * any file. assets.count only: photos only (A3 narrows further to the
   * branch being counted).
   */
  expose('assets:getFile', async ({ fileId, thumb = false } = {}) => {
    const f = fileIndex.get(fileId);
    if (!f) throw new Error('File not found');
    inCompany(f, 'File');
    if (!callerCanView() && f.kind !== 'photo') throw new Error('You can only see asset photos');
    if (f.retired && !callerCanView()) throw new Error('File not found');
    const out = await assetFiles.readFile(f.relPath, { thumb: thumb === true, expectedSha256: f.sha256, mime: f.mime });
    return { bytes: out.bytes, mime: out.mime, intact: out.intact, sha256: f.sha256, kind: f.kind, uploadedAt: f.uploadedAt, retired: f.retired };
  });
  expose('assets:reorderFiles', ({ assetId, fileIds } = {}) => {
    const a = assetIn(assetId);
    const res = fileIndex.reorderPhotos(a.id, fileIds).map(fileIndex.publicFile);
    emitAssetChange('asset', 'update', a.id, a.companyId);
    return res;
  });
  expose('assets:retireFile', ({ fileId, reason } = {}) => {
    const f = fileIndex.get(fileId);
    if (!f) throw new Error('File not found');
    assetCompany();
    inCompany(f, 'File');
    const res = fileIndex.publicFile(fileIndex.retire(fileId, reason));
    emitAssetChange('asset', 'update', f.assetId, f.companyId);
    return res;
  });

  /* ─── events ─── */
  expose('assets:transfer', (args = {}) => {
    const companyId = assetCompany();
    const res = fixedAssets.transfer({ ...args, companyId });
    for (const m of res.moved) emitAssetChange('asset', 'transfer', m.assetId, companyId);
    return res;
  });
  /** An event on one asset: same company, then the live-update event. */
  const onAsset = (fn, op) => (args = {}) => {
    const a = assetIn(args.id);
    const res = fn(args);
    emitAssetChange('asset', op, a.id, a.companyId);
    return res;
  };
  expose('assets:setCustodian', onAsset(fixedAssets.setCustodian, 'custodian'));
  expose('assets:setStatus', onAsset(fixedAssets.setStatus, 'status'));
  expose('assets:recordRepair', onAsset(fixedAssets.recordRepair, 'repair'));
  expose('assets:recordCapex', onAsset(fixedAssets.recordCapex, 'capex'));
  expose('assets:changeLife', onAsset(fixedAssets.changeLife, 'life_change'));
  expose('assets:changeSalvage', onAsset(fixedAssets.changeSalvage, 'salvage_change'));
  expose('assets:addNote', onAsset(fixedAssets.addNote, 'note'));
  expose('assets:voidEvent', ({ id, reason } = {}) => {
    assetCompany();
    const e = inCompany(fixedAssets.getEvent(id), 'Event');
    const res = fixedAssets.voidEvent(id, reason);
    emitAssetChange('asset', 'void-event', e.assetId, e.companyId);
    return res;
  });
  expose('assets:reverseEvent', ({ id, reason } = {}) => {
    assetCompany();
    const e = inCompany(fixedAssets.getEvent(id), 'Event');
    const res = fixedAssets.reverseEvent(id, reason);
    emitAssetChange('asset', 'reverse-event', e.assetId, e.companyId);
    return res;
  });
  expose('assets:listEvents', (filters = {}) => {
    const companyId = assetCompany();
    if (filters?.assetId) inCompany(fixedAssets.get(filters.assetId), 'Asset');
    return fixedAssets.listEvents(companyId, filters || {});
  });

  /* ─── schedules ─── */
  expose('assets:getSchedule', ({ id, basis = 'book' } = {}) => {
    assetIn(id);
    return fixedAssets.getSchedule(id, basis);
  });

  /* ─── A2: monthly depreciation (computed − posted), §5.5 ─── */
  expose('assets:previewDepreciation', ({ period } = {}) => dep.previewDepreciation(assetCompany(), period));
  expose('assets:runDepreciation', ({ period } = {}) => {
    const companyId = assetCompany();
    const res = dep.runDepreciation(companyId, period, { kind: 'manual' });
    emitAssetChange('run', 'post', period, companyId);
    return res;
  });
  expose('assets:listRuns', () => dep.listRuns(assetCompany()));
  expose('assets:reverseRun', ({ period, reason } = {}) => {
    const companyId = assetCompany();
    const res = dep.reverseRun(companyId, period, reason);
    emitAssetChange('run', 'reverse', period, companyId);
    return res;
  });
  expose('assets:checkIntegrity', () => dep.checkIntegrity(assetCompany()));

  /* ─── A2: disposals, write-offs, impairment, revaluation ─── */
  expose('assets:previewDisposal', (args = {}) => {
    assetIn(args.id);
    return disposals.previewDisposal(args);
  });
  expose('assets:dispose', onAsset(disposals.dispose, 'dispose'));
  expose('assets:partialDispose', onAsset(disposals.partialDispose, 'partial_dispose'));
  expose('assets:markLost', onAsset(disposals.markLost, 'lost'));
  expose('assets:markFound', onAsset(disposals.markFound, 'found'));
  expose('assets:impair', onAsset(disposals.impair, 'impair'));
  expose('assets:revalue', onAsset(disposals.revalue, 'revalue'));

  /* ─── A2: the tax year (never posted), §4.3 ─── */
  expose('assets:getTaxYear', ({ year } = {}) => assetTax.getTaxYear(assetCompany(), year));
  expose('assets:setPoolOpening', (args = {}) => {
    const companyId = assetCompany();
    const res = assetTax.setPoolOpening(companyId, args);
    emitAssetChange('tax', 'update', String(args.year), companyId);
    return res;
  });
  expose('assets:markTaxYearFiled', ({ year } = {}) => {
    const companyId = assetCompany();
    const res = assetTax.markTaxYearFiled(companyId, year);
    emitAssetChange('tax', 'file', String(year), companyId);
    return res;
  });
  expose('assets:unfileTaxYear', ({ year, reason } = {}) => {
    const companyId = assetCompany();
    const res = assetTax.unfileTaxYear(companyId, year, reason);
    emitAssetChange('tax', 'unfile', String(year), companyId);
    return res;
  });

  /* ─── A2: reports and the workbook ─── */
  expose('assets:getReport', (args = {}) => reports.getReport(assetCompany(), args || {}));
  expose('assets:getWorkbook', (args = {}) => reports.getWorkbook(assetCompany(), args || {}));
  /** Save the workbook through a dialog on THIS Mac (client mode has its own copy). */
  exposeLocal('assets:saveWorkbook', async (args = {}) => {
    const { dialog } = require('electron');
    const { filename, bytes } = reports.getWorkbook(assetCompany(), args || {});
    const res = await dialog.showSaveDialog({ title: 'Save fixed-asset workbook', defaultPath: filename, filters: [{ name: 'Workbook', extensions: ['xlsx'] }] });
    if (res.canceled || !res.filePath) return null;
    require('node:fs').writeFileSync(res.filePath, bytes);
    return res.filePath;
  });

  /* ─── the Fuel link ─── */
  expose('assets:linkFuelAsset', ({ id, fuelAssetId } = {}) => {
    const a = assetIn(id);
    identity.link(id, fuelAssetId);
    emitAssetChange('asset', 'update', id, a.companyId);
    return fixedAssets.get(id);
  });
  expose('assets:unlinkFuelAsset', ({ id, reason } = {}) => {
    const a = assetIn(id);
    identity.unlink(id, reason);
    emitAssetChange('asset', 'update', id, a.companyId);
    return fixedAssets.get(id);
  });
  /** "Track fuel for this": creates the Fuel vehicle — a Fuel configuration write, so fuel.manage is needed too. */
  expose('assets:createFuelAsset', ({ id, ...fuelInput } = {}) => {
    const a = assetIn(id);
    if (!has('fuel.manage')) throw new Error('Adding a vehicle to Fuel needs the "Manage fuel" permission');
    const f = identity.createFuelAssetFor(id, strip(fuelInput, ['companyId', 'name', 'plateOrSerial', 'assignedEmployeeId']));
    emitAssetChange('asset', 'update', id, a.companyId);
    return { asset: fixedAssets.get(id), fuelAsset: f };
  });

  /* ─── import (§11 wizard: pick → map → review) ─── */
  expose('assets:importColumns', () => assetImport.importColumns());
  expose('assets:importPlan', ({ rows } = {}) => assetImport.planImport(assetCompany(), rows));
  expose('assets:importApply', ({ rows } = {}) => {
    const companyId = assetCompany();
    const res = assetImport.applyImport(companyId, rows);
    emitAssetChange('asset', 'import', null, companyId);
    return res;
  });
  expose('assets:getImportSample', () => assetImport.sampleWorkbook(assetCompany()));
  /** Save the sample through a dialog on THIS Mac (client mode has its own copy). */
  exposeLocal('assets:saveImportSample', async () => {
    const { dialog } = require('electron');
    const { filename, bytes } = assetImport.sampleWorkbook(assetCompany());
    const res = await dialog.showSaveDialog({ title: 'Save sample workbook', defaultPath: filename, filters: [{ name: 'Workbook', extensions: ['xlsx'] }] });
    if (res.canceled || !res.filePath) return null;
    require('node:fs').writeFileSync(res.filePath, bytes);
    return res.filePath;
  });
}

module.exports = { register };
