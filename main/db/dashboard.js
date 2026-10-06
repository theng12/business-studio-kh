const { getDb } = require('./index');
const { rowHasAnyPrice } = require('../util/prices');

function statsFor(companyId) {
  if (!companyId) {
    return { products: 0, brands: 0, categories: 0, images: 0, processed: 0 };
  }
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM products   WHERE company_id = ?)                  AS products,
        (SELECT COUNT(*) FROM brands     WHERE company_id = ?)                  AS brands,
        (SELECT COUNT(*) FROM categories WHERE company_id = ?)                  AS categories,
        (SELECT COUNT(*) FROM product_images pi
           JOIN products p ON p.id = pi.product_id
           WHERE p.company_id = ?)                                              AS images,
        (SELECT COUNT(*) FROM product_images pi
           JOIN products p ON p.id = pi.product_id
           WHERE p.company_id = ? AND pi.is_processed = 1)                      AS processed
      `,
    )
    .get(companyId, companyId, companyId, companyId, companyId);
  return row;
}

function recentBrands(companyId, limit = 5) {
  if (!companyId) return [];
  return getDb()
    .prepare(
      `SELECT b.*,
         (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count
       FROM brands b
       WHERE b.company_id = ?
       ORDER BY b.created_at DESC
       LIMIT ?`,
    )
    .all(companyId, limit)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      icon: r.icon,
      // Cache-bust stamp for the icon (§12): replacing an icon rewrites the same path.
      updatedAt: r.updated_at,
      productCount: r.product_count ?? 0,
    }));
}

function recentProducts(companyId, limit = 8) {
  if (!companyId) return [];
  // LIMIT first: idx_products_company_updated hands back this company's most
  // recent rows in order, so only those `limit` products reach the
  // correlated lookups below (each an index probe on product_images). The
  // earlier grouped join counted every image of every company to show 8.
  return getDb()
    .prepare(
      `SELECT p.id, p.sku, p.name, p.updated_at,
         (SELECT COUNT(*) FROM product_images pi
            WHERE pi.product_id = p.id)                         AS image_count,
         (SELECT mi.filepath FROM product_images mi
            WHERE mi.product_id = p.id AND mi.order_index = 0
            LIMIT 1)                                            AS main_image_path
       FROM products p
       WHERE p.company_id = ?
       ORDER BY p.updated_at DESC
       LIMIT ?`,
    )
    .all(companyId, limit)
    .map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      updatedAt: r.updated_at,
      imageCount: r.image_count ?? 0,
      mainImagePath: r.main_image_path ?? null,
    }));
}

/**
 * v0.35.0: catalog-completeness counts for the Dashboard "needs attention"
 * panel. One pass over the company's products; "has no images" is an EXISTS
 * probe on the product_images(product_id) index, so only this company's
 * images are touched (a grouped subquery over product_images used to count
 * every company's images first).
 */
function completenessFor(companyId) {
  const empty = { total: 0, missingImages: 0, missingBarcode: 0, missingPrice: 0, notExported: 0 };
  if (!companyId) return empty;
  const row = getDb()
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id)
                 THEN 1 ELSE 0 END) AS missingImages,
        SUM(CASE WHEN p.barcode IS NULL OR TRIM(p.barcode) = '' THEN 1 ELSE 0 END) AS missingBarcode,
        SUM(CASE WHEN p.process_status IS NULL OR p.process_status <> 'exported' THEN 1 ELSE 0 END) AS notExported
      FROM products p
      WHERE p.company_id = ?
    `)
    .get(companyId);
  // Share the same price interpretation as the Library attention queue,
  // including legacy blank columns, zero amounts and named price groups.
  const missingPrice = getDb()
    .prepare(`
      SELECT price_retail, price_wholesale, prices FROM products
       WHERE company_id = ?
    `)
    .all(companyId)
    .filter((r) => !rowHasAnyPrice(r)).length;
  return {
    total: Number(row?.total ?? 0),
    missingImages: Number(row?.missingImages ?? 0),
    missingBarcode: Number(row?.missingBarcode ?? 0),
    missingPrice,
    notExported: Number(row?.notExported ?? 0),
  };
}

module.exports = { statsFor, recentBrands, recentProducts, completenessFor };
