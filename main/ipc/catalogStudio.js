const fs = require('node:fs');
const path = require('node:path');
const projects = require('../db/catalogProjects');
const products = require('../db/products');
const brands = require('../db/brands');
const categories = require('../db/categories');
const companies = require('../db/companies');
const { buildCatalogHtml } = require('../studioRenderer');
const { toPdf, toPdfBuffer } = require('../renderWindow');
const { slugify } = require('../util/slug');
const events = require('../events');

function context(project) {
  if (!project) throw new Error('Catalog project not found');
  return { project, company: companies.get(project.companyId), products: products.list(project.companyId),
    brands: brands.list(project.companyId), categories: categories.list(project.companyId) };
}

function register({ expose, exposeLocal, emitCatalogChange, assertEntityInActiveCompany }) {
  expose('catalogStudio:list', ({ companyId } = {}) => projects.list(companyId));
  expose('catalogStudio:get', ({ id } = {}) => assertEntityInActiveCompany(projects.get(id), 'Catalog project'));
  expose('catalogStudio:create', (input = {}) => { const row = projects.create(input); emitCatalogChange('catalogStudio', 'create', row.id); return row; });
  expose('catalogStudio:update', ({ id, patch } = {}) => { assertEntityInActiveCompany(projects.get(id), 'Catalog project'); const row = projects.update(id, patch); emitCatalogChange('catalogStudio', 'update', id); return row; });
  expose('catalogStudio:delete', ({ id } = {}) => { assertEntityInActiveCompany(projects.get(id), 'Catalog project'); const ok = projects.remove(id); emitCatalogChange('catalogStudio', 'delete', id); return ok; });
  expose('catalogStudio:duplicate', ({ id } = {}) => { assertEntityInActiveCompany(projects.get(id), 'Catalog project'); const row = projects.duplicate(id); emitCatalogChange('catalogStudio', 'create', row.id); return row; });
  expose('catalogStudio:preview', ({ id } = {}) => { const project = assertEntityInActiveCompany(projects.get(id), 'Catalog project'); return { html: buildCatalogHtml(context(project)) }; });
  exposeLocal('catalogStudio:export', async ({ id, outputFolder } = {}) => {
    const project = projects.get(id); if (!project) throw new Error('Catalog project not found');
    assertEntityInActiveCompany(project, 'Catalog project');
    if (!outputFolder) throw new Error('Pick an output folder');
    await fs.promises.mkdir(outputFolder, { recursive: true });
    const opId = `catalog-${Date.now()}`;
    events.broadcast('progress:event', { id: opId, kind: 'catalog', done: 0, total: 3, phase: 'layout', label: project.name });
    try {
      const html = buildCatalogHtml(context(project));
      events.broadcast('progress:event', { id: opId, kind: 'catalog', done: 1, total: 3, phase: 'rendering', label: project.name });
      const target = path.join(outputFolder, `${slugify(project.name, 'catalog')}-${Date.now()}.pdf`);
      await toPdf(html, target, { orientation: project.config?.orientation });
      events.broadcast('progress:event', { id: opId, kind: 'catalog', done: 3, total: 3, phase: 'complete', label: project.name });
      projects.markExported(id);
      emitCatalogChange('catalogStudio', 'update', id);
      return { outputPath: target };
    } finally { events.broadcast('progress:event', { id: opId, complete: true }); }
  });

  /* ─── v0.1.21: the same export, for a caller that writes the file itself ──
   *
   * A client Mac has no database, so it cannot build the catalog — but it has
   * the folder the user picked for the PDF. Unlike a label, a catalog embeds
   * every product image, so shipping the HTML would mean shipping megabytes of
   * base64; the finished PDF is already compressed. So here the SERVER renders
   * and the client just writes the bytes.
   */
  expose('catalogStudio:exportBytes', async ({ id } = {}) => {
    const project = projects.get(id); if (!project) throw new Error('Catalog project not found');
    assertEntityInActiveCompany(project, 'Catalog project');
    const html = buildCatalogHtml(context(project));
    const bytes = await toPdfBuffer(html, { orientation: project.config?.orientation });
    const { slugify } = require('../util/slug');
    return {
      bytes,
      fileName: `${slugify(project.name, 'catalog')}-${Date.now()}.pdf`,
    };
  });

  /** Mark a catalog as exported — called by a client after it writes the file. */
  expose('catalogStudio:markExported', ({ id } = {}) => {
    const project = projects.get(id); if (!project) throw new Error('Catalog project not found');
    assertEntityInActiveCompany(project, 'Catalog project');
    projects.markExported(id);
    emitCatalogChange('catalogStudio', 'update', id);
    return { ok: true };
  });
}

module.exports = { register };
