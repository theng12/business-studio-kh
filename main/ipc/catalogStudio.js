const fs = require('node:fs');
const path = require('node:path');
const projects = require('../db/catalogProjects');
const templates = require('../db/catalogTemplates');
const products = require('../db/products');
const brands = require('../db/brands');
const categories = require('../db/categories');
const companies = require('../db/companies');
const { buildCatalogHtml } = require('../studioRenderer');
const { outputBaseName } = require('../util/outputNames');
const { toPdf, toPdfBuffer } = require('../renderWindow');
const { slugifyUnicode } = require('../util/slug');
const { normalizeCatalogConfig, applyCatalogDesign, catalogPdfOptions } = require('../util/catalogModel');
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
  /* The font CSS travels separately and only when the caller does not have it
   * yet: `fontsKey` is the set the app already holds. It is ~2 MB of base64
   * for a Khmer catalog, and it used to be re-sent (and re-parsed in a 2.2 MB
   * srcdoc) on every debounced refresh. The app loads it into the preview
   * frame itself (renderer/modules/CatalogStudio/previewFonts.js). */
  expose('catalogStudio:preview', ({ id, fontsKey } = {}) => {
    const project = assertEntityInActiveCompany(projects.get(id), 'Catalog project');
    const fonts = {};
    const html = buildCatalogHtml(context(project), { preview: true, fontsOut: fonts });
    return { html, fontsKey: fonts.key || '', ...(fonts.key && fonts.key !== fontsKey ? { fontsCss: fonts.css } : {}) };
  });
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
      // Khmer name kept, readable date, never over an earlier export.
      // The name is claimed when the bytes are written (unique → `wx`), so two
      // exports in the same minute cannot pick the same file.
      const target = await toPdf(html, path.join(outputFolder, `${outputBaseName(project.name, 'catalog')}.pdf`), { ...catalogPdfOptions(project.config), unique: true });
      events.broadcast('progress:event', { id: opId, kind: 'catalog', done: 3, total: 3, phase: 'complete', label: project.name });
      projects.markExported(id);
      emitCatalogChange('catalogStudio', 'update', id);
      return { outputPath: target };
    } finally { events.broadcast('progress:event', { id: opId, complete: true }); }
  });

  /* Print a catalog on THIS Mac's printer — the same document the PDF export
   * renders (full photos and fonts, not the preview), opened in Preview for
   * printing. Local-only: Preview runs on this Mac. Client
   * mode has its own handler in main/client/index.js. */
  exposeLocal('catalogStudio:print', async ({ id } = {}) => {
    const project = projects.get(id); if (!project) throw new Error('Catalog project not found');
    assertEntityInActiveCompany(project, 'Catalog project');
    // Match client mode: print the authoritative PDF in Preview, including its
    // native page numbers and headers, rather than a separate HTML print layout.
    const dir = await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(), 'msk-catalog-print-'));
    const target = path.join(dir, `${slugifyUnicode(project.name, 'catalog')}.pdf`);
    await toPdf(buildCatalogHtml(context(project)), target, catalogPdfOptions(project.config));
    await require('../util/openPath').openPathOrThrow(target, 'catalog PDF');
    return { ok: true, openedPdf: true };
  });

  /* ── reusable templates (v0.1.63) ────────────────────────────────
   *
   * The builder's storage. A template is the layout half of a catalog — page,
   * grid, style, cover, card fields, price source — with no products in it, so
   * one design can be reused and a project can be created from it. */

  expose('catalogStudio:listTemplates', ({ companyId } = {}) => {
    const activeId = companies.getActiveId();
    if (companyId && companyId !== activeId) return [];
    return templates.list(companyId || activeId);
  });
  expose('catalogStudio:getTemplate', ({ id } = {}) => assertEntityInActiveCompany(templates.get(id), 'Catalog template'));
  expose('catalogStudio:saveTemplate', (input = {}) => {
    if (input.companyId !== companies.getActiveId()) throw new Error('Cross-company create blocked');
    const row = templates.create(input);
    emitCatalogChange('catalogStudio', 'template:create', row.id);
    return row;
  });
  expose('catalogStudio:updateTemplate', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(templates.get(id), 'Catalog template');
    const row = templates.update(id, patch);
    emitCatalogChange('catalogStudio', 'template:update', id);
    return row;
  });
  expose('catalogStudio:deleteTemplate', ({ id } = {}) => {
    assertEntityInActiveCompany(templates.get(id), 'Catalog template');
    const ok = templates.remove(id);
    emitCatalogChange('catalogStudio', 'template:delete', id);
    return ok;
  });
  expose('catalogStudio:duplicateTemplate', ({ id } = {}) => {
    assertEntityInActiveCompany(templates.get(id), 'Catalog template');
    const row = templates.duplicate(id);
    emitCatalogChange('catalogStudio', 'template:create', row.id);
    return row;
  });

  /**
   * A REAL page render for a template that may never have been saved.
   *
   * The builder must show what the layout actually produces — the same
   * HTML/print engine the PDF uses — not a CSS mock that can drift. This is the
   * template-side twin of `catalogStudio:preview`, which takes a stored project
   * id; here the config comes from the screen, and the products are the active
   * company's own (capped, because a preview is not a print run).
   */
  expose('catalogStudio:previewTemplate', async ({ config, name, sampleLimit = 9 } = {}) => {
    const companyId = companies.getActiveId();
    const company = companies.get(companyId);
    const all = products.list(companyId).filter((p) => p.status !== 'inactive');
    const limit = Math.max(1, Math.min(48, Number(sampleLimit) || 9));
    const selected = all.slice(0, limit);
    const normalized = normalizeCatalogConfig(config || {});
    // Design-only: the builder previews the layout, so the sample products are
    // handed over explicitly rather than through a stored selection.
    const previewProject = {
      id: 'preview',
      name: name || 'Preview',
      config: applyCatalogDesign(normalized, { selectionMode: 'explicit', productIds: selected.map((p) => p.id) }),
    };
    return {
      html: buildCatalogHtml({
        project: previewProject,
        products: all,
        brands: brands.list(companyId),
        categories: categories.list(companyId),
        company,
      }, { preview: true }),
      sampleCount: selected.length,
      total: all.length,
    };
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
    const bytes = await toPdfBuffer(html, catalogPdfOptions(project.config));
    // The client writes it without overwriting (writeUniqueFile), so the
    // readable minute stamp cannot clobber an earlier export there either.
    return {
      bytes,
      fileName: `${outputBaseName(project.name, 'catalog')}.pdf`,
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
