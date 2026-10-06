const crypto = require('node:crypto');
const path = require('node:path');
const { getDb, getDataDir } = require('./index');
const { parseJson, getCallerUserId } = require('./_util');
const { productAssetDir, companyDir } = require('../util/assetPath');
const { trashPathInBackground } = require('../util/fileTrash');
const { normalizeCurrency } = require('../util/currencies');
const { rowHasAnyPrice } = require('../util/prices');

// Late-required to break circular dependencies.
let _companies;
function getCompanies() { return _companies ?? (_companies = require('./companies')); }
let _brands;
function getBrands() { return _brands ?? (_brands = require('./brands')); }
let _imageManager;
function getImageManager() { return _imageManager ?? (_imageManager = require('../imageManager')); }
// v0.22.6: audit log. Late-required so it doesn't get pulled in
// during DB init (auditLog.js requires getDb()).
let _audit;
function getAudit() { return _audit ?? (_audit = require('./auditLog')); }

function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    sku: row.sku,
    name: row.name,
    brandId: row.brand_id,
    barcode: row.barcode,
    secondaryCode: row.secondary_code,
    categoryId: row.category_id,
    subcategory: row.subcategory,
    colorFinish: row.color_finish,
    variant: row.variant,
    unit: row.unit,
    status: row.status,
    tags: parseJson(row.tags, []),
    description: row.description,
    priceRetail: row.price_retail,
    priceWholesale: row.price_wholesale,
    priceRetailCurrency: row.price_retail_currency ?? 'USD',
    priceWholesaleCurrency: row.price_wholesale_currency ?? 'USD',
    prices: parseJson(row.prices, {}),
    customFields: parseJson(row.custom_fields, {}),
    expiryDate: row.expiry_date ?? null,
    taxRate: row.tax_rate ?? null,
    reorderPoint: row.reorder_point ?? null,
    reorderQuantity: row.reorder_quantity ?? null,
    trackInventory: !!row.track_inventory,
    // v0.1.25: units on hand. null = never counted (distinct from 0).
    stockQty: row.stock_qty == null ? null : Number(row.stock_qty),
    variantAttributes: row.variant_attributes ?? null,
    countryOfOrigin: row.country_of_origin ?? null,
    // v0.49.47/48: logistics & sourcing — feed PO line prefills + landed cost.
    supplierId: row.supplier_id ?? null,
    supplierSku: row.supplier_sku ?? null,
    hsCode: row.hs_code ?? null,
    cartonQty: row.carton_qty ?? null,
    cartonWCm: row.carton_w_cm ?? null,
    cartonHCm: row.carton_h_cm ?? null,
    cartonDCm: row.carton_d_cm ?? null,
    weightPerUnitKg: row.weight_per_unit_kg ?? null,
    processStatus: row.process_status,
    // Coerce to Number to guard against BigInt-shaped counts from
    // better-sqlite3 on certain builds — strict equality `BigInt(0) === 0`
    // is false and was silently breaking the "No images" filter and any
    // other numeric comparisons in the renderer.
    imageCount: Number(row.image_count ?? 0),
    processedImageCount: Number(row.processed_image_count ?? 0),
    mainImagePath: row.main_image_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // v0.15.3: attribution. NULL means "the server admin / standalone";
    // an id means a specific RPC client wrote this row last.
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

function newId() {
  return crypto.randomUUID();
}

/**
 * Build a SQL fragment for an "id IN (...) OR IS NULL" filter.
 * @param {string} col — column name on `p`, e.g. 'brand_id'
 * @param {Array<string|null>|undefined} values — array of ids and/or null sentinel
 * @returns {{ fragment: string, params: string[] }}
 */
