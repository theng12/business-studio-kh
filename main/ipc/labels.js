const fs = require('node:fs');
const { safeFileExt } = require('../util/fileKinds');
const os = require('node:os');
const path = require('node:path');
const { openPathOrThrow } = require('../util/openPath');
const templates = require('../db/labelTemplates');
const runs = require('../db/labelRuns');
const productsDb = require('../db/products');
const brandsDb = require('../db/brands');
const companies = require('../db/companies');
const { labelsDocument, barcodeUri } = require('../studioRenderer');
const renderer = require('../renderWindow');
const events = require('../events');
const { slugify } = require('../util/slug');
const imageManager = require('../imageManager');

function productRows(ids) {
  return (Array.isArray(ids) ? ids : []).map((id) => productsDb.get(id)).filter(Boolean);
}

function register({ expose, exposeLocal, emitCatalogChange, assertEntityInActiveCompany }) {
  expose('labels:listTemplates', ({ companyId } = {}) => templates.ensureStarters(companyId));
  expose('labels:getTemplate', ({ id } = {}) => assertEntityInActiveCompany(templates.get(id), 'Label template'));
  expose('labels:createTemplate', (input = {}) => {
    const row = templates.create(input); emitCatalogChange('labels', 'create', row.id); return row;
  });
  expose('labels:updateTemplate', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(templates.get(id), 'Label template');
    const row = templates.update(id, patch); emitCatalogChange('labels', 'update', id); return row;
  });
  expose('labels:deleteTemplate', ({ id } = {}) => { assertEntityInActiveCompany(templates.get(id), 'Label template'); const ok = templates.remove(id); emitCatalogChange('labels', 'delete', id); return ok; });
  expose('labels:duplicateTemplate', ({ id } = {}) => { assertEntityInActiveCompany(templates.get(id), 'Label template'); const row = templates.duplicate(id); emitCatalogChange('labels', 'create', row.id); return row; });
  expose('labels:preview', async ({ templateId, productId, layout } = {}) => {
    const template = templates.get(templateId); if (!template) throw new Error('Label template not found');
    assertEntityInActiveCompany(template, 'Label template');
    const product = productsDb.get(productId) || { sku: 'SAMPLE-001', name: 'Sample product', barcode: '123456789012', priceRetail: 9.99 };
    const brands = product.brandId ? [brandsDb.get(product.brandId)].filter(Boolean) : [];
    return { html: await labelsDocument({ template, products: [product], brands, layout: { mode: 'single', ...(layout || {}) }, preview: true }) };
  });
  /**
   * v0.1.64: the same document, for a template that is still being edited.
   *
   * `labels:preview` takes a saved template id, which is useless to a designer
   * that has unsaved changes — and the whole point of this channel is to let
   * the canvas show the REAL print render instead of a DOM approximation that
   * drifts from it (font sizes in pt, bwip-js barcodes, inlined art, embedded
   * fallback fonts). Same builder as print, so what is on screen is what comes
   * out of the printer.
   */
  expose('labels:previewDraft', async ({ template, productId, layout } = {}) => {
    if (!template || typeof template !== 'object') throw new Error('template is required');
    const product = (productId ? productsDb.get(productId) : null)
      || productsDb.list(companies.getActiveId())[0]
      || { sku: 'SAMPLE-001', name: 'Sample product', barcode: '123456789012', priceRetail: 9.99 };
    const brands = product.brandId ? [brandsDb.get(product.brandId)].filter(Boolean) : [];
    return {
      html: await labelsDocument({ template, products: [product], brands, layout: { mode: 'single', ...(layout || {}) }, preview: true }),
      sample: { id: product.id ?? null, sku: product.sku ?? null, name: product.name ?? null },
    };
  });

  expose('labels:barcodePreview', async ({ value, format } = {}) => ({ dataUrl: await barcodeUri(value, format, true) }));
  exposeLocal('labels:saveBarcode', async ({ value, format, outputFolder } = {}) => {
    if (!outputFolder) throw new Error('Pick an output folder');
    const dataUrl = await barcodeUri(value, format, true);
    if (!dataUrl) throw new Error('The barcode value is not valid for that format');
    await fs.promises.mkdir(outputFolder, { recursive: true });
    const outputPath = path.join(outputFolder, `${slugify(value, 'barcode')}-${format || 'code128'}.png`);
    await fs.promises.writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return { outputPath };
  });
  exposeLocal('labels:importAsset', async ({ sourcePath, name } = {}) => imageManager.importAsset('labels', sourcePath, name || 'label-art'));
  exposeLocal('labels:listPrinters', () => renderer.listPrinters());
  expose('labels:listRuns', ({ companyId, limit } = {}) => runs.list(companyId, limit));
  expose('labels:deleteRun', ({ id } = {}) => { const removed = runs.remove(id); emitCatalogChange('labels', 'run-delete', id); return removed; });
  exposeLocal('labels:openOutput', async ({ outputPath } = {}) => {
    if (!outputPath || typeof outputPath !== 'string') throw new Error('Output path required');
    return openPathOrThrow(outputPath, 'label file');
  });

  /* ─── v0.1.21: the split that lets a client Mac generate and print labels ──
   *
   * A client Mac has no database and no assets — but it DOES have the folder the
   * user picked and the printer they want to print on. So the work splits in two:
   * this Mac (wherever the data is) builds the label document, and the Mac the
   * user is sitting at turns that document into files or paper.
   *
   * `labelsDocument()` returns a complete, self-contained HTML string — anything
   * it references (brand icons, label art) is already inlined as a data URI — so
   * the document is the entire payload. That is what makes this split clean
   * rather than another network asset protocol.
   *
   * These three channels are additions, not replacements: the local
   * generate/print below them still runs the whole thing in one process, which is
   * what standalone and server mode should keep doing.
   */

  /** The label document for a batch, for a caller that will render it itself. */
  expose('labels:buildDocument', async ({ companyId, templateId, productIds, layout = {}, perProduct = false } = {}) => {
    const template = templates.get(templateId);
    if (!template) throw new Error('Label template not found');
    assertEntityInActiveCompany(template, 'Label template');
    const products = productRows(productIds);
    if (!products.length) throw new Error('Select at least one product');
    const brands = brandsDb.list(companyId);
    // The caller needs the physical size to size its render window, and the
    // template name for the output filename — both travel with the document so a
    // client does not have to ask twice.
    const meta = {
      templateName: template.name,
      widthMm: template.widthMm,
      heightMm: template.heightMm,
    };

    // One file per label: separate documents, because a batch document is a
    // single page and cannot be split back into individual labels.
    if (perProduct) {
      const documents = [];
      for (const product of products) {
        documents.push({
          productId: product.id,
          sku: product.sku || product.name || product.id,
          html: await labelsDocument({
            template, products: [product], brands, layout: { ...layout, mode: 'single' },
          }),
        });
      }
      return { documents, ...meta };
    }

    return { html: await labelsDocument({ template, products, brands, layout }), ...meta };
  });

  /**
   * Record a generation or print in the run history.
   *
   * The history belongs with the data, so a client sends the outcome back here
   * rather than keeping its own copy. Everything the history needs is in the
   * request; the file paths are the CLIENT's paths, which is correct — that is
   * where the files are.
   */
  expose('labels:recordRun', ({ companyId, templateId, templateName, format, layoutMode, outputPath, settings, items, originHost } = {}) => {
    const run = runs.create({
      companyId,
      templateId,
      templateName,
      format,
      layoutMode: layoutMode || 'single',
      productCount: Array.isArray(items) ? items.length : 0,
      outputPath: outputPath ?? null,
      // The caller names the Mac that wrote the files (a client passes its own
      // hostname); fall back to this Mac so a run recorded without one is still
      // attributable.
      settings: { ...(settings || {}), originHost: originHost || os.hostname() },
    });
    runs.addItems(run.id, Array.isArray(items) ? items : []);
    emitCatalogChange('labels', 'run', templateId);
    return { run };
  });

  /**
   * Import label artwork from a client Mac. The file is on that Mac's disk, so
   * the bytes travel rather than the path — same approach as
   * `brands:uploadIconFromBytes`.
   */
  expose('labels:importAssetFromBytes', async ({ bytes, ext, name } = {}) => {
    if (!bytes) throw new Error('bytes required');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'msk-label-asset-'));
    // v0.1.25: this file already had the right rule; now it uses the shared
    // helper so the rule cannot drift from the other two call sites.
    const safeExt = safeFileExt(ext);
    const tmpPath = path.join(tmpDir, `art${safeExt}`);
    await fs.promises.writeFile(tmpPath, Buffer.from(bytes));
    try {
      return await imageManager.importAsset('labels', tmpPath, name || 'label-art');
    } finally {
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  });

  exposeLocal('labels:generate', async ({ companyId, templateId, productIds, outputFolder, format = 'pdf', layout = {} } = {}) => {
    const template = templates.get(templateId); if (!template) throw new Error('Label template not found');
    assertEntityInActiveCompany(template, 'Label template');
    const products = productRows(productIds); if (!products.length) throw new Error('Select at least one product');
    if (!outputFolder || typeof outputFolder !== 'string') throw new Error('Pick an output folder');
    await fs.promises.mkdir(outputFolder, { recursive: true });
    const brands = brandsDb.list(companyId);
    const opId = `label-${Date.now()}`;
    events.broadcast('progress:event', { id: opId, kind: 'labels', done: 0, total: products.length, phase: 'rendering', label: template.name });
    const made = [];
    let run;
    try {
      if (format === 'pdf') {
        const html = await labelsDocument({ template, products, brands, layout });
        const target = path.join(outputFolder, `${slugify(template.name, 'labels')}-${Date.now()}.pdf`);
        await renderer.toPdf(html, target, { orientation: layout.orientation });
        made.push(target);
        events.broadcast('progress:event', { id: opId, kind: 'labels', done: products.length, total: products.length, phase: 'finishing', label: template.name });
      } else {
        // Every label shares the template's size, so one offscreen window
        // renders the whole batch (renderer.toImages) instead of one window —
        // one renderer process — per label.
        const ext = format === 'jpeg' ? 'jpg' : 'png';
        const scale = Math.max(1, Number(layout.dpi) || 203) / 25.4;
        const dpi = Math.max(72, Number(layout.dpi) || 203);
        await renderer.toImages(products.length, async (i) => {
          const product = products[i];
          return {
            html: await labelsDocument({ template, products: [product], brands, layout: { mode: 'single' } }),
            outputPath: path.join(outputFolder, `${slugify(product.sku || product.name, 'label')}-${slugify(template.name, 'label')}.${ext}`),
          };
        }, { format, width: Math.ceil(template.widthMm * scale), height: Math.ceil(template.heightMm * scale), quality: 92, dpi, zoomFactor: dpi / 96 }, (i, target) => {
          made.push(target);
          const product = products[i];
          events.broadcast('progress:event', { id: opId, kind: 'labels', done: i + 1, total: products.length, phase: 'rendering', label: product.sku || product.name });
        });
      }
      run = runs.create({ companyId, templateId, templateName: template.name, format,
        layoutMode: layout.mode || 'single', productCount: products.length,
        outputPath: format === 'pdf' ? made[0] : outputFolder,
        // v0.1.22: which Mac wrote these files. The history lives here with the
        // data, but the files land on whichever Mac ran the job — so a reader on
        // the other Mac needs to be told where they are.
        settings: { ...layout, originHost: os.hostname() } });
      runs.addItems(run.id, products.map((product, i) => ({ productId: product.id, sku: product.sku,
        filePath: format === 'pdf' ? made[0] : made[i], productSnapshot: product, templateSnapshot: template })));
      emitCatalogChange('labels', 'run', templateId);
      return { run, files: made, outputPath: run.outputPath };
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }
  });

  exposeLocal('labels:print', async ({ companyId, templateId, productIds, layout = {}, printOptions = {} } = {}) => {
    const template = templates.get(templateId); if (!template) throw new Error('Label template not found');
    assertEntityInActiveCompany(template, 'Label template');
    const products = productRows(productIds); if (!products.length) throw new Error('Select at least one product');
    const html = await labelsDocument({ template, products, brands: brandsDb.list(companyId), layout });
    const result = await renderer.printHtml(html, printOptions);
    runs.create({ companyId, templateId, templateName: template.name, format: 'print', layoutMode: layout.mode || 'single', productCount: products.length, settings: { layout, printOptions, originHost: os.hostname() } });
    emitCatalogChange('labels', 'run', templateId);
    return result;
  });
}

module.exports = { register };
