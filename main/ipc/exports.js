/**
 * v0.21.2: exports:* IPC handlers, extracted from ipc.js.
 *
 * Export profile CRUD (all exposed) + filename preview + the
 * standalone `exports:run` (writes to a path on the calling Mac)
 * + the client-mode `exports:runForClient` (returns bytes for the
 * client to write under its own outputRoot, 100MB cap).
 *
 * Both export-run handlers emit live progress events via the
 * broadcast bus (v0.17.1). Wrapped in try/finally so a thrown
 * export still clears the renderer's progress overlay.
 */

const fs = require('node:fs');
const path = require('node:path');

const companies = require('../db/companies');
const brands = require('../db/brands');
const exportProfiles = require('../db/exportProfiles');
const exportRuns = require('../db/exportRuns');
const exportRunner = require('../exportRunner');
const { broadcast } = require('../events');
const { emitCatalogChange } = require('./helpers');

/**
 * v0.1.89: running exports that may be cancelled, keyed by the progress-event
 * id the renderer already receives (`progress:event` with kind
 * 'export-run'). A run checks its entry between images. Entries leave the map
 * when the run ends, so a stale id is a harmless no-op.
 */
const activeRuns = new Map();

/**
 * The renderer picks the run id up front so its Cancel button targets exactly
 * its own run (never another Mac's). A supplied id is used only when it is a
 * short [A-Za-z0-9_-] string; anything else (or nothing, from an older
 * client) falls back to a server-generated id.
 */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