function buildIdInFilter(col, values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { fragment: '', params: [] };
  }
  const hasNull = values.some((v) => v === null);
  const ids = values.filter((v) => v != null && v !== '');
  const parts = [];
  const params = [];
  if (ids.length > 0) {
    parts.push(`p.${col} IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (hasNull) {
    parts.push(`p.${col} IS NULL`);
  }
  if (parts.length === 0) return { fragment: '', params: [] };
  return { fragment: ` AND (${parts.join(' OR ')})`, params };
}

function list(companyId, filters = {}) {
  if (!companyId) return [];
  const { search, brandIds, categoryIds, status, processStatus, attentionFilter } = filters;
  const params = [companyId];
  // The indexed correlated lookups are deliberate. A previous grouped-join
  // version scanned every product_images row twice before applying the
  // company filter. With the existing (product_id, order_index) indexes, the
  // three lookups touch only images for the selected company's products. The
  // native benchmark in test/productsListQuery.test.js covers the measured
  // trade-off and keeps this path honest as the data shape changes.
  let sql = `
    SELECT p.*,
      (SELECT COUNT(*) FROM product_images pi
         WHERE pi.product_id = p.id) AS image_count,
      (SELECT COUNT(*) FROM product_images pi
         WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
      (SELECT pi.filepath FROM product_images pi
         WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path
    FROM products p
    WHERE p.company_id = ?
  `;

  const brandFilter = buildIdInFilter('brand_id', brandIds);
  sql += brandFilter.fragment;
  params.push(...brandFilter.params);

  const categoryFilter = buildIdInFilter('category_id', categoryIds);
  sql += categoryFilter.fragment;
  params.push(...categoryFilter.params);

  if (status) {
    sql += ' AND p.status = ?';
    params.push(status);
  }
  if (processStatus) {
    sql += ' AND p.process_status = ?';
    params.push(processStatus);
  }
  if (attentionFilter === 'missingBarcode') {
    sql += " AND (p.barcode IS NULL OR TRIM(p.barcode) = '')";
  } else if (attentionFilter === 'notExported') {
    sql += " AND (p.process_status IS NULL OR p.process_status <> 'exported')";
  }
  // v0.26.49: search overhaul. Three changes:
  //
  // 1. SCOPE — narrowed from 6 fields (sku, name, color_finish, tags,
  //    barcode, secondary_code) to the 3 fields actually shown on each
  //    Library card (sku, name, color_finish). Pre-v0.26.49 the search
  //    matched in tags / barcode / secondary_code too, which meant
  //    products could appear in results for reasons the user couldn't
  //    visually verify on the card. For barcode / secondary-code /
  //    tag-based lookups the user can use the Cmd+K global search
  //    palette (v0.18.2), which already searches more broadly.
  //
  // 2. ESCAPE — wildcard meta-chars in user input (`%` and `_`) are
  //    now escaped so they match literally. Pre-v0.26.49 typing `_`
  //    matched any single character; typing `%` matched everything.
  //    `\` is the escape character; we escape `\` itself too to
  //    handle the rare case of a user pasting a path-like string.
  //
  // 3. TRIM — whitespace-only search no longer activates the filter.
  //    A search of "   " used to LIKE %   % which matches every row
  //    with at least 2 spaces somewhere. Now we trim then bail if
  //    the result is empty.
  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  if (trimmedSearch) {
    const escaped = trimmedSearch.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const term = `%${escaped}%`;
    sql +=
      " AND (p.sku LIKE ? ESCAPE '\\'" +
      " OR p.name LIKE ? ESCAPE '\\'" +
      " OR p.color_finish LIKE ? ESCAPE '\\')";
    params.push(term, term, term);
  }
  sql += ' ORDER BY p.updated_at DESC';
  const rows = getDb().prepare(sql).all(...params);
  return (attentionFilter === 'missingPrice' ? rows.filter((row) => !rowHasAnyPrice(row)) : rows).map(rowToProduct);
}

function get(id) {
  const row = getDb()
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
        (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
        (SELECT pi.filepath FROM product_images pi
           WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path
       FROM products p WHERE p.id = ?`,
    )
    .get(id);
  return rowToProduct(row);
}

function getBySku(companyId, sku) {
  const row = getDb()
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
        (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
        (SELECT pi.filepath FROM product_images pi
           WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path
       FROM products p WHERE p.company_id = ? AND p.sku = ?`,
    )
    .get(companyId, sku);
  return rowToProduct(row);
}

/**
 * v0.1.27 — refuse a second product that would share another product's image
 * folder.
 *
 * The on-disk directory is `company/brand/<slug(sku)>`, and `slugify` collapses
 * every run of non-alphanumerics to one `-`. So `A-1`, `A 1`, `A/1`, `A_1` and
 * `A.1` all resolve to the SAME folder — and because UNIQUE(company_id, sku) is
 * on the raw SKU, all five were allowed to exist. They then shared one
 * directory AND one `<slug>-NNN` filename pattern, so deleting one product
 * destroyed the others' images, and reordering or renaming one silently
 * overwrote the others' files.
 *
 * Preventing the collision is the fix that holds everywhere at once, because
 * every one of those destructive paths assumes "one product owns this folder".
 * It is deliberately a hard error naming the conflicting SKU rather than an
 * automatic `-2` suffix: a silent rename would move files that already exist,
 * and the user cannot see which product they are looking at on disk either
 * way. Changing a SKU is cheap; recovering overwritten photos is not.
 *
 * Compared case-insensitively. The Mac's disk is: `abc-1` and `ABC-1` are
 * two SKUs to the database (its UNIQUE is case-sensitive) but ONE folder in
 * Finder, so they shared files exactly like the punctuation case above, and
 * renumbering one renamed over the other's photos. For the same reason it
 * looks across companies whose names land on the same folder ("A&B" and
 * "A B" are both `A-B`).
 *
 * Returns the conflicting product ({ id, sku, companyId }), or null.
 * `index` is an assetDirIndex() to reuse across many checks (a bulk import);
 * without one, a fresh one is built.
 */
function findAssetDirCollision(companyId, proposed, excludeId = null, index = null) {
  if (!companyId || !proposed?.sku) return null;
  const company = getCompanies().get(companyId);
  if (!company) return null;
  let target;
  try {
    const brand = proposed.brandId ? getBrands().get(proposed.brandId) : null;
    target = assetDirKey(productAssetDir(company, brand, proposed));
  } catch (_) {
    return null;   // an uncomputable path cannot collide
  }
  const owners = (index ?? assetDirIndex(company)).get(target) || [];
  return owners.find((o) => o.id !== excludeId) || null;
}

/** The comparison key for a product folder: the disk ignores case, so do we. */
function assetDirKey(rel) {
  return String(rel).toLowerCase();
}

/**
 * Every product folder that can collide with one under `company`: its own
 * products plus those of any company whose name lands on the same folder.
 * Map of assetDirKey → [{ id, sku, companyId }].
 *
 * Reads only the three columns the folder is built from, and each company's
 * brands once. The earlier version mapped every full row (four JSON parses
 * each) and looked each brand up with its own counting query per product,
 * which inside a 1,000-row import into a 2,000-product company came to
 * millions of statements.
 */
function assetDirIndex(company) {
  const db = getDb();
  let slug;
  try { slug = companyDir(company).toLowerCase(); } catch (_) { return new Map(); }
  const companies = db.prepare('SELECT id, name FROM companies').all().filter((c) => {
    try { return companyDir(c).toLowerCase() === slug; } catch (_) { return false; }
  });
  const index = new Map();
  for (const c of companies) {
    const brandById = new Map(
      db.prepare('SELECT id, name FROM brands WHERE company_id = ?').all(c.id).map((b) => [b.id, b]),
    );
    const rows = db.prepare('SELECT id, sku, brand_id FROM products WHERE company_id = ?').all(c.id);
    for (const r of rows) {
      let key;
      try {
        key = assetDirKey(productAssetDir(c, r.brand_id ? brandById.get(r.brand_id) ?? null : null, r));
      } catch (_) { continue; }   // skip uncomputable
      addAssetDirOwner(index, key, { id: r.id, sku: r.sku, companyId: c.id });
    }
  }
  return index;
}

function addAssetDirOwner(index, key, owner) {
  const list = index.get(key);
  if (list) list.push(owner);
  else index.set(key, [owner]);
}

function dropAssetDirOwner(index, id) {
  for (const [key, list] of index) {
    const kept = list.filter((o) => o.id !== id);
    if (kept.length === list.length) continue;
    if (kept.length) index.set(key, kept);
    else index.delete(key);
  }
}

/**
 * `opts.assetDirIndex` lets a bulk import share one folder index across its
 * rows instead of rebuilding it per product; the new product is added to it.
 */
function create(input, opts = {}) {
  if (!input?.companyId) throw new Error('companyId is required');
  if (!input?.sku || !input.sku.trim()) {
    throw new Error('SKU is required');
  }
  const sku = input.sku.trim();
  const existing = getBySku(input.companyId, sku);
  if (existing) {
    throw new Error(`SKU "${sku}" already exists for this company`);
  }
  /* v0.1.27: a different SKU that slugs to the same folder would share this
   * product's images on disk — see findAssetDirCollision. */
  const clash = findAssetDirCollision(input.companyId, { sku, brandId: input.brandId ?? null }, null, opts.assetDirIndex);
  if (clash) {
    throw new Error(
      `SKU "${sku}" would share an image folder with "${clash.sku}" — they differ only by `
      + 'punctuation or capital letters, and the app stores images per product. Add a distinguishing character '
      + `(for example "${sku}-A") or change the brand.`,
    );
  }
  const id = newId();
  const ts = Date.now();
  getDb()
    .prepare(
      `INSERT INTO products (
        id, company_id, sku, name, brand_id, barcode, secondary_code,
        category_id, subcategory, color_finish, variant, unit,
        status, tags, description, price_retail, price_wholesale, prices,
        price_retail_currency, price_wholesale_currency,
        custom_fields, expiry_date, tax_rate, reorder_point, reorder_quantity,
        track_inventory, variant_attributes, country_of_origin,
        supplier_id, supplier_sku, hs_code, carton_qty,
        carton_w_cm, carton_h_cm, carton_d_cm, weight_per_unit_kg,
        process_status, created_at, updated_at, updated_by_user_id, stock_qty
      ) VALUES (
        @id, @companyId, @sku, @name, @brandId, @barcode, @secondaryCode,
        @categoryId, @subcategory, @colorFinish, @variant, @unit,
        @status, @tags, @description, @priceRetail, @priceWholesale, @prices,
        @priceRetailCurrency, @priceWholesaleCurrency,
        @customFields, @expiryDate, @taxRate, @reorderPoint, @reorderQuantity,
        @trackInventory, @variantAttributes, @countryOfOrigin,
        @supplierId, @supplierSku, @hsCode, @cartonQty,
        @cartonWCm, @cartonHCm, @cartonDCm, @weightPerUnitKg,
        @processStatus, @createdAt, @updatedAt, @updatedByUserId, @stockQty
      )`,
    )
    .run({
      id,
      companyId: input.companyId,
      sku,
      name: input.name ?? null,
      brandId: input.brandId ?? null,
      barcode: input.barcode ?? null,
      secondaryCode: input.secondaryCode ?? null,
      categoryId: input.categoryId ?? null,
      subcategory: input.subcategory ?? null,
      colorFinish: input.colorFinish ?? null,
      variant: input.variant ?? null,
      unit: input.unit ?? null,
      status: typeof input.status === 'string' && input.status.trim() ? input.status.trim() : 'active',
      tags: JSON.stringify(input.tags ?? []),
      description: input.description ?? null,
      priceRetail: input.priceRetail ?? null,
      priceWholesale: input.priceWholesale ?? null,
      priceRetailCurrency: normalizeCurrency(input.priceRetailCurrency),
      priceWholesaleCurrency: normalizeCurrency(input.priceWholesaleCurrency),
      prices: JSON.stringify(input.prices ?? {}),
      customFields: JSON.stringify(input.customFields ?? {}),
      expiryDate: input.expiryDate ?? null,
      taxRate: input.taxRate ?? null,
      reorderPoint: input.reorderPoint ?? null,
      reorderQuantity: input.reorderQuantity ?? null,
      trackInventory: input.trackInventory ? 1 : 0,
      stockQty: input.stockQty ?? null,
      variantAttributes: input.variantAttributes ?? null,
      countryOfOrigin: input.countryOfOrigin ?? null,
      // v0.49.48: logistics & sourcing.
      supplierId: input.supplierId ?? null,
      supplierSku: input.supplierSku ?? null,
      hsCode: input.hsCode ?? null,
      cartonQty: input.cartonQty ?? null,
      cartonWCm: input.cartonWCm ?? null,
      cartonHCm: input.cartonHCm ?? null,
      cartonDCm: input.cartonDCm ?? null,
      weightPerUnitKg: input.weightPerUnitKg ?? null,
      processStatus: input.processStatus ?? 'unprocessed',
      createdAt: ts,
      updatedAt: ts,
      updatedByUserId: getCallerUserId(),
    });
  const created = get(id);
  if (opts.assetDirIndex) {
    try {
      const company = getCompanies().get(created.companyId);
      const brand = created.brandId ? getBrands().get(created.brandId) : null;
      addAssetDirOwner(opts.assetDirIndex, assetDirKey(productAssetDir(company, brand, created)),
        { id: created.id, sku: created.sku, companyId: created.companyId });
    } catch (_) { /* uncomputable: cannot collide */ }
  }
  // v0.22.6: audit. Store the full created row as `after` so the
  // History modal can show the initial values.
  try {
    getAudit().log({
      entityType: 'product',
      entityId: id,
      action: 'create',
      after: {
        sku: created.sku,
        name: created.name,
        brandId: created.brandId,
        categoryId: created.categoryId,
        status: created.status,
      },
    });
  } catch (_) {/* audit failures shouldn't break create */}
  return created;
}

const UPDATABLE = {
  sku: { col: 'sku' },
  name: { col: 'name' },
  brandId: { col: 'brand_id' },
  barcode: { col: 'barcode' },
  secondaryCode: { col: 'secondary_code' },
  categoryId: { col: 'category_id' },
  subcategory: { col: 'subcategory' },
  colorFinish: { col: 'color_finish' },
  variant: { col: 'variant' },
  unit: { col: 'unit' },
  status: { col: 'status' },
  tags: { col: 'tags', transform: (v) => JSON.stringify(v ?? []) },
  description: { col: 'description' },
  priceRetail: { col: 'price_retail' },
  priceWholesale: { col: 'price_wholesale' },
  priceRetailCurrency: { col: 'price_retail_currency', transform: normalizeCurrency },
  priceWholesaleCurrency: { col: 'price_wholesale_currency', transform: normalizeCurrency },
  prices: { col: 'prices', transform: (v) => JSON.stringify(v ?? {}) },
  customFields: { col: 'custom_fields', transform: (v) => JSON.stringify(v ?? {}) },
  expiryDate: { col: 'expiry_date' },
  taxRate: { col: 'tax_rate' },
  reorderPoint: { col: 'reorder_point' },
  reorderQuantity: { col: 'reorder_quantity' },
  trackInventory: { col: 'track_inventory', transform: (v) => (v ? 1 : 0) },
  stockQty: { col: 'stock_qty' },
  variantAttributes: { col: 'variant_attributes' },
  countryOfOrigin: { col: 'country_of_origin' },
  // v0.49.48: logistics & sourcing.
  supplierId: { col: 'supplier_id' },
  supplierSku: { col: 'supplier_sku' },
  hsCode: { col: 'hs_code' },
  cartonQty: { col: 'carton_qty' },
  cartonWCm: { col: 'carton_w_cm' },
  cartonHCm: { col: 'carton_h_cm' },
  cartonDCm: { col: 'carton_d_cm' },
  weightPerUnitKg: { col: 'weight_per_unit_kg' },
  processStatus: { col: 'process_status' },
};

/**
 * v0.12.0: when sku / brandId / companyId changes, the product's asset
 * folder moves under the nested layout (`assets/<company>/<brand>/<sku>/`).
 * We compute the old/new paths from the pre/post state of the product
 * row, then move the folder + rewrite every product_images.filepath in
 * one DB transaction. Files are moved AFTER the DB tx commits so the DB
 * row is the truth-of-record if anything fails mid-disk; boot recovery
 * reconciles any orphan files via content_hash.
 */
/**
 * v0.17.2: optimistic concurrency.
 *
 * If the caller passes `expectedUpdatedAt`, we compare it against the
 * row's current `updated_at`. A mismatch means someone else has
 * written to this row since the caller loaded it. We throw a tagged
 * error the renderer can detect:
 *
 *   message format: `CONFLICT|<json-stringified current row>`
 *
 * The prefix is the only reliable channel for "code + details" that
 * survives both `ipcMain.handle` (where custom error props don't get
 * cloned) and `/api/rpc` (where only `.message` flows back). The
 * renderer's `parseConflictError(err)` helper recovers the row info
 * and shows the Refresh / Overwrite dialog.
 *
 * Callers that don't care about conflicts (e.g. bulk imports that
 * are intentionally last-write-wins, internal write-then-read
 * sequences) omit `expectedUpdatedAt` and the check is skipped.
 */
/** `opts.assetDirIndex`: see create(). Kept in step when the folder moves. */
function update(id, patch, opts = {}) {
  const existing = get(id);
  if (!existing) throw new Error('Product not found');

  if (
    patch &&
    patch.expectedUpdatedAt != null &&
    Number(patch.expectedUpdatedAt) !== Number(existing.updatedAt)
  ) {
    const conflict = {
      kind: 'product',
      id: existing.id,
      sku: existing.sku,
      name: existing.name,
      updatedAt: existing.updatedAt,
      updatedByUserId: existing.updatedByUserId,
    };
    throw new Error(`CONFLICT|${JSON.stringify(conflict)}`);
  }
  // Strip the version token so it doesn't try to write itself.
  if (patch && 'expectedUpdatedAt' in patch) {
    patch = { ...patch };
    delete patch.expectedUpdatedAt;
  }

  if (patch.sku && patch.sku !== existing.sku) {
    const clash = getBySku(existing.companyId, patch.sku);
    if (clash) throw new Error(`SKU "${patch.sku}" already exists for this company`);
  }

  // Detect a path-affecting change before writing. The product fields we
  // care about: sku, brandId, companyId. Compare the patch to existing.
  const newSku = (patch.sku ?? existing.sku);
  const newBrandId = ('brandId' in patch) ? (patch.brandId ?? null) : existing.brandId;
  const newCompanyId = ('companyId' in patch) ? (patch.companyId ?? null) : existing.companyId;
  const pathChanged =
    newSku !== existing.sku ||
    newBrandId !== existing.brandId ||
    newCompanyId !== existing.companyId;

  // Compute old + new dirs (only if affected).
  let oldDir = null;
  let newDir = null;
  if (pathChanged) {
    const oldCompany = getCompanies().get(existing.companyId);
    const oldBrand = existing.brandId ? getBrands().get(existing.brandId) : null;
    oldDir = productAssetDir(oldCompany, oldBrand, existing);

    const newCompany = getCompanies().get(newCompanyId);
    if (!newCompany) throw new Error('Target company not found');
    const newBrand = newBrandId ? getBrands().get(newBrandId) : null;
    const proposedProduct = { ...existing, sku: newSku, brandId: newBrandId, companyId: newCompanyId };
    newDir = productAssetDir(newCompany, newBrand, proposedProduct);
    /* v0.1.27: same guard when a SKU or brand change moves the product onto a
     * folder another product already owns. */
    const sameGroup = opts.assetDirIndex && newCompanyId === existing.companyId;
    const moveClash = findAssetDirCollision(newCompanyId, proposedProduct, id, sameGroup ? opts.assetDirIndex : null);
    if (moveClash) {
      throw new Error(
        `SKU "${newSku}" would share an image folder with "${moveClash.sku}" — `
        + 'they differ only by punctuation or capital letters, and the app stores images per product. '
        + `Add a distinguishing character (for example "${newSku}-A") or pick another brand.`,
      );
    }
  }

  const sets = [];
  const params = {};
  // v0.22.6: snapshot only the keys in `patch` (and only the ones
  // that actually changed). diffPatch inside auditLog handles the
  // "no-op patch → no log row" case so an update() that passes an
  // unchanged value doesn't pollute the audit feed.
  const auditPatch = {};
  for (const [key, def] of Object.entries(UPDATABLE)) {
    if (!(key in patch)) continue;
    sets.push(`${def.col} = @${key}`);
    params[key] = def.transform ? def.transform(patch[key]) : (patch[key] ?? null);
    auditPatch[key] = patch[key] ?? null;
  }
  if (sets.length === 0) return existing;
  sets.push('updated_at = @updatedAt');
  sets.push('updated_by_user_id = @updatedByUserId');
  params.updatedAt = Date.now();
  params.updatedByUserId = getCallerUserId();
  params.id = id;

  const db = getDb();
  // Update row + rewrite product_images.filepath in one tx. File moves
  // happen after commit (a partial disk move is recoverable; a partial
  // DB write is not).
  const tx = db.transaction(() => {
    db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = @id`).run(params);
    if (pathChanged && oldDir !== newDir) {
      // Rewrite every product_image filepath from oldDir/* → newDir/*.
      const oldPrefix = `${oldDir}/`;
      const rows = db
        .prepare('SELECT id, filepath FROM product_images WHERE product_id = ?')
        .all(id);
      const upd = db.prepare('UPDATE product_images SET filepath = ? WHERE id = ?');
      for (const r of rows) {
        if (r.filepath && r.filepath.startsWith(oldPrefix)) {
          const tail = r.filepath.slice(oldPrefix.length);
          upd.run(`${newDir}/${tail}`, r.id);
        }
      }
    }
  });
  tx();

  if (pathChanged && opts.assetDirIndex) {
    dropAssetDirOwner(opts.assetDirIndex, id);
    if (newCompanyId === existing.companyId) {
      addAssetDirOwner(opts.assetDirIndex, assetDirKey(newDir), { id, sku: newSku, companyId: newCompanyId });
    }
  }

  if (pathChanged && oldDir !== newDir) {
    try {
      getImageManager().moveProductDir(oldDir, newDir);
    } catch (err) {
      // Disk move failed but DB is already updated. The boot recovery
      // sweep will reconcile via content_hash. Surface to stderr so it
      // shows up in crash.log.
      process.stderr.write(`[products.update] moveProductDir failed (${oldDir} → ${newDir}): ${err.message}\n`);
    }

    // v0.12.1: when the SKU changes, the in-folder filenames must also
    // change because the basename is `<sku-slug>-NNN`. Brand/company
    // changes alone don't affect file basenames so we only renumber on
    // SKU edits.
    const skuChanged = patch.sku && patch.sku !== existing.sku;
    if (skuChanged) {
      try {
        require('./productImages').renumberFiles(id);
      } catch (err) {
        process.stderr.write(`[products.update] renumberFiles after SKU rename failed: ${err.message}\n`);
      }
    }
  }

  // v0.22.6: audit. Log AFTER the disk move so a failed file move
  // doesn't leave a misleading "renamed to X" log entry pointing at
  // nothing on disk (the boot recovery sweep would still reconcile,
  // but logging post-tx keeps the timeline honest).
  try {
    getAudit().logUpdate({
      entityType: 'product',
      entityId: id,
      beforeRow: existing,
      patch: auditPatch,
    });
  } catch (_) {/* audit failures shouldn't break update */}

  return get(id);
}

function remove(id) {
  /* po_lines.product_id is ON DELETE RESTRICT: a product on a purchase order
   * cannot go, and the bare "FOREIGN KEY constraint failed" said nothing about
   * why. Name the PO(s) before anything is touched. */
  const onPos = getDb().prepare(`
    SELECT DISTINCT p.sku, COALESCE(po.po_number, '(no number)') AS po
      FROM po_lines l JOIN purchase_orders po ON po.id = l.po_id JOIN products p ON p.id = l.product_id
     WHERE l.product_id = ?`).all(id);
  if (onPos.length) {
    const many = onPos.length > 1;
    throw new Error(`SKU ${onPos[0].sku} is on purchase order${many ? 's' : ''} ${onPos.map((r) => r.po).join(', ')}. `
      + `Remove it from ${many ? 'those POs' : 'that PO'} first.`);
  }
  // Compute the asset dir before deletion so we can clean up after.
  // Safe to skip if the product doesn't exist (nothing to clean).
  let dirToClean = null;
  /* v0.1.27: hoisted out of the try below because the shared-folder check in
   * the cleanup block needs them too. */
  let removedProduct = null;
  let removedCompany = null;
  // v0.22.0: also collect ai-gallery files attached to this
  // product. ON DELETE CASCADE on ai_gallery.product_id removes
  // the DB rows, but the PNG/JPG files on disk under
  // <dataDir>/ai-gallery/<sku>/ stayed orphaned. Now we list them
  // BEFORE the DELETE (so we still have the rows to look at) and
  // unlink them after the DELETE succeeds.
  let aiGalleryAbsPaths = [];
  try {
    const existing = get(id);
    if (existing) {
      const company = getCompanies().get(existing.companyId);
      const brand = existing.brandId ? getBrands().get(existing.brandId) : null;
      if (company) dirToClean = productAssetDir(company, brand, existing);
      removedProduct = existing;
      removedCompany = company;

      // Gather ai_gallery file paths for this product.
      try {
        const galleryRows = getDb()
          .prepare('SELECT filepath FROM ai_gallery WHERE product_id = ?')
          .all(id);
        const dataDir = getDataDir();
        aiGalleryAbsPaths = galleryRows
          .map((r) => r.filepath)
          .filter(Boolean)
          .map((rel) => path.join(dataDir, rel));
      } catch (_) { /* best-effort */ }
    }
  } catch (_) {/* ignore */}

  // Capture the pre-delete row so we can log it (we can't query it
  // afterwards). Grabbing it here is cheap; the earlier `get(id)`
  // call lives in the asset-dir-resolution block above but is in a
  // try/catch and might be null. Re-fetch here unconditionally.
  let preDeleteRow = null;
  try { preDeleteRow = get(id); } catch (_) {}

  /* v0.1.86: the raw rows, taken before the DELETE, are what makes a restore
   * faithful — `payload_json` in `deleted_items` is a copy of these, so putting
   * a product back re-inserts it exactly as it was instead of rebuilding it
   * from a summary. `get(id)` above returns the camelCase mapped object, which
   * is not what an INSERT needs. */
  let rawProductRow = null;
  let rawImageRows = [];
  let aiGalleryRelPaths = [];
  let rawAiGalleryRows = [];
  try { rawProductRow = getDb().prepare('SELECT * FROM products WHERE id = ?').get(id); } catch (_) {}
  try {
    rawImageRows = getDb()
      .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY order_index ASC')
      .all(id);
  } catch (_) {}
  try {
    /* The rows too, not only their files: ai_gallery cascades with the
     * product, so without a snapshot a restored product came back with its AI
     * pictures on disk and nothing in AI Studio pointing at them. */
    rawAiGalleryRows = getDb()
      .prepare('SELECT * FROM ai_gallery WHERE product_id = ?')
      .all(id);
    aiGalleryRelPaths = rawAiGalleryRows
      .map((r) => r.filepath)
      .filter(Boolean);
  } catch (_) {}

  const info = getDb().prepare('DELETE FROM products WHERE id = ?').run(id);
  const deleted = info.changes > 0;

  if (deleted) {
    // v0.22.6: audit the delete. The row is gone, so we log the
    // snapshot we captured pre-delete as `before`. NULL `after` =
    // entity no longer exists.
    try {
      getAudit().log({
        entityType: 'product',
        entityId: id,
        action: 'delete',
        before: preDeleteRow
          ? {
              sku: preDeleteRow.sku,
              name: preDeleteRow.name,
              brandId: preDeleteRow.brandId,
              categoryId: preDeleteRow.categoryId,
              status: preDeleteRow.status,
            }
          : null,
      });
    } catch (_) {/* audit failures shouldn't break delete */}
  }

  if (deleted) {
    /* v0.1.86: hold the whole thing — rows and files — in the recycle bin so
     * the owner can put it back. This replaces the v0.1.85 "move the folder to
     * the macOS Trash" step, which was recoverable but not restorable: the
     * pictures came back to disk while the product entry stayed gone, so the
     * only real recovery was a backup. Holding is a rename into
     * `<dataDir>/.recycle/<id>/`, instant even for a large folder, and the
     * Trash is used later — when the item is purged (main/deletedItems.js).
     *
     * The shared-folder rule from v0.1.27 is preserved: when the folder is
     * shared with another product we move NOTHING (their files cannot be told
     * apart from ours), and the held item records that so a restore only
     * re-inserts the rows over the files that are still there.
     *
     * If holding fails, fall back to the previous behaviour — files to the
     * Trash, item not restorable — rather than leaving the files behind with
     * no record at all. */
    /* Case-insensitive and across same-named companies, like
     * findAssetDirCollision: on the Mac's disk `abc-1` and `ABC-1` are one
     * folder, and moving it would take the other product's photos too. */
    let sharedWithCount = 0;
    if (dirToClean && removedCompany) {
      try {
        const owners = assetDirIndex(removedCompany).get(assetDirKey(dirToClean)) || [];
        sharedWithCount = owners.filter((o) => o.id !== id).length;
      } catch (_) { /* treat as unshared */ }
    }

    try {
      require('../deletedItems').holdProduct({
        productRow: rawProductRow,
        imageRows: rawImageRows,
        assetDirRel: dirToClean,
        aiGalleryRel: aiGalleryRelPaths,
        aiGalleryRows: rawAiGalleryRows,
        companyId: removedCompany?.id ?? rawProductRow?.company_id ?? null,
        userId: getCallerUserId(),
        moveAssets: sharedWithCount === 0,
      });
      if (sharedWithCount > 0) {
        process.stderr.write(
          `[products.remove] ${dirToClean} is shared with ${sharedWithCount} other product(s), `
          + `which all slug to the same folder name (e.g. "A-1" and "A 1"). No files were moved — `
          + `they cannot be told apart from ${removedProduct?.sku}'s. `
          + 'Rename one of the SKUs (add a distinguishing character) to separate them.\n',
        );
      }
    } catch (err) {
      process.stderr.write(`[products.remove] could not hold ${id} for restore: ${err.message}\n`);
      if (sharedWithCount === 0 && dirToClean) {
        trashPathInBackground(path.join(getDataDir(), 'assets', dirToClean));
      }
      for (const abs of aiGalleryAbsPaths) trashPathInBackground(abs);
    }
  }
  return deleted;
}

/**
 * v0.22.0: bulk-remove. Called from the Library's "Delete N
 * selected" toolbar. Iterates `remove(id)` so each delete still
 * cleans up disk + emits the same cascade behavior — same code
 * path, just looped. Returns `{ deleted, failed }` so the
 * renderer can surface "Deleted 47 of 50 — 3 failed". Cross-
 * company guards live at the IPC layer; this function trusts
 * the caller.
 */
function bulkRemove(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { deleted: 0, failed: [] };
  }
  let deleted = 0;
  const failed = [];
  for (const id of ids) {
    try {
      const ok = remove(id);
      if (ok) deleted += 1;
      else failed.push({ id, error: 'Product not found' });
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }
  return { deleted, failed };
}

function setProcessStatus(id, status) {
  return update(id, { processStatus: status });
}

function recomputeProcessStatus(id) {
  const db = getDb();
  const product = get(id);
  if (!product) return null;
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN is_processed = 1 THEN 1 ELSE 0 END) AS processed
       FROM product_images WHERE product_id = ?`,
    )
    .get(id);
  const total = counts.total ?? 0;
  const processed = counts.processed ?? 0;
  let next;
  if (total === 0) next = 'unprocessed';
  else if (processed === 0) next = 'unprocessed';
  else if (processed < total) next = 'in_progress';
  else next = product.processStatus === 'exported' ? 'exported' : 'done';
  if (next !== product.processStatus) return setProcessStatus(id, next);
  return product;
}

/**
 * The custom-field keys a company's products already use, as `custom.<key>`.
 *
 * v0.1.65: the import sample sheet offers a column per custom field the company
 * is actually using, so a shop that tracks "material" or "voltage" is not
 * expected to invent the column name from memory. Bounded and sorted so two
 * downloads of the same data produce the same sheet.
 */
function customFieldKeys(companyId, limit = 24) {
  const rows = getDb()
    .prepare("SELECT custom_fields FROM products WHERE company_id = ? AND custom_fields IS NOT NULL AND custom_fields != '{}'")
    .all(companyId);
  const keys = new Set();
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.custom_fields); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    for (const key of Object.keys(parsed)) {
      if (key && String(key).trim()) keys.add(`custom.${String(key).trim()}`);
    }
  }
  return Array.from(keys).sort().slice(0, limit);
}

/**
 * Bulk insert/update from import. Each row must have a `sku`.
 *
 * @param {string}  companyId
 * @param {Array}   rows
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]  Compute the changes but don't write
 *   them. Used by the import preview screen to show the user a diff of
 *   what would happen before they commit. The returned `changes` array
 *   contains one entry per import row: { rowIndex, sku, action, diffs?, reason? }.
 * @param {'merge'|'overwrite'|'skip'} [opts.conflictPolicy='merge']
 *   What to do when an existing SKU is touched:
 *     - 'merge'     — only set fields that are non-empty in the new row;
 *                     leave existing values for fields the user didn't fill.
 *                     (Same as the pre-v0.9.6 behaviour.)
 *     - 'overwrite' — set every mapped field on the existing row, even
 *                     when the new value is blank (writes null/empty).
 *                     Useful when the import IS the source of truth.
 *     - 'skip'      — leave the existing row completely alone; new rows
 *                     still insert as usual.
 *
 * Image data is never touched by import regardless of policy.
 */
function bulkUpsert(companyId, rows, opts = {}) {
  const dryRun = !!opts.dryRun;
  const policy = opts.conflictPolicy === 'overwrite' ? 'overwrite'
              : opts.conflictPolicy === 'skip'       ? 'skip'
                                                     : 'merge';
  if (!companyId) throw new Error('companyId is required');
  const db = getDb();

  /* Normalize status once at the boundary so every policy, and the dry-run and
   * live paths, agree. A blank/whitespace/non-string status is treated as "not
   * supplied": an insert defaults to 'active' and an existing row is left
   * alone. Without this, a whitespace-only status could reach the update path
   * and store a value that matches no status filter, and the dry-run insert
   * record could disagree with what create() stores. */
  const normalizedRows = rows.map((row) => {
    if (!row || typeof row !== 'object' || !('status' in row)) return row;
    const value = row.status;
    if (typeof value === 'string' && value.trim() !== '') return { ...row, status: value.trim() };
    const copy = { ...row };
    delete copy.status;
    return copy;
  });

  // Pre-fetch existing SKUs in ONE query (instead of getBySku per row).
  // For a 1000-row import this drops 1000 SELECTs to 1 — the per-row check
  // becomes an O(1) Map lookup. The full row from the DB is still needed
  // because update() uses the existing id to build the WHERE clause.
  const trimmedRows = normalizedRows
    .map((r) => ({ raw: r, sku: r && r.sku ? String(r.sku).trim() : '' }))
    .filter((x) => x.sku);
  const existingMap = new Map();
  if (trimmedRows.length > 0) {
    const skus = trimmedRows.map((x) => x.sku);
    // SQLite parameter limit is 32K; chunk to 500 to stay well under and
    // keep the prepared statement small.
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(', ');
      const stmt = db.prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count,
          (SELECT COUNT(*) FROM product_images pi WHERE pi.product_id = p.id AND pi.is_processed = 1) AS processed_image_count,
          (SELECT pi.filepath FROM product_images pi
             WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS main_image_path
         FROM products p WHERE p.company_id = ? AND p.sku IN (${placeholders})`,
      );
      for (const row of stmt.all(companyId, ...chunk)) {
        const mapped = rowToProduct(row);
        existingMap.set(mapped.sku, mapped);
      }
    }
  }

  // The full set of scalar fields the import can touch. Listed here once so
  // it's the same set used for the merge/overwrite patch computation, for
  // the dry-run diff, and (implicitly) for the create call below.
  const UPSERT_FIELDS = [
    'name', 'brandId', 'barcode', 'secondaryCode', 'categoryId',
    'subcategory', 'colorFinish', 'variant', 'unit', 'status',
    'description', 'priceRetail', 'priceWholesale',
    // v0.1.65: per-field currencies. A price list from a supplier is in ONE
    // currency, and a sheet that can only carry the number forced everyone into
    // whatever the app defaulted to.
    'priceRetailCurrency', 'priceWholesaleCurrency',
    // v0.49.49: logistics & sourcing — importable from a packing list.
    'supplierSku', 'hsCode', 'cartonQty', 'cartonWCm', 'cartonHCm',
    'cartonDCm', 'weightPerUnitKg',
    // v0.1.25: units on hand. Under the 'merge' policy a blank cell leaves the
    // existing count untouched (see nextValueFor), so re-importing a price list
    // that has no stock column cannot silently zero everybody's stock.
    'stockQty',
  ];
  // Field is considered "supplied" by the import row when the key is
  // present at all (even if the value is empty string). Empty string vs
  // undefined is the signal: '' means "user explicitly cleared", undefined
  // means "user didn't include this column at all".
  const isSupplied = (row, key) => key in row && row[key] !== undefined;

  // Computes the new value of a single field given the row + policy. Used
  // in both the live run and dry-run paths so behaviour is guaranteed
  // identical.
  function nextValueFor(existing, row, key) {
    if (policy === 'overwrite') {
      // Apply whatever the row says, even when empty. Missing key = leave alone.
      if (!isSupplied(row, key)) return { changed: false };
      // status is NOT NULL (default 'active'). A blank/null status must leave
      // the existing value alone rather than write null, which would fail the
      // whole row's update and silently skip every other field on that row.
      if (key === 'status' && (row[key] === '' || row[key] == null)) return { changed: false };
      const next = row[key] === '' ? null : row[key];
      return { changed: next !== existing[key], value: next };
    }
    if (policy === 'skip') {
      return { changed: false };  // never patch existing rows
    }
    // 'merge' — only set when the new value is non-empty.
    if (!isSupplied(row, key) || row[key] === '' || row[key] === null) return { changed: false };
    return { changed: row[key] !== existing[key], value: row[key] };
  }

  // Per-row error handling. A single bad row (UNIQUE clash, missing FK,
  // type mismatch, etc.) used to abort the entire transaction because
  // better-sqlite3 throws straight up the stack. We now run each row in
  // its own SAVEPOINT so one failure rolls back only that row and lets
  // the rest of the import complete. The renderer surfaces the skips
  // with reasons so the user can fix or accept them.
  const inserted = [];
  const updatedIds = [];
  const skips = [];   // [{ rowIndex, sku, reason, category }]
  const changes = []; // [{ rowIndex, sku, action, diffs?, reason? }] — preview payload

  /* One folder index for the whole import, built on first use and kept in
   * step by create()/update(): checking each new SKU against the company is a
   * Map lookup rather than a scan of every product per row. */
  let sharedDirIndex = null;
  const dirIndex = () => {
    if (!sharedDirIndex) {
      const company = getCompanies().get(companyId);
      sharedDirIndex = company ? assetDirIndex(company) : new Map();
    }
    return sharedDirIndex;
  };

  const work = (items) => {
    items.forEach((row, idx) => {
      if (!row.sku || !String(row.sku).trim()) {
        skips.push({ rowIndex: idx, sku: '', reason: 'missing SKU', category: 'missing_sku' });
        changes.push({ rowIndex: idx, sku: '', action: 'skip', reason: 'missing SKU', category: 'missing_sku' });
        return;
      }
      const sku = String(row.sku).trim();
      const existing = existingMap.get(sku);
      try {
        if (existing) {
          // Build patch + diff at the same time so the dry-run preview
          // shows exactly the same effective change set the real run
          // would apply.
          const patch = {};
          const diffs = [];
          for (const key of UPSERT_FIELDS) {
            const { changed, value } = nextValueFor(existing, row, key);
            if (changed) {
              patch[key] = value;
              diffs.push({ field: key, oldValue: existing[key] ?? null, newValue: value ?? null });
            }
          }
          // Tags merge is array-aware: overwrite always replaces, merge
          // replaces only when the new list is non-empty, and skip leaves the
          // existing row completely alone (its docstring promises exactly that).
          if (Array.isArray(row.tags) && policy !== 'skip') {
            const replace = policy === 'overwrite' || row.tags.length > 0;
            if (replace) {
              const oldTags = Array.isArray(existing.tags) ? existing.tags : [];
              const sameTags = oldTags.length === row.tags.length && oldTags.every((t, i) => t === row.tags[i]);
              if (!sameTags) {
                patch.tags = row.tags;
                diffs.push({ field: 'tags', oldValue: oldTags, newValue: row.tags });
              }
            }
          }

          /* Custom price groups (v0.1.65).
           *
           * products.prices is a JSON map, so — like every other JSON field in
           * an import — it merges per key rather than replacing the object.
           * Replacing it would wipe the groups the sheet did not mention, and a
           * sheet only ever mentions the groups it has columns for.
           *
           * A blank amount is meaningful: under Overwrite it clears that group
           * (the user asked for the sheet to be the source of truth), under
           * Merge it leaves the stored amount alone. */
          if (row.prices && typeof row.prices === 'object' && policy !== 'skip') {
            const before = existing.prices && typeof existing.prices === 'object' ? existing.prices : {};
            const after = { ...before };
            let touched = false;
            for (const [groupKey, incoming] of Object.entries(row.prices)) {
              if (!incoming || typeof incoming !== 'object') continue;
              const current = after[groupKey] && typeof after[groupKey] === 'object' ? { ...after[groupKey] } : {};
              const amountBlank = incoming.amount == null;
              const currencyBlank = !incoming.currency;
              if (amountBlank && currencyBlank) {
                if (policy === 'overwrite' && groupKey in after) { delete after[groupKey]; touched = true; }
                continue;
              }
              const next = { ...current };
              if (!amountBlank) next.amount = incoming.amount;
              if (!currencyBlank) next.currency = incoming.currency;
              if (next.amount == null && next.currency == null) continue;
              if (JSON.stringify(next) !== JSON.stringify(current)) { after[groupKey] = next; touched = true; }
            }
            if (touched) {
              patch.prices = after;
              diffs.push({ field: 'prices', oldValue: before, newValue: after });
            }
          }

          /* Custom fields (v0.1.65): the same JSON-merge rule as prices.
           * products.custom_fields is a map, so a row that sets "material" must
           * not wipe "voltage" — the old behaviour passed the incoming object
           * straight through and the column replaced the whole blob. A blank
           * value clears the key under Overwrite and is ignored under Merge. */
          if (row.customFields && typeof row.customFields === 'object' && policy !== 'skip') {
            const before = existing.customFields && typeof existing.customFields === 'object' ? existing.customFields : {};
            const after = { ...before };
            let touched = false;
            for (const [fieldKey, value] of Object.entries(row.customFields)) {
              if (value == null || value === '') {
                if (policy === 'overwrite' && fieldKey in after) { delete after[fieldKey]; touched = true; }
                continue;
              }
              if (after[fieldKey] !== value) { after[fieldKey] = value; touched = true; }
            }
            if (touched) {
              patch.customFields = after;
              diffs.push({ field: 'customFields', oldValue: before, newValue: after });
            }
          }

          if (diffs.length === 0) {
            // Existing row already matches — nothing to do. Reported as a
            // "no-op" change so the user can see we considered it, and NOT
            // counted as an update: the preview and the post-Apply review must
            // agree about how many rows actually changed.
            changes.push({ rowIndex: idx, sku, action: 'no_change', existingId: existing.id });
          } else {
            if (!dryRun) {
              update(existing.id, patch, { assetDirIndex: dirIndex() });
              updatedIds.push(existing.id);
            }
            /* Keep this call's baseline current so a later duplicate row in the
             * SAME call compares against the effective state — exactly as a
             * later Apply batch (which re-queries the DB) does. Without this a
             * single-call Preview and the batched Apply could disagree about a
             * repeated existing SKU straddling a 250-row boundary. */
            existingMap.set(sku, { ...existing, ...patch });
            changes.push({ rowIndex: idx, sku, action: 'update', existingId: existing.id, diffs });
          }
        } else {
          // Build the would-be inserted record for both the create call
          // and the preview diff list.
          const newRecord = {
            companyId,
            sku,
            name:          row.name          ?? null,
            brandId:       row.brandId       ?? null,
            barcode:       row.barcode       ?? null,
            secondaryCode: row.secondaryCode ?? null,
            categoryId:    row.categoryId    ?? null,
            subcategory:   row.subcategory   ?? null,
            colorFinish:   row.colorFinish   ?? null,
            variant:       row.variant       ?? null,
            unit:          row.unit          ?? null,
            status:        row.status        ?? 'active',
            tags:          row.tags          ?? [],
            description:   row.description   ?? null,
            priceRetail:   row.priceRetail   ?? null,
            priceWholesale: row.priceWholesale ?? null,
            // v0.49.49: logistics & sourcing.
            supplierSku:     row.supplierSku     ?? null,
            hsCode:          row.hsCode          ?? null,
            cartonQty:       row.cartonQty       ?? null,
            cartonWCm:       row.cartonWCm       ?? null,
            cartonHCm:       row.cartonHCm       ?? null,
            cartonDCm:       row.cartonDCm       ?? null,
            weightPerUnitKg: row.weightPerUnitKg ?? null,
            // v0.1.25: units on hand.
            stockQty:        row.stockQty        ?? null,
            // v0.1.65: per-field currencies, the custom price-group map and any
            // custom fields the sheet carried.
            priceRetailCurrency:    row.priceRetailCurrency    || undefined,
            priceWholesaleCurrency: row.priceWholesaleCurrency || undefined,
            prices:       row.prices && typeof row.prices === 'object' ? row.prices : undefined,
            customFields: row.customFields && typeof row.customFields === 'object' ? row.customFields : undefined,
          };
          if (dryRun) {
            // For previews, surface the non-default fields so the user
            // sees what we'll actually fill in.
            const diffs = [];
            for (const key of UPSERT_FIELDS) {
              const v = newRecord[key];
              if (v !== null && v !== undefined && v !== '') {
                diffs.push({ field: key, oldValue: null, newValue: v });
              }
            }
            if (newRecord.tags?.length > 0) {
              diffs.push({ field: 'tags', oldValue: [], newValue: newRecord.tags });
            }
            changes.push({ rowIndex: idx, sku, action: 'insert', diffs });
            // Pretend it now exists so a duplicate further in the file
            // becomes an update (same as live behaviour).
            existingMap.set(sku, { id: '__pending__', sku, ...newRecord });
          } else {
            const created = create(newRecord, { assetDirIndex: dirIndex() });
            if (created) existingMap.set(sku, created);
            inserted.push(created?.id ?? sku);
            changes.push({ rowIndex: idx, sku, action: 'insert', existingId: created?.id });
          }
        }
      } catch (err) {
        const msg = err?.message ?? String(err);
        const category = /UNIQUE|already exists/i.test(msg) ? 'duplicate'
                       : /FOREIGN KEY/i.test(msg)            ? 'bad_reference'
                       : /NOT NULL/i.test(msg)               ? 'missing_field'
                                                             : 'error';
        skips.push({ rowIndex: idx, sku, reason: msg, category });
        changes.push({ rowIndex: idx, sku, action: 'skip', reason: msg, category });
      }
    });
    return {
      inserted: inserted.length,
      updated: updatedIds.length,
      skips,
      changes,
      conflictPolicy: policy,
      dryRun,
    };
  };

  // Dry-run skips the transaction entirely — no writes means no rollback
  // needed. The work() function is otherwise identical to the live run so
  // the user is guaranteed to see exactly what would happen.
  if (dryRun) return work(normalizedRows);
  const tx = db.transaction(work);
  return tx(normalizedRows);
}

