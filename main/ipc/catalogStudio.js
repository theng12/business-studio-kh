const fs = require('node:fs');
const path = require('node:path');
const projects = require('../db/catalogProjects');
const products = require('../db/products');
const brands = require('../db/brands');
const categories = require('../db/categories');
const companies = require('../db/companies');
const { buildCatalogHtml } = require('../studioRenderer');
const { toPdf } = require('../renderWindow');
const { slugify } = require('../util/slug');
const events = require('../events');

function context(project) {
  if (!project) throw new Error('Catalog project not found');
  return { project, company: companies.get(project.companyId), products: products.list(project.companyId),
    brands: brands.list(project.companyId), categories: categories.list(project.companyId) };
}

function register({ expose, emitCatalogChange, assertEntityInActiveCompany }) {
  expose('catalogStudio:list', ({ companyId } = {}) => projects.list(companyId));
  expose('catalogStudio:get', ({ id } = {}) => assertEntityInActiveCompany(projects.get(id), 'Catalog project'));
  expose('catalogStudio:create', (input = {}) => { const row = projects.create(input); emitCatalogChange('catalogStudio', 'create', row.id); return row; });
  expose('catalogStudio:update', ({ id, patch } = {}) => { assertEntityInActiveCompany(projects.get(id), 'Catalog project'); const row = projects.update(id, patch); emitCatalogChange('catalogStudio', 'update', id); return row; });
  expose('catalogStudio:delete', ({ id } = {}) => { assertEntityInActiveCompany(projects.get(id), 'Catalog project'); return projects.remove(id); });
  expose('catalogStudio:duplicate', ({ id } = {}) => { assertEntityInActiveCompany(projects.get(id), 'Catalog project'); return projects.duplicate(id); });
  expose('catalogStudio:preview', ({ id } = {}) => { const project = assertEntityInActiveCompany(projects.get(id), 'Catalog project'); return { html: buildCatalogHtml(context(project)) }; });
  expose('catalogStudio:export', async ({ id, outputFolder } = {}) => {
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
      return { outputPath: target };
    } finally { events.broadcast('progress:event', { id: opId, complete: true }); }
  });
}

module.exports = { register };
