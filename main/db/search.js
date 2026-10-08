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
 * Match strategy: products, brands and categories use the shared word rule
 * below (0.1.94 — words ANDed, SKU separators ignored, exact barcode, NFC +
 * zero-width-safe); suppliers, POs and catalogs use a case-insensitive LIKE.
 * ponytail: this is sized for a few thousand products; switch to FTS5
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

/* ─── 0.1.94: one text-matching rule for the Library and ⌘K ──────────────
 *
 * Shared by `products.list` (the Library search box) and `globalSearch`, so
 * the two can never disagree about whether a product matches. Pure.
 *
 *   - The query is split on whitespace and EVERY word must match (AND), so
 *     "mace blue" finds "MACEPRO … Blue" in either order.
 *   - A word matches when it appears in the SKU, name or colour/finish, or
 *     when it appears in the SKU with separators ignored — "avm8101" finds
 *     "AV-M8101", "av m8101" too.
 *   - The barcode is matched EXACTLY (the whole query, separators ignored).
 *     A substring of a 13-digit barcode matched half the catalogue for any
 *     number typed, which is why barcodes were taken out in v0.49.37; an exact
 *     scan still finds its product, and ⌘K labels that hit "barcode".
 *   - Both sides are NFC-normalised and stripped of invisible characters
 *     (U+200B–U+200D, U+2060 word joiner, U+FEFF, U+00AD soft hyphen). Khmer
 *     text typed on one keyboard and stored from another can differ only in
 *     those, and LIKE treated them as different strings.
 *   - A query is capped at MAX_SEARCH_QUERY characters (a pasted paragraph
 *     must not become thousands of AND-ed words per row per keystroke).
 *
 * The phone viewer (webclient/index.html, `search:begin`) carries a copy of
 * this rule; test/searchParity.test.js runs both over the same samples.
 */
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const SEPARATORS_RE = /[\s\-_./\\:,\u00B7|+#]+/g;
const MAX_SEARCH_QUERY = 200;

/** The query as searched: trimmed, at most MAX_SEARCH_QUERY characters. */
function clampSearchQuery(query) {
  return String(query ?? '').trim().slice(0, MAX_SEARCH_QUERY);
}

/** A LIKE pattern matching `text` anywhere, with `%`, `_` and the escape
 *  character itself taken literally — use with `ESCAPE '\\'`. */
function likeContains(text) {
  return `%${String(text ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFC').replace(ZERO_WIDTH_RE, '').toLowerCase();
}

/** Lower-cased, normalised, every separator removed: "AV-M 8101" → "avm8101". */
function compactSearchKey(value) {
  return normalizeSearchText(value).replace(SEPARATORS_RE, '');
}

function searchTokens(query) {
  return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

/**
 * Prepare a query once for matching many rows. Returns null for a blank query.
 */
function compileProductSearch(query) {
  query = clampSearchQuery(query);
  const tokens = searchTokens(query);
  if (tokens.length === 0) return null;
  return {
    tokens: tokens.map((t) => ({ text: t, key: compactSearchKey(t) })),
    key: compactSearchKey(query),
  };
}

/**
 * Does this product match? `fields` = { sku, name, color, barcode }.
 * Returns null for no match, otherwise `{ rank, via }`:
 *   rank 0 — the SKU (separators ignored) or the barcode IS the query
 *   rank 1 — the SKU starts with the query
 *   rank 2 — everything else
 *   via    — 'barcode' when only the exact barcode matched, else 'text'
 */
function matchProductSearch(compiled, fields) {
  if (!compiled) return { rank: 2, via: 'text' };
  const skuKey = compactSearchKey(fields.sku);
  const barcodeKey = compactSearchKey(fields.barcode);
  const barcodeHit = !!barcodeKey && barcodeKey === compiled.key;
  const hay = `${normalizeSearchText(fields.sku)}\n${normalizeSearchText(fields.name)}\n${normalizeSearchText(fields.color)}`;
  const textHit = compiled.tokens.every((t) => hay.includes(t.text) || (t.key && skuKey.includes(t.key)));
  if (!textHit && !barcodeHit) return null;
  let rank = 2;
  if (compiled.key && (skuKey === compiled.key || barcodeHit)) rank = 0;
  else if (compiled.key && skuKey.startsWith(compiled.key)) rank = 1;
  return { rank, via: textHit ? 'text' : 'barcode' };
}

/** AND-of-words match against one plain name (brands, categories). */
function matchNameSearch(compiled, name) {
  if (!compiled) return true;
  const hay = normalizeSearchText(name);
  const key = compactSearchKey(name);
  return compiled.tokens.every((t) => hay.includes(t.text) || (t.key && key.includes(t.key)));
}

/**
 * v0.1.89: `opts.includeCosting` adds suppliers (name, contact) and purchase
 * orders (PO number). The caller decides it from the account's capabilities
 * (costing.view), because search:global itself is a baseline read that every
 * account may call — a photographer must not learn supplier names this way.
 * `opts.includeCatalog` similarly requires catalog.design for saved projects/templates.
 */
function globalSearch(companyId, query, limit = 30, opts = {}) {
  if (!companyId) return [];
  const q = clampSearchQuery(query);
  if (!q) return [];
  // Escaped: a typed `%` or `_` is a character to find, not a wildcard.
  // NFC + invisible characters removed, but NOT lower-cased: SQLite's LIKE
  // folds ASCII case only, so lower-casing "É" would stop it matching "É".
  const like = likeContains(q.normalize('NFC').replace(ZERO_WIDTH_RE, ''));
  const db = getDb();
  const compiled = compileProductSearch(q);

  const results = [];

  // Products: SKU, name, colour/finish (words ANDed, SKU separators ignored)
  // plus an exact barcode. 0.1.94: matched in JS with the Library's own rule
  // (matchProductSearch) and ranked — exact SKU / barcode first, then SKU
  // prefix, then the rest by most recently edited. A few thousand rows of four
  // short columns is well under a millisecond per keystroke's worth of work.
  const productRows = db
    .prepare(
      `SELECT id, sku, name, color_finish, barcode
         FROM products
        WHERE company_id = ?
        ORDER BY updated_at DESC`,
    )
    .all(companyId);
  const productHits = [];
  productRows.forEach((p, order) => {
    const hit = matchProductSearch(compiled, { sku: p.sku, name: p.name, color: p.color_finish, barcode: p.barcode });
    if (hit) productHits.push({ p, order, ...hit });
  });
  productHits.sort((a, b) => a.rank - b.rank || a.order - b.order);
  for (const { p, via } of productHits.slice(0, limit)) {
    results.push({
      kind: 'product',
      id: p.id,
      label: p.sku,
      sublabel: p.name || null,
      // Says why a row is here when it is not visible in the row itself.
      extra: via === 'barcode' ? 'barcode' : null,
      matchedBy: via,
      productId: p.id,
    });
  }

  // Brands.
  const brandRows = db
    .prepare('SELECT id, name FROM brands WHERE company_id = ? ORDER BY name COLLATE NOCASE')
    .all(companyId)
    .filter((b) => matchNameSearch(compiled, b.name))
    .slice(0, limit);
  for (const b of brandRows) {
    results.push({ kind: 'brand', id: b.id, label: b.name });
  }

  // Categories.
  const catRows = db
    .prepare('SELECT id, name FROM categories WHERE company_id = ? ORDER BY name COLLATE NOCASE')
    .all(companyId)
    .filter((c) => matchNameSearch(compiled, c.name))
    .slice(0, limit);
  for (const c of catRows) {
    results.push({ kind: 'category', id: c.id, label: c.name });
  }

  if (opts.includeCosting) {
    const supplierRows = db
      .prepare(
        `SELECT id, name, country FROM suppliers
          WHERE company_id = ?
            AND (name LIKE ? ESCAPE '\\' OR contact_name LIKE ? ESCAPE '\\')
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
          WHERE po.company_id = ? AND po.po_number LIKE ? ESCAPE '\\'
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
        WHERE company_id = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
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

module.exports = {
  globalSearch,
  // 0.1.94: the shared matching rule — also used by products.list.
  normalizeSearchText,
  compactSearchKey,
  compileProductSearch,
  clampSearchQuery,
  likeContains,
  MAX_SEARCH_QUERY,
  matchProductSearch,
  matchNameSearch,
};
