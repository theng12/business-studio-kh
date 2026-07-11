const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const templates = require('../db/labelTemplates');
const runs = require('../db/labelRuns');
const productsDb = require('../db/products');
const brandsDb = require('../db/brands');
const { labelsDocument, barcodeUri } = require('../studioRenderer');
const renderer = require('../renderWindow');
const events = require('../events');
const { slugify } = require('../util/slug');
const imageManager = require('../imageManager');

function productRows(ids) {
  return (Array.isArray(ids) ? ids : []).map((id) => productsDb.get(id)).filter(Boolean);
}

function register({ expose, emitCatalogChange, assertEntityInActiveCompany }) {
  expose('labels:listTemplates', ({ companyId } = {}) => templates.ensureStarters(companyId));
  expose('labels:getTemplate', ({ id } = {}) => assertEntityInActiveCompany(templates.get(id), 'Label template'));
  expose('labels:createTemplate', (input = {}) => {
    const row = templates.create(input); emitCatalogChange('labels', 'create', row.id); return row;
  });
  expose('labels:updateTemplate', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(templates.get(id), 'Label template');
    const row = templates.update(id, patch); emitCatalogChange('labels', 'update', id); return row;
  });
  expose('labels:deleteTemplate', ({ id } = {}) => { assertEntityInActiveCompany(templates.get(id), 'Label template'); return templates.remove(id); });
  expose('labels:duplicateTemplate', ({ id } = {}) => { assertEntityInActiveCompany(templates.get(id), 'Label template'); return templates.duplicate(id); });
  expose('labels:preview', async ({ templateId, productId, layout } = {}) => {
    const template = templates.get(templateId); if (!template) throw new Error('Label template not found');
    assertEntityInActiveCompany(template, 'Label template');
    const product = productsDb.get(productId) || { sku: 'SAMPLE-001', name: 'Sample product', barcode: '123456789012', priceRetail: 9.99 };
    const brands = product.brandId ? [brandsDb.get(product.brandId)].filter(Boolean) : [];
    return { html: await labelsDocument({ template, products: [product], brands, layout: { mode: 'single', ...(layout || {}) } }) };
  });
  expose('labels:barcodePreview', async ({ value, format } = {}) => ({ dataUrl: await barcodeUri(value, format, true) }));
  expose('labels:saveBarcode', async ({ value, format, outputFolder } = {}) => {
    if (!outputFolder) throw new Error('Pick an output folder');
    const dataUrl = await barcodeUri(value, format, true);
    if (!dataUrl) throw new Error('The barcode value is not valid for that format');
    await fs.promises.mkdir(outputFolder, { recursive: true });
    const outputPath = path.join(outputFolder, `${slugify(value, 'barcode')}-${format || 'code128'}.png`);
    await fs.promises.writeFile(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return { outputPath };
  });
  expose('labels:importAsset', async ({ sourcePath, name } = {}) => imageManager.importAsset('labels', sourcePath, name || 'label-art'));
  expose('labels:listPrinters', () => renderer.listPrinters());
  expose('labels:listRuns', ({ companyId, limit } = {}) => runs.list(companyId, limit));
  expose('labels:deleteRun', ({ id } = {}) => runs.remove(id));
  expose('labels:openOutput', async ({ outputPath } = {}) => {
    if (!outputPath || typeof outputPath !== 'string') throw new Error('Output path required');
    const err = await shell.openPath(outputPath); if (err) throw new Error(err); return true;
  });

  expose('labels:generate', async ({ companyId, templateId, productIds, outputFolder, format = 'pdf', layout = {} } = {}) => {
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
        for (let i = 0; i < products.length; i += 1) {
          const product = products[i];
          const html = await labelsDocument({ template, products: [product], brands, layout: { mode: 'single' } });
          const ext = format === 'jpeg' ? 'jpg' : 'png';
          const target = path.join(outputFolder, `${slugify(product.sku || product.name, 'label')}-${slugify(template.name, 'label')}.${ext}`);
          const scale = Math.max(1, Number(layout.dpi) || 203) / 25.4;
          const dpi = Math.max(72, Number(layout.dpi) || 203);
          await renderer.toImage(html, target, { format, width: Math.ceil(template.widthMm * scale), height: Math.ceil(template.heightMm * scale), quality: 92, dpi, zoomFactor: dpi / 96 });
          made.push(target);
          events.broadcast('progress:event', { id: opId, kind: 'labels', done: i + 1, total: products.length, phase: 'rendering', label: product.sku || product.name });
        }
      }
      run = runs.create({ companyId, templateId, templateName: template.name, format,
        layoutMode: layout.mode || 'single', productCount: products.length,
        outputPath: format === 'pdf' ? made[0] : outputFolder, settings: layout });
      products.forEach((product, i) => runs.addItem(run.id, { productId: product.id, sku: product.sku,
        filePath: format === 'pdf' ? made[0] : made[i], productSnapshot: product, templateSnapshot: template }));
      return { run, files: made, outputPath: run.outputPath };
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }
  });

  expose('labels:print', async ({ companyId, templateId, productIds, layout = {}, printOptions = {} } = {}) => {
    const template = templates.get(templateId); if (!template) throw new Error('Label template not found');
    assertEntityInActiveCompany(template, 'Label template');
    const products = productRows(productIds); if (!products.length) throw new Error('Select at least one product');
    const html = await labelsDocument({ template, products, brands: brandsDb.list(companyId), layout });
    const result = await renderer.printHtml(html, printOptions);
    runs.create({ companyId, templateId, templateName: template.name, format: 'print', layoutMode: layout.mode || 'single', productCount: products.length, settings: { layout, printOptions } });
    return result;
  });
}

module.exports = { register };
