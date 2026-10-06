/**
 * Global search across products, brands, categories and permitted catalog/operations records
 * for the active company.
 *
 * Single ORs-and-LIKEs query against each table; results are
 * normalized into a flat `{ kind, id, label, sublabel, productId? }`
 * shape so the renderer's palette UI doesn't need to know about
 * table structure. Capped at 30 hits per query to keep the IPC
 * payload small and the rendered list fast — beyond that, the user
 * should refine their query.
 *
 * Match strategy: case-insensitive LIKE on every searched column.
 * ponytail: LIKE is sized for a few thousand products; switch to FTS5
 * only when measured search latency warrants it. For typical catalogs,
 * the substring match is fast enough and the UX matches
 * user mental models ("does the string appear anywhere in the SKU /
 * name?"). If catalogs grow huge we can switch to FTS5 later with
 * no API surface change.
 *
 * v0.49.37: NARROWED — scope reduced from 6 product fields (sku,
 * name, barcode, secondary_code, description, color_finish) to 3
 * (sku, name, color_finish), matching the Library page's search
 * input which narrowed in v0.26.49. Reasoning: beta-tester feedback
 * from a v0.49.21 user — barcodes appearing in results made matches
 * impossible to verify visually (a barcode hit looks the same as a
 * name hit in the dropdown — same SKU label, no indication of which
 * field matched). Tags + secondary_code never had a strong reason to
 * be in here either. If we need a deep-search-everywhere flow in the
 * future, that's its own command (e.g. "Find by barcode") with a
 * clearly different UI affordance — not a hidden expansion of the
 * default text search.
 */

const { getDb } = require('./index');

/**
 * v0.1.89: `opts.includeCosting` adds suppliers (name, contact) and purchase
 * orders (PO number). The caller decides it from the account's capabilities
 * (costing.view), because search:global itself is a baseline read that every
 * account may call — a photographer must not learn supplier names this way.
 * `opts.includeCatalog` similarly requires catalog.design for saved projects/templates.
 */
function globalSearch(companyId, query, limit = 30, opts = {}) {
  if (!companyId) return [];
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;
  const db = getDb();

  const results = [];

  // Products: SKU, name, color_finish. (v0.49.37: dropped barcode,
  // secondary_code, description.)
  const productRows = db
    .prepare(
      `SELECT id, sku, name
         FROM products
        WHERE company_id = ?
          AND (
            sku LIKE ? COLLATE NOCASE
            OR name LIKE ? COLLATE NOCASE
            OR color_finish LIKE ? COLLATE NOCASE
          )
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(companyId, like, like, like, limit);
  for (const p of productRows) {
    results.push({
      kind: 'product',
      id: p.id,
      label: p.sku,
      sublabel: p.name || null,
      // v0.49.37: `extra` used to surface a barcode / secondary_code
      // when the match was on one of those fields. Those fields aren't
      // searched anymore, so the dropdown stays clean.
      extra: null,
      productId: p.id,
    });
  }

  // Brands.
  const brandRows = db
    .prepare(
      `SELECT id, name FROM brands
        WHERE company_id = ? AND name LIKE ? COLLATE NOCASE
        ORDER BY name COLLATE NOCASE LIMIT ?`,
    )
    .all(companyId, like, limit);
  for (const b of brandRows) {
    results.push({ kind: 'brand', id: b.id, label: b.name });
  }

  // Categories.
  const catRows = db
    .prepare(
      `SELECT id, name FROM categories
        WHERE company_id = ? AND name LIKE ? COLLATE NOCASE
        ORDER BY name COLLATE NOCASE LIMIT ?`,
    )
    .all(companyId, like, limit);
  for (const c of catRows) {
    results.push({ kind: 'category', id: c.id, label: c.name });
  }

  if (opts.includeCosting) {
    const supplierRows = db
      .prepare(
        `SELECT id, name, country FROM suppliers
          WHERE company_id = ?
            AND (name LIKE ? COLLATE NOCASE OR contact_name LIKE ? COLLATE NOCASE)
          ORDER BY name COLLATE NOCASE LIMIT ?`,
      )
      .all(companyId, like, like, limit);
    for (const r of supplierRows) {
      results.push({ kind: 'supplier', id: r.id, label: r.name, sublabel: r.country || null, extra: 'Opens its orders' });
    }
    const poRows = db
      .prepare(
        `SELECT po.id, po.po_number, po.status, s.name AS supplier_name
           FROM purchase_orders po
           LEFT JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.company_id = ? AND po.po_number LIKE ? COLLATE NOCASE
          ORDER BY po.created_at DESC LIMIT ?`,
      )
      .all(companyId, like, limit);
    for (const r of poRows) {
      results.push({
        kind: 'po',
        id: r.id,
        label: r.po_number,
        sublabel: r.supplier_name || null,
        extra: r.status ? String(r.status).replace(/_/g, ' ') : null,
      });
    }
  }

  if (opts.includeCatalog) {
    // Only saved company templates are searchable; built-in layouts have no
    // persistent record ID and remain reachable on the Templates screen.
    for (const [table, kind] of [['catalog_projects', 'catalogProject'], ['catalog_templates', 'catalogTemplate']]) {
      const rows = db.prepare(`SELECT id, name, description FROM ${table}
        WHERE company_id = ? AND (name LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE)
        ORDER BY updated_at DESC LIMIT ?`).all(companyId, like, like, limit);
      for (const row of rows) results.push({ kind, id: row.id, label: row.name, sublabel: row.description || null });
    }
  }

  // Cap the merged list. Products are listed first by design — they're
  // the most-common target. v0.1.89: but a long product list no longer
  // pushes every other kind out — up to half the cap is kept for brand /
  // category / supplier / PO hits, and products fill the rest.
  const products = results.filter((r) => r.kind === 'product');
  const groups = new Map();
  for (const result of results.filter((r) => r.kind !== 'product')) {
    if (!groups.has(result.kind)) groups.set(result.kind, []);
    groups.get(result.kind).push(result);
  }
  // Share the non-product places across kinds, so many brand hits cannot
  // crowd every matching catalog or order out of the palette.
  const others = [];
  for (let index = 0; index < limit; index += 1) {
    for (const group of groups.values()) if (group[index]) others.push(group[index]);
  }
  const keepOthers = others.slice(0, Math.max(0, Math.min(others.length, limit - Math.min(products.length, Math.ceil(limit / 2)))));
  const keepProducts = products.slice(0, limit - keepOthers.length);
  return [...keepProducts, ...keepOthers];
}

module.exports = { globalSearch };
