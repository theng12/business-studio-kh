/**
 * v0.21.2: products:* IPC handlers, extracted from ipc.js.
 *
 * Catalog-product CRUD plus the v0.18.0 duplicate + v0.18.1
 * bulkUpdate + v0.11.0 bulkUpsert handlers. Every channel is
 * exposed (callable by clients). Mutations emit a single
 * `catalog:changed` event per call; bulk operations emit ONE
 * event per batch rather than spamming N times.
 *
 * The bulk-update allow-list intentionally excludes SKU, barcode,
 * and secondary_code — those are unique-per-product and setting
 * them in bulk only makes sense for one row at a time.
 */

const companies = require('../db/companies');
const products = require('../db/products');
const { getDb } = require('../db');

function register({ expose, emitCatalogChange, assertEntityInActiveCompany }) {
  expose('products:list', ({ companyId, filters } = {}) => {
    if (companyId && companyId !== companies.getActiveId()) return [];
    return products.list(companyId, filters);
  });
  expose('products:get', (id) => {
    return assertEntityInActiveCompany(products.get(id), 'Product');
  });

  // v0.15.0: product mutations exposed to clients.
  // v0.15.1: emit catalog change events after each successful write.
  expose('products:create', (input) => {
    if (input?.companyId && input.companyId !== companies.getActiveId()) {
      throw new Error('Cross-company create blocked');
    }
    const r = products.create(input);
    emitCatalogChange('product', 'create', r?.id);
    return r;
  });
  expose('products:update', ({ id, patch } = {}) => {
    assertEntityInActiveCompany(products.get(id), 'Product');
    const r = products.update(id, patch);
    emitCatalogChange('product', 'update', id);
    return r;
  });
  expose('products:remove', (id) => {
    assertEntityInActiveCompany(products.get(id), 'Product');
    // `{ deleted, deletedEntryId }`: the recycle-bin entry this delete was
    // held under, so the toast's Undo restores exactly it.
    const r = products.removeDetailed(id);
    emitCatalogChange('product', 'remove', id);
    return r;
  });

  // v0.18.0: duplicate a product. Renderer passes
  // { id, includeImages: bool }. Server runs the copy + (optionally)
  // reuses the nested-dir image layout. Emits a catalog change so
  // every other client refetches.
  expose('products:duplicate', async ({ id, includeImages = true } = {}) => {
    assertEntityInActiveCompany(products.get(id), 'Product');
    const created = await products.duplicate(id, { includeImages });
    emitCatalogChange('product', 'create', created?.id);
    return created;
  });

  /**
   * v0.18.1: bulk-update a set of products with the same patch.
   * Used by the Library's "Edit selected" UX after the user
   * multi-selects rows. Each product gets the same partial update;
   * `expectedUpdatedAt` is deliberately NOT honored here — bulk
   * edits are intentionally last-write-wins across the selection,
   * so a 50-row bulk update doesn't fail because one row was
   * edited elsewhere a moment ago. Caller can rerun to pick up
   * the latest if they need to.
   *
   * Returns `{ updated, failed }` so the renderer can surface the
   * outcome ("Updated 47 of 50 — 3 had errors").
   */
  expose('products:bulkUpdate', ({ ids, patch } = {}) => {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { updated: 0, failed: [] };
    }
    // Sanitize the patch — drop `expectedUpdatedAt` if a caller
    // accidentally threaded it through, and reject fields outside
    // the bulk-editable allow-list. Bulk SKU changes don't make
    // sense (uniqueness clashes); same for barcode / secondaryCode.
    const ALLOW = new Set([
      'brandId', 'categoryId', 'status', 'subcategory',
      'colorFinish', 'variant', 'unit',
      'priceRetail', 'priceWholesale', 'description',
    ]);
    const cleanPatch = {};
    for (const k of Object.keys(patch || {})) {
      if (ALLOW.has(k)) cleanPatch[k] = patch[k];
    }
    if (Object.keys(cleanPatch).length === 0) {
      return { updated: 0, failed: [] };
    }
    let updated = 0;
    const failed = [];
    const updateAll = () => {
      for (const id of ids) {
        try {
          const p = products.get(id);
          if (!p) { failed.push({ id, error: 'Product not found' }); continue; }
          if (p.companyId !== companies.getActiveId()) {
            failed.push({ id, sku: p.sku, error: 'Cross-company' });
            continue;
          }
          products.update(id, cleanPatch);
          updated += 1;
        } catch (err) {
          failed.push({ id, error: err.message });
        }
      }
    };
    // One transaction for the batch instead of one commit (and one fsync)
    // per row. update() opens its own transaction, which better-sqlite3 nests
    // as a savepoint: a row that throws rolls back only itself and lands in
    // `failed`, exactly as before. Not for a brand change, though — that
    // moves the product's image folder on disk right after update()'s write,
    // and update() is written so the move follows a COMMITTED row. Inside an
    // outer transaction the folder would move before anything was durable.
    if ('brandId' in cleanPatch) updateAll();
    else getDb().transaction(updateAll)();
    // Emit ONE catalog event for the whole batch instead of N
    // individual events. Other clients refetch their product list
    // once when this arrives, which is far less chatty than N
    // updates rapid-fire (and the renderer's coalescing helper
    // would collapse them anyway).
    if (updated > 0) {
      emitCatalogChange('product', 'bulkUpdate', null, { count: updated });
    }
    return { updated, failed };
  });

  /**
   * v0.22.0: bulk-remove. Used by the Library's "Delete N
   * selected" toolbar action. Each id is checked for cross-
   * company ownership before deletion; failures are collected and
   * reported back so the renderer can surface "Deleted 47 of 50 —
   * 3 failed". One catalog change event for the whole batch (not
   * N) to keep the WebSocket fan-out tidy.
   */
  expose('products:bulkRemove', ({ ids } = {}) => {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { deleted: 0, failed: [] };
    }
    if (ids.length > 5000) {
      throw new Error('Too many ids (max 5000 per batch)');
    }
    const active = companies.getActiveId();
    const safeIds = [];
    const failed = [];
    for (const id of ids) {
      try {
        const p = products.get(id);
        if (!p) { failed.push({ id, error: 'Product not found' }); continue; }
        if (p.companyId !== active) {
          failed.push({ id, sku: p.sku, error: 'Cross-company' });
          continue;
        }
        safeIds.push(id);
      } catch (err) {
        failed.push({ id, error: err.message });
      }
    }
    const result = products.bulkRemove(safeIds);
    if (result.deleted > 0) {
      emitCatalogChange('product', 'bulkRemove', null, { count: result.deleted });
    }
    return {
      deleted: result.deleted,
      failed: [...failed, ...result.failed],
      deletedEntryIds: result.deletedEntryIds || [],
    };
  });

  expose('products:bulkUpsert', ({ companyId, rows, opts } = {}) => {
    if (companyId !== companies.getActiveId()) {
      throw new Error('Cross-company import blocked');
    }
    // opts: { dryRun?: boolean, conflictPolicy?: 'merge'|'overwrite'|'skip' }
    const r = products.bulkUpsert(companyId, rows, opts ?? {});
    // bulk upserts can touch hundreds of rows — emit ONE event with the row
    // count that actually changed rather than spamming one per product.
    // (bulkUpsert does not return `upserted`; no-op rows are deliberately
    // excluded from `updated`.)
    if (!opts?.dryRun) {
      emitCatalogChange('product', 'bulkUpsert', null, {
        count: (r?.inserted ?? 0) + (r?.updated ?? 0),
      });
    }
    return r;
  });
}

module.exports = { register };