/**
 * v0.18.0: duplicate a product. Copies every scalar field; SKU and
 * name get " (copy)" appended (or " (copy 2)" / " (copy 3)" on
 * collision so back-to-back duplicates don't fight). If
 * `includeImages` is true, every product_images row is copied — same
 * file on disk (content-addressed, so this is a same-hash dedup with
 * no extra bytes) but a fresh DB row pointing to it.
 *
 * Resets processStatus to 'unprocessed' so the duplicate doesn't
 * inherit the original's exported flag.
 */
async function duplicate(id, { includeImages = true } = {}) {
  const original = get(id);
  if (!original) throw new Error('Product not found');

  // Find an unused SKU based on the original's. Try " (copy)", " (copy 2)",
  // " (copy 3)", … so multi-clicks don't fail with a uniqueness error.
  function nextSlot(base) {
    let candidate = `${base} (copy)`;
    if (!getBySku(original.companyId, candidate)) return candidate;
    for (let i = 2; i < 100; i++) {
      candidate = `${base} (copy ${i})`;
      if (!getBySku(original.companyId, candidate)) return candidate;
    }
    throw new Error('Too many duplicates already exist');
  }
  const newSku = nextSlot(original.sku);
  const newName = original.name ? `${original.name} (copy)` : null;

  const created = create({
    companyId: original.companyId,
    sku: newSku,
    name: newName,
    brandId: original.brandId,
    barcode: null,            // barcodes are unique per-product by convention; don't clone
    secondaryCode: null,
    categoryId: original.categoryId,
    subcategory: original.subcategory,
    colorFinish: original.colorFinish,
    variant: original.variant,
    unit: original.unit,
    status: original.status,
    tags: original.tags,
    description: original.description,
    priceRetail: original.priceRetail,
    priceWholesale: original.priceWholesale,
    // v0.49.48: carry logistics & sourcing defaults to the duplicate.
    supplierId: original.supplierId,
    supplierSku: original.supplierSku,
    hsCode: original.hsCode,
    cartonQty: original.cartonQty,
    cartonWCm: original.cartonWCm,
    cartonHCm: original.cartonHCm,
    cartonDCm: original.cartonDCm,
    weightPerUnitKg: original.weightPerUnitKg,
    processStatus: 'unprocessed',
  });

  if (includeImages) {
    // Copy each product_images row from the original to the new
    // product. addFromSource handles the nested-dir layout +
    // dedup-by-hash. Since the source file is already in the assets
    // tree, dedup will short-circuit and we'll get a fresh row that
    // points at the same file under the new product's directory.
    const productImages = require('./productImages');
    const path = require('node:path');
    const dataDir = getDataDir();
    const rows = productImages.listByProduct(original.id);
    for (const row of rows) {
      try {
        const absPath = path.join(dataDir, 'assets', row.filepath);
        await productImages.addFromSource(created.id, absPath, {
          originalFilepath: row.filepath,
        });
      } catch (_err) {
        // Best-effort: a missing source file shouldn't fail the
        // whole duplicate. The user will see N images instead of
        // N+1 in the new product.
      }
    }
    recomputeProcessStatus(created.id);
  }
  return get(created.id);
}

