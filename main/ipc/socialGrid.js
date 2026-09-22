/**
 * v0.1.25 — Social Grid.
 *
 * Turns a saved recipe ("this brand / category, sorted this way, square, with
 * prices") into one or more square images sized for a Facebook or Instagram
 * post.
 *
 * Three things worth knowing about how this is wired:
 *
 * 1. **The images are rendered HERE, where the data is.** A product photo
 *    lives on the Mac that owns the database, so a client Mac cannot build a
 *    grid — it has no images to inline. This is the same handover the catalog
 *    PDFs use (`catalogStudio:exportBytes`): the server renders, the client
 *    only writes the finished bytes to its own disk.
 *
 * 2. **The bytes travel, not the HTML.** A 3x3 grid inlines nine base64
 *    photos into the document — megabytes of text. The finished PNG is
 *    compressed and usually smaller than the markup that produced it, so
 *    `exportBytes` returns finished images.
 *
 * 3. **A preview is a scaled-down render, not a separate implementation.**
 *    The React side does not re-draw the grid in CSS; it asks for a small
 *    real render. Two layout implementations would drift, and the user would
 *    see a preview that does not match the file.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const presets = require('../db/socialGridPresets');
const templates = require('../db/socialGridTemplates');
const productsDb = require('../db/products');
const brandsDb = require('../db/brands');
const companies = require('../db/companies');
const { buildPageHtml, seriesSlug, fileNameFor } = require('../socialGridRenderer');
const { assetDataUri } = require('../studioRenderer');
const { withWindow } = require('../renderWindow');
const events = require('../events');
const {
  normalizeConfig, selectProducts, paginate, summarize,
} = require('../util/socialGridModel');

/** Longest side of a preview render. Small enough to feel instant and to keep
 *  the base64 payload over IPC reasonable, large enough to judge the layout. */
const PREVIEW_MAX = 560;

/** Everything one run needs: the company's products, its brands, and the
 *  normalized config. */
function contextFor(rawConfig) {
  const companyId = companies.getActiveId();
  const config = normalizeConfig(rawConfig);
  const products = productsDb.list(companyId);
  const brands = brandsDb.list(companyId);
  const brandNames = new Map(brands.map((b) => [b.id, b.name]));
  const selected = selectProducts(products, config, brandNames);
  return { companyId, config, products, brands, brandNames, selected };
}

/** Scale every pixel-valued setting so a preview looks exactly like the
 *  export, just smaller. Scaling the canvas without the type sizes would
 *  change the layout, so both move together. */
function scaledConfig(config, factor) {
  const f = (n) => Math.max(1, Math.round(n * factor));
  return normalizeConfig({
    ...config,
    width: f(config.width),
    height: f(config.height),
    padding: f(config.padding),
    gap: f(config.gap),
    radius: f(config.radius),
    nameSize: f(config.nameSize),
    priceSize: f(config.priceSize),
    metaSize: f(config.metaSize),
    titleSize: f(config.titleSize),
    subtitleSize: f(config.subtitleSize),
    footerSize: f(config.footerSize),
  });
}

/**
 * Render one page to image bytes at exactly the configured pixel size.
 *
 * `capturePage()` returns the window's pixels at the display's scale factor,
 * so on a Retina Mac a "1080x1080" window yields 2160x2160. That is
 * machine-dependent — the same preset would export different file sizes on
 * two Macs. Resizing to the requested dimensions with sharp makes the output
 * identical everywhere. `fit: 'fill'` cannot distort anything here because
 * the capture has the same aspect ratio as the target.
 */
async function renderPageBytes(products, brands, config, pageIndex, pageCount, format, quality) {
  const html = buildPageHtml({
    products, brands, config, pageIndex, pageCount, resolveImage: assetDataUri,
  });
  const raw = await withWindow(html, { width: config.width, height: config.height, zoomFactor: 1 },
    (win) => win.webContents.capturePage());
  const base = sharp(raw.toPNG()).resize(config.width, config.height, { fit: 'fill' });
  return format === 'jpeg'
    ? base.jpeg({ quality }).toBuffer()
    : base.png({ compressionLevel: 9 }).toBuffer();
}