function pickRunId(runId) {
  if (typeof runId === 'string' && RUN_ID_RE.test(runId)) return runId;
  return `export-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function startRun(opId) {
  const run = { cancelled: false };
  activeRuns.set(opId, run);
  return run;
}

function cancelRun(opId) {
  const run = activeRuns.get(opId);
  if (!run) return { ok: false };
  run.cancelled = true;
  return { ok: true };
}

function register({ expose, assertEntityInActiveCompany, assertProductInActiveCompany, exposeLocal }) {
  /**
   * v0.1.89: stop a running export after the image in progress. Exposed (not
   * local) because in client mode the run happens on the server, inside
   * `exports:runForClient`; the id is the one the renderer chose when it started the run.
   */
  expose('exports:cancel', (runId) => cancelRun(String(runId || '')));

  // v0.14.4: read paths portable to clients.
  expose('exports:listProfiles', (companyId) => {
    if (companyId && companyId !== companies.getActiveId()) return [];
    return exportProfiles.list(companyId);
  });
  expose('exports:getProfile', (id) => {
    return assertEntityInActiveCompany(exportProfiles.get(id), 'Profile');
  });

  // v0.36.0: catalog feed / CSV export. Pure data (no fs), so it returns
  // the CSV text + a suggested filename; the renderer triggers the download
  // (works in standalone, server, AND the iPad web viewer). format is
  // 'generic' | 'shopify' | 'google'.
  expose('exports:catalogCsv', ({ companyId, format } = {}) => {
    if (companyId && companyId !== companies.getActiveId()) {
      // Mirror the read-path scoping the other list handlers use.
      return { csv: '', count: 0, filename: 'catalog.csv' };
    }
    const products = require('../db/products').list(companyId, {});
    const brandsById = new Map(require('../db/brands').list(companyId).map((b) => [b.id, b]));
    const categoriesById = new Map(require('../db/categories').list(companyId).map((c) => [c.id, c]));
    const { buildCatalogCsv } = require('../util/catalogCsv');
    const fmt = ['generic', 'shopify', 'google'].includes(format) ? format : 'generic';
    // v0.1.79: the company's own price groups travel with the sheet, so it
    // carries the same price columns the Excel export does.
    const priceGroups = require('../db/companies').get(companyId)?.priceGroups ?? [];
    const csv = buildCatalogCsv({ products, brandsById, categoriesById, priceGroups, format: fmt });
    return { csv, count: products.length, filename: `catalog-${fmt}.csv` };
  });

  // v0.15.0: export profile mutations exposed. The actual export
  // run stays local-only — see `exports:run` below.
  expose('exports:createProfile', (input) => {
    if (input?.companyId && input.companyId !== companies.getActiveId()) {
      throw new Error('Cross-company create blocked');
    }
    return exportProfiles.create(input);
  });
  expose('exports:updateProfile', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(exportProfiles.get(id), 'Profile');
    return exportProfiles.update(id, patch);
  });
  expose('exports:removeProfile', (id) => {
    assertEntityInActiveCompany(exportProfiles.get(id), 'Profile');
    return exportProfiles.remove(id);
  });
  expose('exports:duplicateProfile', (id) => {
    assertEntityInActiveCompany(exportProfiles.get(id), 'Profile');
    return exportProfiles.duplicate(id);
  });

  expose('exports:filenamePreview', ({ profileId, productId, imageIndex } = {}) => {
    const profile = assertEntityInActiveCompany(exportProfiles.get(profileId), 'Profile');
    const product = assertProductInActiveCompany(productId);
    if (!profile || !product) return '';
    const brand = product.brandId ? brands.get(product.brandId) : null;
    const dateStr = new Date().toISOString().slice(0, 10);
    const base = exportRunner.buildFilename(profile.namingPattern || '{SKU}-{INDEX}', {
      product, brand, imageIndex: imageIndex ?? 0, dateStr, profile,
    });
    const ext = profile.format === 'png' ? '.png' : profile.format === 'webp' ? '.webp' : '.jpg';
    return `${base}${ext}`;
  });

  /**
   * v0.26.24: dry-run collision check for "Always ask at export
   * time". The renderer calls this BEFORE exports:run so it can pop
   * a modal asking the user how to handle the collisions. We don't
   * cache anything here — the file system is the source of truth,
   * and a 1700-product preview only takes ~30ms because it's pure
   * existsSync calls, no sharp pipeline.
   */
  exposeLocal('exports:checkCollisions', ({ profileId, productIds, outputRoot, imageScope } = {}) => {
    const profile = assertEntityInActiveCompany(exportProfiles.get(profileId), 'Profile');
    for (const pid of (productIds ?? [])) assertProductInActiveCompany(pid);
    return exportRunner.previewCollisions({ profile, productIds, outputRoot, imageScope: exportRunner.normalizeExportScope(imageScope) });
  });

  /**
   * v0.26.50: pure expected-filename computation, no filesystem access.
   * Exists for CLIENT MODE: the server has the DB (products, brands,
   * naming pattern) but NOT the client's output folder. So the client
   * fetches the expected relative filenames here, then runs its own
   * fs.existsSync against its local outputRoot. See the
   * exports:checkCollisions local bridge in main/client/index.js.
   *
   * Standalone / server mode never calls this — they use
   * exports:checkCollisions directly (which does the fs check locally
   * because the output folder IS on the same machine).
   */
  expose('exports:expectedOutputs', ({ profileId, productIds, imageScope } = {}) => {
    const profile = assertEntityInActiveCompany(exportProfiles.get(profileId), 'Profile');
    for (const pid of (productIds ?? [])) assertProductInActiveCompany(pid);
    return exportRunner.expectedOutputs({ profile, productIds, imageScope: exportRunner.normalizeExportScope(imageScope) });
  });

  exposeLocal('exports:run', async ({ profileId, productIds, outputRoot, onExisting, saveToLibrary, runId, imageScope }) => {
    const profile = assertEntityInActiveCompany(exportProfiles.get(profileId), 'Profile');
    // Block any productId that doesn't belong to the active company.
    for (const pid of (productIds ?? [])) {
      assertProductInActiveCompany(pid);
    }
    // v0.26.24: validate the collision policy. Default 'keepBoth'
    // keeps backward compat for any caller that doesn't send the
    // new field; the renderer now always does after the modal.
    const onExistingMode = ['replace', 'skip', 'keepBoth'].includes(onExisting)
      ? onExisting
      : 'keepBoth';
    // v0.17.1: progress events for the export. exportRunner
    // accepts an onProgress callback that fires per-image — we
    // forward those through the broadcast bus. Wrapped in
    // try/finally so a thrown export doesn't leave a stale row in
    // the progress overlay.
    const opId = pickRunId(runId);
    let done = 0;
    let result;
    const run = startRun(opId);
    // A first event before any image is encoded, so the Export Center learns
    // the run id (and can offer Cancel) straight away.
    broadcast('progress:event', { id: opId, kind: 'export-run', done: 0, total: null, phase: 'exporting', label: null, cancellable: true });
    try {
      result = await exportRunner.runExport({
        profile,
        productIds,
        outputRoot,
        onExisting: onExistingMode,
        saveToLibrary: !!saveToLibrary,
        // Main image only / first N / all images — per profile, chosen in the
        // Export Center. Missing or unknown = all, as before.
        imageScope: exportRunner.normalizeExportScope(imageScope),
        isCancelled: () => run.cancelled,
        onProgress: (stage, payload) => {
          if (stage === 'image') {
            done += 1;
            broadcast('progress:event', {
              id: opId,
              kind: 'export-run',
              done,
              // Total isn't known until all per-product image
              // lists are walked. Pass null for now; the bar
              // shows indeterminate mode until done/total is
              // meaningful.
              total: null,
              phase: 'exporting',
              label: payload?.product?.sku,
              cancellable: true,
            });
          }
        },
      });
    } finally {
      activeRuns.delete(opId);
      broadcast('progress:event', { id: opId, complete: true });
    }
    exportRuns.record({
      profileId: profile.id,
      productCount: result.products,
      imageCount: result.exported,
      skippedCount: result.skipped,
      outputPath: result.outputPath,
      notes: runNotes(result),
    });
    // v0.31.0: if we appended exports back into the library, tell every
    // client the catalog moved so their Library refreshes.
    if (result.savedToLibrary > 0) emitCatalogChange('images', 'exportSaved', null);
    return result;
  });

  /**
   * v0.16.2: client-mode export. Server runs the export to a temp
   * folder, reads every output file's bytes, returns the whole
   * batch to the client. The client (in main/client/index.js)
   * writes each file at the user's chosen outputRoot.
   *
   * Cap: 100MB of bytes total, enforced before returning so an
   * accidental "export all 5,000 products" doesn't push a huge
   * JSON response through the RPC channel. If exceeded, we error
   * out with a clear message ("Use the server Mac for very large
   * exports, or split the selection").
   */
  expose('exports:runForClient', async ({ profileId, productIds, saveToLibrary, runId, imageScope } = {}) => {
    const profile = assertEntityInActiveCompany(exportProfiles.get(profileId), 'Profile');
    for (const pid of (productIds ?? [])) {
      assertProductInActiveCompany(pid);
    }

    // Run the export to a unique temp folder.
    const os = require('node:os');
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iskh-export-'));
    // v0.17.1: same progress emission as the standalone
    // exports:run. The events get pushed to the caller (RPC
    // client) via the broadcast bus — both the local renderer
    // and any WS client see them. Each connected client filters
    // by id on their side.
    const opId = pickRunId(runId);
    let done = 0;
    const run = startRun(opId);
    broadcast('progress:event', { id: opId, kind: 'export-run', done: 0, total: null, phase: 'processing', label: null, cancellable: true });
    try {
      const result = await exportRunner.runExport({
        profile,
        productIds,
        outputRoot: tmpRoot,
        saveToLibrary: !!saveToLibrary,
        imageScope: exportRunner.normalizeExportScope(imageScope),
        isCancelled: () => run.cancelled,
        onProgress: (stage, payload) => {
          if (stage === 'image') {
            done += 1;
            broadcast('progress:event', {
              id: opId,
              kind: 'export-run',
              done,
              total: null,
              phase: 'processing',
              label: payload?.product?.sku,
              cancellable: true,
            });
          }
        },
      });
      // Walk the temp folder and collect every produced file as
      // bytes. Paths are returned RELATIVE to tmpRoot — the client
      // will recreate the same structure under its chosen
      // outputRoot.
      const SIZE_CAP = 100 * 1024 * 1024;
      let totalSize = 0;
      const files = [];
      function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.name.startsWith('.')) continue;
          const abs = path.join(dir, ent.name);
          if (ent.isDirectory()) { walk(abs); continue; }
          const stat = fs.statSync(abs);
          totalSize += stat.size;
          if (totalSize > SIZE_CAP) {
            throw new Error(
              'Export larger than 100MB — run this export on the server Mac, or split the selection into smaller batches.',
            );
          }
          files.push({
            relPath: path.relative(tmpRoot, abs),
            bytes: fs.readFileSync(abs),
          });
        }
      }
      walk(tmpRoot);

      exportRuns.record({
        profileId: profile.id,
        productCount: result.products,
        imageCount: result.exported,
        skippedCount: result.skipped,
        // outputPath records what the client TOLD the server
        // they wanted. Server doesn't know the client's real
        // path; the client patches the run history if it cares.
        outputPath: null,
        notes: runNotes(result),
      });

      // v0.31.0: the append-to-library happened on the SERVER's DB+assets,
      // so notify clients to refresh their Library.
      if (result.savedToLibrary > 0) emitCatalogChange('images', 'exportSaved', null);
      return { ...result, files };
    } finally {
      activeRuns.delete(opId);
      broadcast('progress:event', { id: opId, complete: true });
      try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  });

  expose('exports:listRuns', (limit) => {
    const active = companies.getActiveId();
    if (!active) return [];
    return exportRuns.listRecentByCompany(active, limit ?? 20);
  });
}

/** The run-history note: a cancel first (it explains the short count), then
 *  the first 50 skips. */
function runNotes(result) {
  const lines = [];
  if (result.cancelled) lines.push(`Cancelled after ${result.exported} image${result.exported === 1 ? '' : 's'}.`);
  for (const s of result.skips.slice(0, 50)) lines.push(`${s.sku}: ${s.reason}`);
  return lines.length ? lines.join('\n') : null;
}

module.exports = { register, cancelRun, startRun, pickRunId };