/**
 * v0.22.8: bump the product row's updated_at + updated_by_user_id
 * WITHOUT going through update() (which would diff-and-log the audit
 * trail; we don't want a no-op "Edited 5 min ago" entry every time
 * the user just reorders images). Used by the image IPC handlers so
 * the Library list/grid thumbnails get a fresh `?v=updatedAt` cache
 * key after every image add/remove/reorder/set-main.
 *
 * Side benefit: the "Edited 5 min ago by Alice" attribution chip in
 * the side panel + Library row will reflect image edits too, not just
 * scalar field edits. That's a more honest answer to "when did this
 * product last change?".
 */
function touchUpdated(id) {
  if (!id) return null;
  const db = getDb();
  db.prepare(`
    UPDATE products
       SET updated_at = @updatedAt,
           updated_by_user_id = @updatedByUserId
     WHERE id = @id
  `).run({
    id,
    updatedAt: Date.now(),
    updatedByUserId: getCallerUserId(),
  });
  return get(id);
}

module.exports = { customFieldKeys,
  findAssetDirCollision,
  list,
  get,
  getBySku,
  create,
  update,
  remove,
  bulkRemove,
  duplicate,
  setProcessStatus,
  recomputeProcessStatus,
  bulkUpsert,
  touchUpdated,
};