function register({ expose, exposeLocal, emitCatalogChange, assertEntityInActiveCompany }) {
  /* ── saved post presets ─────────────────────────────────────────── */

  expose('socialGrid:list', ({ companyId } = {}) => {
    const activeId = companies.getActiveId();
    if (companyId && companyId !== activeId) return [];
    return presets.list(companyId || activeId);
  });
  expose('socialGrid:get', ({ id } = {}) => assertEntityInActiveCompany(presets.get(id), 'Post preset'));
  expose('socialGrid:create', (input = {}) => {
    if (input.companyId !== companies.getActiveId()) throw new Error('Cross-company create blocked');
    const row = presets.create(input);
    emitCatalogChange('socialGrid', 'create', row.id);
    return row;
  });
  expose('socialGrid:update', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(presets.get(id), 'Post preset');
    const row = presets.update(id, patch);
    emitCatalogChange('socialGrid', 'update', id);
    return row;
  });
  expose('socialGrid:delete', ({ id } = {}) => {
    assertEntityInActiveCompany(presets.get(id), 'Post preset');
    const ok = presets.remove(id);
    emitCatalogChange('socialGrid', 'delete', id);
    return ok;
  });
  expose('socialGrid:duplicate', ({ id } = {}) => {
    assertEntityInActiveCompany(presets.get(id), 'Post preset');
    const row = presets.duplicate(id);
    emitCatalogChange('socialGrid', 'create', row.id);
    return row;
  });

  /* ── reusable templates (v0.1.62) ─────────────────────────────────
   *
   * Templates are the design half of a post, with no products in them. The
   * Product Library applies one to whatever the user has selected; the editor
   * saves one so the next post can start from it. */

  expose('socialGrid:listTemplates', ({ companyId } = {}) => {
    const activeId = companies.getActiveId();
    if (companyId && companyId !== activeId) return [];
    return templates.list(companyId || activeId);
  });
  expose('socialGrid:getTemplate', ({ id } = {}) => assertEntityInActiveCompany(templates.get(id), 'Social template'));
  expose('socialGrid:saveTemplate', (input = {}) => {
    if (input.companyId !== companies.getActiveId()) throw new Error('Cross-company create blocked');
    const row = templates.create(input);
    emitCatalogChange('socialGrid', 'template:create', row.id);
    return row;
  });
  expose('socialGrid:updateTemplate', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(templates.get(id), 'Social template');
    const row = templates.update(id, patch);
    emitCatalogChange('socialGrid', 'template:update', id);
    return row;
  });
  expose('socialGrid:deleteTemplate', ({ id } = {}) => {
    assertEntityInActiveCompany(templates.get(id), 'Social template');
    const ok = templates.remove(id);
    emitCatalogChange('socialGrid', 'template:delete', id);
    return ok;
  });
  expose('socialGrid:duplicateTemplate', ({ id } = {}) => {
    assertEntityInActiveCompany(templates.get(id), 'Social template');
    const row = templates.duplicate(id);
    emitCatalogChange('socialGrid', 'template:create', row.id);
    return row;
  });

  /**
   * Count what a config would produce WITHOUT rendering anything.
   *
   * The Product Library's apply modal has to say "9 products → 1 image" before
   * the user commits, and it must not pay for a real render to do it. Same
   * selection code as the export, so the number it promises is the number the
   * export delivers.
   */
  expose('socialGrid:plan', ({ config } = {}) => {
    const ctx = contextFor(config);
    const pages = paginate(ctx.selected, ctx.config);
    const summary = summarize(ctx.products, ctx.config, ctx.brandNames);
    return {
      productCount: ctx.selected.length,
      pageCount: ctx.selected.length ? pages.length : 0,
      perPage: summary.perPage,
      columns: ctx.config.columns,
      rows: ctx.config.rows,
      width: ctx.config.width,
      height: ctx.config.height,
      format: ctx.config.format,
      sample: ctx.selected.slice(0, 5).map((p) => p.name || p.sku),
    };
  });

  /** A real, scaled-down render of page 1 as a data URL — what the user
   *  actually sees in the preview pane. */
  expose('socialGrid:preview', async ({ config, pageIndex = 0 } = {}) => {
    const ctx = contextFor(config);
    const pages = paginate(ctx.selected, ctx.config);
    const pageCount = pages.length;
    const idx = Math.min(Math.max(0, Number(pageIndex) || 0), Math.max(0, pageCount - 1));
    const factor = PREVIEW_MAX / Math.max(ctx.config.width, ctx.config.height);
    const previewConfig = scaledConfig(ctx.config, Math.min(1, factor));

    const summary = summarize(ctx.products, ctx.config, ctx.brandNames);
    if (!ctx.selected.length) {
      return { dataUrl: null, summary, pageCount: 0, pageIndex: 0 };
    }

    const bytes = await renderPageBytes(
      pages[idx], ctx.brands, previewConfig, idx, pageCount,
      ctx.config.format === 'jpeg' ? 'jpeg' : 'png',
      Math.min(85, ctx.config.quality),
    );
    const mime = ctx.config.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, summary, pageCount, pageIndex: idx };
  });

  /* ── the actual export ──────────────────────────────────────────── */

  exposeLocal('socialGrid:export', async ({ config, outputFolder, presetId } = {}) => {
    if (!outputFolder) throw new Error('Pick an output folder');
    const ctx = contextFor(config);
    if (!ctx.selected.length) throw new Error('No products match these filters — nothing to export');
    await fs.promises.mkdir(outputFolder, { recursive: true });

    const pages = paginate(ctx.selected, ctx.config);
    const ext = ctx.config.format === 'jpeg' ? 'jpg' : 'png';
    // One naming implementation, shared with the renderer's own tests: a
    // title if there is one, otherwise the first product's name.
    const slug = seriesSlug(pages[0], ctx.config);
    const opId = `social-${Date.now()}`;
    const made = [];
    events.broadcast('progress:event', { id: opId, kind: 'socialGrid', done: 0, total: pages.length, phase: 'rendering', label: slug });
    try {
      for (let i = 0; i < pages.length; i += 1) {
        const bytes = await renderPageBytes(pages[i], ctx.brands, ctx.config, i, pages.length, ctx.config.format, ctx.config.quality);
        const target = path.join(outputFolder, fileNameFor(slug, i, pages.length, ext));
        await fs.promises.writeFile(target, bytes);
        made.push(target);
        events.broadcast('progress:event', { id: opId, kind: 'socialGrid', done: i + 1, total: pages.length, phase: 'rendering', label: slug });
      }
      if (presetId) {
        const row = presets.get(presetId);
        if (row) {
          presets.markExported(presetId);
          // "Last exported" lives with the data, so tell the other Macs it
          // moved rather than leaving them showing the old date until they
          // navigate away and back.
          emitCatalogChange('socialGrid', 'update', presetId);
        }
      }
      return { outputPaths: made, pageCount: pages.length, productCount: ctx.selected.length };
    } finally {
      events.broadcast('progress:event', { id: opId, complete: true });
    }
  });

  /** Same export, but the bytes come back instead of landing on this Mac's
   *  disk. A client Mac cannot render (no images, no database), but it can
   *  write a file — so the server renders and the client saves. */
  expose('socialGrid:exportBytes', async ({ config } = {}) => {
    const ctx = contextFor(config);
    if (!ctx.selected.length) throw new Error('No products match these filters — nothing to export');
    const pages = paginate(ctx.selected, ctx.config);
    const ext = ctx.config.format === 'jpeg' ? 'jpg' : 'png';
    // One naming implementation, shared with the renderer's own tests: a
    // title if there is one, otherwise the first product's name.
    const slug = seriesSlug(pages[0], ctx.config);
    const files = [];
    for (let i = 0; i < pages.length; i += 1) {
      const bytes = await renderPageBytes(pages[i], ctx.brands, ctx.config, i, pages.length, ctx.config.format, ctx.config.quality);
      files.push({ bytes, fileName: fileNameFor(slug, i, pages.length, ext) });
    }
    return { files, pageCount: pages.length, productCount: ctx.selected.length };
  });

  /** Called by a client once it has written the files, so "last exported"
   *  lives with the data (which is on the server) rather than on the Mac that
   *  happened to do the writing. */
  expose('socialGrid:markExported', ({ id } = {}) => {
    assertEntityInActiveCompany(presets.get(id), 'Post preset');
    presets.markExported(id);
    emitCatalogChange('socialGrid', 'update', id);
    return { ok: true };
  });
}

module.exports = { register };
