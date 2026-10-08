/**
 * v0.49.47 — Purchase Orders DB module.
 *
 * Owns the purchase_orders header + po_lines + po_cost_components
 * tables AND the product_landed_costs derived cache.
 *
 * Key invariants:
 *   - Header `total_*` columns are CACHED. The DB layer re-runs the
 *     landed-cost calc on every mutation that could affect them
 *     (line add/remove/edit, component add/remove/edit). Callers
 *     don't need to remember to recalc.
 *   - A PO is a COST SOURCE when its status is 'received' or 'closed'
 *     (closing is the documented last step after receiving, so it must
 *     not take the PO's cost away) and it has a received_at date. A PO
 *     closed straight from draft never got a received date, so it is not
 *     one.
 *   - While a PO is a cost source, every change that can move its landed
 *     cost (lines, components, payments with in-landed fees, FX rate,
 *     currency, received date) refreshes the product_landed_costs cache
 *     for the products on it, in the same transaction.
 *   - Hard delete of a received/closed PO recomputes the affected
 *     products' caches (so a PO mistakenly received then deleted doesn't
 *     leave stale latest-cost values).
 *   - The 3- and 12-month averages are computed when READ, against today's
 *     date — a cached average would never age out a PO received long ago.
 */

const crypto = require('node:crypto');
const { getDb } = require('./index');
const landedCost = require('../util/landedCost');
const { prepareOptimisticPatch, nextUpdatedAt } = require('./_util');

/** Statuses whose PO counts toward product landed cost (with a received_at). */
const COST_SOURCE_STATUSES = ['received', 'closed'];
function isCostSource(status) { return COST_SOURCE_STATUSES.includes(status); }
const COST_SOURCE_SQL = `po.status IN ('received', 'closed') AND po.received_at IS NOT NULL`;

/** Run `fn` in one transaction (better-sqlite3 nests these as savepoints). */
function inTransaction(fn) { return getDb().transaction(fn)(); }

/* ─── row mappers ───────────────────────────────────────────────── */

function rowToPO(row) {
  if (!row) return null;
  return {
    id:                row.id,
    companyId:         row.company_id,
    supplierId:        row.supplier_id,
    poNumber:          row.po_number,
    incoterm:          row.incoterm,
    currency:          row.currency,
    exchangeRateToUsd: row.exchange_rate_to_usd,
    exchangeRateDate:  row.exchange_rate_date,
    status:            row.status,
    containerType:     row.container_type,
    orderedAt:         row.ordered_at,
    eta:               row.eta,
    receivedAt:        row.received_at,
    notes:             row.notes,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
    updatedByUserId:   row.updated_by_user_id,
    // v0.49.47 cached totals — written by recomputeHeader.
    totalValueSupplier:  row.total_value_supplier,
    totalValueUsd:       row.total_value_usd,
    totalVolumeCbm:      row.total_volume_cbm,
    totalWeightKg:       row.total_weight_kg,
    totalComponentsUsd:  row.total_components_usd,
    linesCount:          row.lines_count,
    // v0.49.50 cached payment rollup — written by recomputePayments.
    totalPaidSupplier:   row.total_paid_supplier,
    totalPaidUsd:        row.total_paid_usd,
    totalTtFeesUsd:      row.total_tt_fees_usd,
    paymentStatus:       row.payment_status,
  };
}

function rowToLine(row) {
  if (!row) return null;
  return {
    id:                       row.id,
    poId:                     row.po_id,
    productId:                row.product_id,
    supplierSku:              row.supplier_sku,
    qty:                      row.qty,
    unitPriceSupplierCurrency: row.unit_price_supplier_currency,
    unitPriceUsdAtPo:         row.unit_price_usd_at_po,
    allocatedCostUsdPerUnit:  row.allocated_cost_usd_per_unit,
    landedUnitCostUsd:        row.landed_unit_cost_usd,
    cartonQty:                row.carton_qty,
    cartonWCm:                row.carton_w_cm,
    cartonHCm:                row.carton_h_cm,
    cartonDCm:                row.carton_d_cm,
    weightPerUnitKg:          row.weight_per_unit_kg,
    notes:                    row.notes,
  };
}

function rowToComponent(row) {
  if (!row) return null;
  return {
    id:                       row.id,
    poId:                     row.po_id,
    kind:                     row.kind,
    label:                    row.label,
    amountSupplierCurrency:   row.amount_supplier_currency,
    amountUsd:                row.amount_usd,
    allocationBasis:          row.allocation_basis,
    notes:                    row.notes,
  };
}

function rowToPayment(row) {
  if (!row) return null;
  return {
    id:                      row.id,
    poId:                    row.po_id,
    kind:                    row.kind,
    amountSupplierCurrency:  row.amount_supplier_currency,
    fxRateToUsd:             row.fx_rate_to_usd,
    amountUsd:               row.amount_usd,
    ttFeeUsd:                row.tt_fee_usd,
    ttFeeInLanded:           !!row.tt_fee_in_landed,
    status:                  row.status,
    reference:               row.reference,
    paidAt:                  row.paid_at,
    notes:                   row.notes,
    createdAt:               row.created_at,
    updatedAt:               row.updated_at,
  };
}

/* ─── PO header CRUD ────────────────────────────────────────────── */

const VALID_INCOTERMS  = new Set(['EXW', 'FOB', 'CFR', 'CIF']);
const VALID_STATUS     = ['draft', 'ordered', 'in_transit', 'received', 'closed'];
const VALID_CONTAINERS = new Set(['20', '40', '40HQ', 'LCL']);

function normalizeIncoterm(v) {
  if (!v) return 'FOB'; // sane default — most overseas suppliers quote FOB
  const s = String(v).trim().toUpperCase().replace('CNF', 'CFR');
  return VALID_INCOTERMS.has(s) ? s : 'FOB';
}

/**
 * List POs for a company. Filters: search (PO number), supplierId, status.
 * Returns header rows only (no lines / components) — call getDetail() for
 * the full picture.
 */
function list(companyId, filters = {}) {
  filters = filters || {};
  if (!companyId) return [];
  let sql = `
    SELECT po.*, s.name AS supplier_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.company_id = ?
  `;
  const params = [companyId];
  if (filters.supplierId) {
    sql += ` AND po.supplier_id = ?`;
    params.push(filters.supplierId);
  }
  if (filters.status === 'open') {
    // The Dashboard's "open purchase orders" chip: not yet received.
    sql += ` AND po.status IN ('draft', 'ordered', 'in_transit')`;
  } else if (filters.status === 'owed') {
    // The Dashboard's "owed to suppliers" chip: committed (not a draft) and
    // not fully paid — the same rows its total adds up.
    sql += ` AND po.status <> 'draft'
             AND COALESCE(po.total_value_supplier, 0) - COALESCE(po.total_paid_supplier, 0) > 0.005`;
  } else if (filters.status && filters.status !== 'all') {
    sql += ` AND po.status = ?`;
    params.push(filters.status);
  }
  if (filters.search) {
    const escaped = String(filters.search).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const term = `%${escaped}%`;
    // PO number, supplier, or anything on its lines: our SKU, the product
    // name, or the supplier's own SKU — "which PO had SKU 2213?".
    sql += ` AND (po.po_number LIKE ? ESCAPE '\\' COLLATE NOCASE OR s.name LIKE ? ESCAPE '\\' COLLATE NOCASE
              OR EXISTS (SELECT 1 FROM po_lines l LEFT JOIN products p ON p.id = l.product_id
                          WHERE l.po_id = po.id
                            AND (p.sku LIKE ? ESCAPE '\\' COLLATE NOCASE
                                 OR p.name LIKE ? ESCAPE '\\' COLLATE NOCASE
                                 OR l.supplier_sku LIKE ? ESCAPE '\\' COLLATE NOCASE)))`;
    params.push(term, term, term, term, term);
  }
  sql += ` ORDER BY COALESCE(po.received_at, po.ordered_at, po.created_at) DESC`;
  const rows = getDb().prepare(sql).all(...params);
  return rows.map((r) => ({ ...rowToPO(r), supplierName: r.supplier_name }));
}

function get(id) {
  if (!id) return null;
  return rowToPO(getDb().prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(id));
}

/**
 * Get a PO with its lines + components + supplier info, ready for the
 * detail page. Also runs the landed-cost calc and embeds per-line
 * computed values so the renderer doesn't need to.
 */
function getDetail(id) {
  const db = getDb();
  const headerRow = db
    .prepare(`SELECT po.*, s.name AS supplier_name, s.country AS supplier_country
               FROM purchase_orders po
               LEFT JOIN suppliers s ON s.id = po.supplier_id
              WHERE po.id = ?`)
    .get(id);
  if (!headerRow) return null;
  const header = { ...rowToPO(headerRow), supplierName: headerRow.supplier_name, supplierCountry: headerRow.supplier_country };
  const lines = db.prepare(`
    SELECT l.*, p.sku AS product_sku, p.name AS product_name
      FROM po_lines l
      LEFT JOIN products p ON p.id = l.product_id
     WHERE l.po_id = ?
     ORDER BY l.rowid ASC
  `).all(id).map((r) => ({ ...rowToLine(r), productSku: r.product_sku, productName: r.product_name }));
  const components = db.prepare(`SELECT * FROM po_cost_components WHERE po_id = ? ORDER BY rowid ASC`)
    .all(id).map(rowToComponent);
  const payments = db.prepare(`SELECT * FROM po_payments WHERE po_id = ? ORDER BY COALESCE(paid_at, created_at) ASC`)
    .all(id).map(rowToPayment);

  // Run the calculator so the UI gets per-line landed cost without
  // round-tripping. We use the values that landed in the cache the
  // last time recomputeHeader fired, but ALSO run the calc fresh
  // here so a stale cache (concurrent edit, etc.) is overlaid by the
  // live answer. The cache is what we display in lists; the live
  // answer is what we show on the detail page.
  const calcComponents = components.map((c) => ({
    id: c.id, kind: c.kind, amountUsd: c.amountUsd, allocationBasis: c.allocationBasis,
  }));
  // v0.49.50: fold in-landed TT fees (paid/confirmed) into the live calc
  // so the detail page's per-line landed cost matches the cache.
  const ttFeeInLanded = payments
    .filter((p) => p.ttFeeInLanded && (p.status === 'paid' || p.status === 'confirmed'))
    .reduce((s, p) => s + (Number(p.ttFeeUsd) || 0), 0);
  if (ttFeeInLanded > 0) {
    calcComponents.push({ id: '__ttfee__', kind: 'tt_fee', amountUsd: ttFeeInLanded, allocationBasis: 'by_value' });
  }

  const calc = landedCost.calculateLanded({
    lines: lines.map((l) => ({
      id: l.id,
      qty: l.qty,
      unitPriceUsd: l.unitPriceUsdAtPo,
      cartonQty: l.cartonQty,
      cartonWCm: l.cartonWCm,
      cartonHCm: l.cartonHCm,
      cartonDCm: l.cartonDCm,
      weightPerUnitKg: l.weightPerUnitKg,
    })),
    components: calcComponents,
  });
  const calcByLine = new Map(calc.perLine.map((c) => [c.lineId, c]));
  const linesWithCalc = lines.map((l) => ({
    ...l,
    calc: calcByLine.get(l.id) || null,
  }));

  const fillPct = landedCost.containerFillPct(header.containerType, calc.header.totalVolumeCbm);

  // v0.49.49: layer Incoterm-aware notices on top of the allocation-fallback
  // warnings — e.g. a 'freight' cost on a CIF PO is likely double-counted.
  const incotermWarnings = landedCost.incotermComponentWarnings(header.incoterm, components);
  const warnings = [...calc.warnings, ...incotermWarnings];

  // v0.49.50: payment rollup against the supplier goods value.
  const paymentSummary = landedCost.summarizePayments({
    owedSupplier: header.totalValueSupplier || 0,
    payments,
  });

  return { header, lines: linesWithCalc, components, payments, calc: calc.header, warnings, fillPct, paymentSummary };
}

function create(input, userId = null) {
  if (!input?.companyId)  throw new Error('companyId is required');
  if (!input?.supplierId) throw new Error('supplierId is required');

  const supplier = getDb().prepare(`SELECT * FROM suppliers WHERE id = ?`).get(input.supplierId);
  if (!supplier) throw new Error('Supplier not found');
  if (supplier.company_id !== input.companyId) throw new Error('Supplier does not belong to active company');

  const now = Date.now();
  const id = `po_${crypto.randomBytes(6).toString('hex')}`;
  const incoterm = normalizeIncoterm(input.incoterm || supplier.default_incoterm);
  const currency = (input.currency || supplier.default_currency || 'USD').toUpperCase();
  const exchangeRateToUsd = Number(input.exchangeRateToUsd) || (currency === 'USD' ? 1 : 0);

  getDb().prepare(`
    INSERT INTO purchase_orders (
      id, company_id, supplier_id, po_number, incoterm, currency,
      exchange_rate_to_usd, exchange_rate_date, status, container_type,
      ordered_at, eta, received_at, notes,
      total_value_supplier, total_value_usd, total_volume_cbm, total_weight_kg,
      total_components_usd, lines_count,
      created_at, updated_at, updated_by_user_id
    ) VALUES (
      @id, @companyId, @supplierId, @poNumber, @incoterm, @currency,
      @exchangeRateToUsd, @exchangeRateDate, @status, @containerType,
      @orderedAt, @eta, @receivedAt, @notes,
      0, 0, 0, 0, 0, 0,
      @createdAt, @updatedAt, @updatedByUserId
    )
  `).run({
    id,
    companyId: input.companyId,
    supplierId: input.supplierId,
    poNumber: input.poNumber || null,
    incoterm,
    currency,
    exchangeRateToUsd,
    exchangeRateDate: input.exchangeRateDate || now,
    status: VALID_STATUS.includes(input.status) ? input.status : 'draft',
    containerType: VALID_CONTAINERS.has(input.containerType) ? input.containerType : null,
    orderedAt:  input.orderedAt  || null,
    eta:        input.eta        || null,
    receivedAt: input.receivedAt || null,
    notes:      input.notes      || null,
    createdAt: now,
    updatedAt: now,
    updatedByUserId: userId,
  });

  return get(id);
}

const HEADER_PATCH = [
  ['poNumber',          'po_number'],
  ['incoterm',          'incoterm',         normalizeIncoterm],
  ['currency',          'currency',         (v) => String(v || 'USD').toUpperCase()],
  ['exchangeRateToUsd', 'exchange_rate_to_usd', (v) => Number(v) || 0],
  ['exchangeRateDate',  'exchange_rate_date'],
  ['containerType',     'container_type',   (v) => (VALID_CONTAINERS.has(v) ? v : null)],
  ['orderedAt',         'ordered_at'],
  ['eta',               'eta'],
  ['notes',             'notes',            (v) => v?.trim() || null],
  ['receivedAt',        'received_at',      Number],
];

/**
 * Re-convert every line's and cost component's USD amount from the amount
 * in the supplier's currency at `rate`. Called when the PO's FX rate or
 * currency changes — the USD figures are snapshots taken at that rate, so
 * without this a corrected rate changed nothing until each line was edited.
 * A rate of 0 means "not known yet"; converting at it would zero every USD
 * figure, so it is skipped.
 */
function reconvertAmounts(poId, rate) {
  if (!(rate > 0)) return;
  const db = getDb();
  db.prepare(`UPDATE po_lines SET unit_price_usd_at_po = unit_price_supplier_currency * ? WHERE po_id = ?`).run(rate, poId);
  db.prepare(`UPDATE po_cost_components SET amount_usd = amount_supplier_currency * ? WHERE po_id = ?`).run(rate, poId);
}

function update(id, patch, userId = null) {
  const existing = get(id);
  if (!existing) throw new Error('PO not found');
  const input = prepareOptimisticPatch(existing, patch, 'purchaseOrder');

  if ('receivedAt' in input) {
    if (!isCostSource(existing.status)) {
      throw new Error('The received date can only be set on a received or closed purchase order.');
    }
    const ts = Number(input.receivedAt);
    if (input.receivedAt == null || input.receivedAt === '' || !Number.isFinite(ts) || ts <= 0) {
      throw new Error('Received date must be a valid date.');
    }
  }
  // Switching a PO to USD without naming a rate: USD converts 1:1.
  // Switching to any OTHER currency must name its rate: keeping the old one
  // (often USD's 1) would silently re-convert every line at the wrong rate —
  // a misclicked USD → CNY round trip used to leave a received PO at rate 1
  // and its products' landed cost ~7x too high, with the real rate lost.
  if ('currency' in input && !('exchangeRateToUsd' in input)) {
    const next = String(input.currency || 'USD').toUpperCase();
    if (next === 'USD') {
      input.exchangeRateToUsd = 1;
    } else if (next !== String(existing.currency || 'USD').toUpperCase()) {
      throw new Error(`Enter the exchange rate for ${next} (how many US dollars one ${next} is worth) when changing the currency.`);
    }
  }

  const sets = [];
  const params = { id, updatedAt: nextUpdatedAt(existing.updatedAt), updatedByUserId: userId };
  for (const [key, col, fn] of HEADER_PATCH) {
    if (key in input) {
      sets.push(`${col} = @${key}`);
      params[key] = fn ? fn(input[key]) : input[key];
    }
  }
  if (sets.length === 0) return existing;
  sets.push(`updated_at = @updatedAt`);
  sets.push(`updated_by_user_id = @updatedByUserId`);

  const rateChanged = 'exchangeRateToUsd' in params
    && params.exchangeRateToUsd !== (Number(existing.exchangeRateToUsd) || 0);
  const currencyChanged = 'currency' in params && params.currency !== existing.currency;
  const receivedChanged = 'receivedAt' in params && params.receivedAt !== existing.receivedAt;

  inTransaction(() => {
    getDb().prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = @id`).run(params);
    if (rateChanged || currencyChanged) {
      const rate = 'exchangeRateToUsd' in params ? params.exchangeRateToUsd : Number(existing.exchangeRateToUsd) || 0;
      reconvertAmounts(id, rate);
      recomputeHeader(id); // also refreshes product costs when the PO is a cost source
    } else if (receivedChanged) {
      refreshProductCostsForPO(id);
    }
  });
  return get(id);
}

/**
 * Status transitions. The interesting ones move a PO in or out of being a
 * cost source ('received' / 'closed' with a received date): those refresh
 * the product_landed_costs cache for every product on the PO.
 *
 * Allowed transitions (relaxed — we trust the user):
 *   draft       → ordered, closed
 *   ordered     → in_transit, received, closed
 *   in_transit  → received, closed
 *   received    → closed (keeps its cost), ordered (re-open with warning)
 *   closed      → received, ordered (re-open)
 *
 * received_at is stamped the first time a PO is received and kept through
 * 'closed'; it is cleared only when the PO goes back to draft / ordered /
 * in transit. Closing used to clear it too, which silently removed a
 * received PO's landed cost from every product on it.
 *
 * The UI layer warns before destructive transitions; the DB layer
 * accepts whatever the UI tells it.
 */
function setStatus(id, newStatus, userId = null, expectedUpdatedAt) {
  const existing = get(id);
  if (!existing) throw new Error('PO not found');
  prepareOptimisticPatch(existing, expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }, 'purchaseOrder');
  if (!VALID_STATUS.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);

  const now = nextUpdatedAt(existing.updatedAt);
  const db = getDb();
  inTransaction(() => {
    const wasSource = isCostSource(existing.status) && existing.receivedAt != null;

    const sets = [`status = ?`, `updated_at = ?`, `updated_by_user_id = ?`];
    const params = [newStatus, now, userId];
    if (newStatus === 'received' && existing.receivedAt == null) {
      sets.push(`received_at = ?`);
      params.push(now);
    } else if (!isCostSource(newStatus) && existing.receivedAt != null) {
      sets.push(`received_at = NULL`);
    }
    db.prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);

    // Recompute (so the line landed_unit_cost_usd snapshots are current);
    // when the PO is now a cost source this also refreshes the products.
    recomputeHeader(id);

    // Leaving cost-source status: recomputeHeader no longer refreshes, so
    // drop this PO's contribution from every product it touched here.
    if (wasSource && !isCostSource(newStatus)) refreshProductCostsForPO(id);
  });
  return get(id);
}

function remove(id) {
  const existing = get(id);
  if (!existing) return { deleted: 0 };
  const wasReceived = isCostSource(existing.status);
  const db = getDb();
  const tx = db.transaction(() => {
    // Capture affected products BEFORE delete so we can refresh after.
    const productIds = db.prepare(`SELECT DISTINCT product_id FROM po_lines WHERE po_id = ?`).all(id).map((r) => r.product_id);
    db.prepare(`DELETE FROM purchase_orders WHERE id = ?`).run(id);
    if (wasReceived) {
      for (const pid of productIds) recomputeProductCost(pid);
    }
  });
  tx();
  return { deleted: 1 };
}

/* ─── lines + components ────────────────────────────────────────── */

function addLine(poId, input, userId = null) {
  const po = get(poId);
  if (!po) throw new Error('PO not found');
  if (!input?.productId) throw new Error('productId is required');
  if (input.qty == null) throw new Error('qty is required');

  const db = getDb();
  const product = db.prepare(`SELECT * FROM products WHERE id = ?`).get(input.productId);
  if (!product) throw new Error('Product not found');
  if (product.company_id !== po.companyId) {
    throw new Error('Product does not belong to purchase order company');
  }

  const unitPriceSupplier = Number(input.unitPriceSupplierCurrency) || 0;
  const unitPriceUsd      = (unitPriceSupplier * (Number(po.exchangeRateToUsd) || 0)) || Number(input.unitPriceUsdAtPo) || 0;

  const id = `pol_${crypto.randomBytes(6).toString('hex')}`;
  inTransaction(() => {
    db.prepare(`
      INSERT INTO po_lines (
        id, po_id, product_id, supplier_sku, qty,
        unit_price_supplier_currency, unit_price_usd_at_po,
        carton_qty, carton_w_cm, carton_h_cm, carton_d_cm, weight_per_unit_kg,
        notes
      ) VALUES (
        @id, @poId, @productId, @supplierSku, @qty,
        @unitPriceSupplierCurrency, @unitPriceUsdAtPo,
        @cartonQty, @cartonWCm, @cartonHCm, @cartonDCm, @weightPerUnitKg,
        @notes
      )
    `).run({
      id, poId,
      productId: input.productId,
      supplierSku: input.supplierSku ?? product.supplier_sku ?? null,
      qty: Number(input.qty) || 0,
      unitPriceSupplierCurrency: unitPriceSupplier,
      unitPriceUsdAtPo: unitPriceUsd,
      cartonQty: Number(input.cartonQty ?? product.carton_qty)         || null,
      cartonWCm: Number(input.cartonWCm ?? product.carton_w_cm)        || null,
      cartonHCm: Number(input.cartonHCm ?? product.carton_h_cm)        || null,
      cartonDCm: Number(input.cartonDCm ?? product.carton_d_cm)        || null,
      weightPerUnitKg: Number(input.weightPerUnitKg ?? product.weight_per_unit_kg) || null,
      notes: input.notes || null,
    });
    recomputeHeader(poId, userId);
  });
  return getDetail(poId);
}

const LINE_PATCH = [
  ['qty',                       'qty',                          Number],
  ['unitPriceSupplierCurrency', 'unit_price_supplier_currency', Number],
  ['supplierSku',               'supplier_sku'],
  ['cartonQty',                 'carton_qty',                   (v) => Number(v) || null],
  ['cartonWCm',                 'carton_w_cm',                  (v) => Number(v) || null],
  ['cartonHCm',                 'carton_h_cm',                  (v) => Number(v) || null],
  ['cartonDCm',                 'carton_d_cm',                  (v) => Number(v) || null],
  ['weightPerUnitKg',           'weight_per_unit_kg',           (v) => Number(v) || null],
  ['notes',                     'notes',                        (v) => v?.trim() || null],
];

function updateLine(lineId, patch, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM po_lines WHERE id = ?`).get(lineId);
  if (!row) throw new Error('Line not found');
  const po = get(row.po_id);
  patch = prepareOptimisticPatch(po, patch, 'purchaseOrder');

  const sets = [];
  const params = { id: lineId };
  for (const [key, col, fn] of LINE_PATCH) {
    if (key in (patch ?? {})) {
      sets.push(`${col} = @${key}`);
      params[key] = fn ? fn(patch[key]) : patch[key];
    }
  }
  if (sets.length === 0) return getDetail(po.id);

  // If the supplier price changed, re-snapshot the USD-at-PO value too.
  if ('unitPriceSupplierCurrency' in (patch ?? {})) {
    const newSupplier = Number(patch.unitPriceSupplierCurrency) || 0;
    const newUsd = newSupplier * (Number(po.exchangeRateToUsd) || 0);
    sets.push(`unit_price_usd_at_po = @newUsd`);
    params.newUsd = newUsd;
  }

  inTransaction(() => {
    db.prepare(`UPDATE po_lines SET ${sets.join(', ')} WHERE id = @id`).run(params);
    recomputeHeader(po.id, userId);
  });
  return getDetail(po.id);
}

function removeLine(lineId, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT po_id, product_id FROM po_lines WHERE id = ?`).get(lineId);
  if (!row) return null;
  inTransaction(() => {
    db.prepare(`DELETE FROM po_lines WHERE id = ?`).run(lineId);
    recomputeHeader(row.po_id, userId);
    // The removed line's product is no longer on this PO, so the refresh in
    // recomputeHeader cannot reach it — recompute it by hand.
    const po = get(row.po_id);
    if (po && isCostSource(po.status)) recomputeProductCost(row.product_id);
  });
  return getDetail(row.po_id);
}

function addComponent(poId, input, userId = null) {
  const po = get(poId);
  if (!po) throw new Error('PO not found');
  // A discount is stored negative (the form takes a positive number); every
  // other kind is stored as a positive amount. See landedCost.componentUsd.
  const kind = input.kind || 'other';
  const amountSupplier = landedCost.signedComponentAmount(kind, input.amountSupplierCurrency);
  const amountUsd      = amountSupplier * (Number(po.exchangeRateToUsd) || 0)
                        || landedCost.signedComponentAmount(kind, input.amountUsd);

  const id = `pcc_${crypto.randomBytes(6).toString('hex')}`;
  inTransaction(() => {
    getDb().prepare(`
      INSERT INTO po_cost_components (
        id, po_id, kind, label,
        amount_supplier_currency, amount_usd, allocation_basis, notes
      ) VALUES (
        @id, @poId, @kind, @label,
        @amountSupplierCurrency, @amountUsd, @allocationBasis, @notes
      )
    `).run({
      id, poId,
      kind,
      label: input.label || null,
      amountSupplierCurrency: amountSupplier,
      amountUsd,
      allocationBasis: input.allocationBasis || 'by_value',
      notes: input.notes || null,
    });
    recomputeHeader(poId, userId);
  });
  return getDetail(poId);
}

const COMP_PATCH = [
  ['kind',                    'kind'],
  ['label',                   'label',                    (v) => v?.trim() || null],
  ['allocationBasis',         'allocation_basis'],
  ['notes',                   'notes',                    (v) => v?.trim() || null],
];

function updateComponent(componentId, patch, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM po_cost_components WHERE id = ?`).get(componentId);
  if (!row) throw new Error('Component not found');
  const po = get(row.po_id);
  const input = prepareOptimisticPatch(po, patch, 'purchaseOrder');

  const sets = [];
  const params = { id: componentId };
  for (const [key, col, fn] of COMP_PATCH) {
    if (key in input) {
      sets.push(`${col} = @${key}`);
      params[key] = fn ? fn(input[key]) : input[key];
    }
  }

  // Amounts: re-sign whenever the kind or the amount changes, so turning a
  // freight line into a discount (or back) flips its sign with it.
  if ('amountSupplierCurrency' in input || 'kind' in input) {
    const kind = 'kind' in input ? params.kind : row.kind;
    const amountChanged = 'amountSupplierCurrency' in input;
    const supplier = landedCost.signedComponentAmount(
      kind, amountChanged ? input.amountSupplierCurrency : row.amount_supplier_currency,
    );
    sets.push('amount_supplier_currency = @newSupplier', 'amount_usd = @newUsd');
    params.newSupplier = supplier;
    params.newUsd = amountChanged
      ? supplier * (Number(po.exchangeRateToUsd) || 0)
      : landedCost.signedComponentAmount(kind, row.amount_usd);
  }
  if (sets.length === 0) return getDetail(po.id);

  inTransaction(() => {
    db.prepare(`UPDATE po_cost_components SET ${sets.join(', ')} WHERE id = @id`).run(params);
    recomputeHeader(po.id, userId);
  });
  return getDetail(po.id);
}

function removeComponent(componentId, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT po_id FROM po_cost_components WHERE id = ?`).get(componentId);
  if (!row) return null;
  inTransaction(() => {
    db.prepare(`DELETE FROM po_cost_components WHERE id = ?`).run(componentId);
    recomputeHeader(row.po_id, userId);
  });
  return getDetail(row.po_id);
}

/* ─── payments (TT ledger) ──────────────────────────────────────── */

const VALID_PAYMENT_KINDS  = new Set(['deposit', 'balance', 'partial', 'final', 'other']);
const VALID_PAYMENT_STATUS = new Set(['planned', 'paid', 'confirmed']);

function addPayment(poId, input, userId = null) {
  const po = get(poId);
  if (!po) throw new Error('PO not found');
  const db = getDb();
  const now = Date.now();

  const amountSupplier = Number(input.amountSupplierCurrency) || 0;
  // Per-payment FX rate. Defaults to the PO's locked rate; the user can
  // override per TT (deposit + balance often settle at different rates).
  const fxRate = Number(input.fxRateToUsd) || Number(po.exchangeRateToUsd) || (po.currency === 'USD' ? 1 : 0);
  const amountUsd = input.amountUsd != null && input.amountUsd !== ''
    ? Number(input.amountUsd)
    : amountSupplier * fxRate;

  const id = `pay_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(`
    INSERT INTO po_payments (
      id, po_id, kind, amount_supplier_currency, fx_rate_to_usd, amount_usd,
      tt_fee_usd, tt_fee_in_landed, status, reference, paid_at, notes,
      created_at, updated_at
    ) VALUES (
      @id, @poId, @kind, @amountSupplier, @fxRate, @amountUsd,
      @ttFeeUsd, @ttFeeInLanded, @status, @reference, @paidAt, @notes,
      @createdAt, @updatedAt
    )
  `).run({
    id, poId,
    kind: VALID_PAYMENT_KINDS.has(input.kind) ? input.kind : 'deposit',
    amountSupplier,
    fxRate,
    amountUsd,
    ttFeeUsd: Number(input.ttFeeUsd) || 0,
    ttFeeInLanded: input.ttFeeInLanded ? 1 : 0,
    status: VALID_PAYMENT_STATUS.has(input.status) ? input.status : 'paid',
    reference: input.reference?.trim() || null,
    paidAt: input.paidAt || now,
    notes: input.notes?.trim() || null,
    createdAt: now,
    updatedAt: now,
  });

  recomputePayments(poId, userId);
  return getDetail(poId);
}

const PAYMENT_PATCH = [
  ['kind',                   'kind',                     (v) => (VALID_PAYMENT_KINDS.has(v) ? v : 'other')],
  ['amountSupplierCurrency', 'amount_supplier_currency', Number],
  ['fxRateToUsd',            'fx_rate_to_usd',           Number],
  ['ttFeeUsd',               'tt_fee_usd',               (v) => Number(v) || 0],
  ['ttFeeInLanded',          'tt_fee_in_landed',         (v) => (v ? 1 : 0)],
  ['status',                 'status',                   (v) => (VALID_PAYMENT_STATUS.has(v) ? v : 'paid')],
  ['reference',              'reference',                (v) => v?.trim() || null],
  ['paidAt',                 'paid_at'],
  ['notes',                  'notes',                    (v) => v?.trim() || null],
];

function updatePayment(paymentId, patch, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM po_payments WHERE id = ?`).get(paymentId);
  if (!row) throw new Error('Payment not found');
  patch = prepareOptimisticPatch(get(row.po_id), patch, 'purchaseOrder');

  const sets = [];
  const params = { id: paymentId, updatedAt: nextUpdatedAt(row.updated_at) };
  for (const [key, col, fn] of PAYMENT_PATCH) {
    if (key in (patch ?? {})) {
      sets.push(`${col} = @${key}`);
      params[key] = fn ? fn(patch[key]) : patch[key];
    }
  }
  // Re-derive amount_usd whenever the supplier amount or FX rate changed
  // (unless an explicit amountUsd was supplied).
  if ('amountUsd' in (patch ?? {}) && patch.amountUsd !== '' && patch.amountUsd != null) {
    sets.push(`amount_usd = @amountUsd`);
    params.amountUsd = Number(patch.amountUsd);
  } else if ('amountSupplierCurrency' in (patch ?? {}) || 'fxRateToUsd' in (patch ?? {})) {
    const newAmount = 'amountSupplierCurrency' in patch ? Number(patch.amountSupplierCurrency) : row.amount_supplier_currency;
    const newFx     = 'fxRateToUsd' in patch ? Number(patch.fxRateToUsd) : row.fx_rate_to_usd;
    sets.push(`amount_usd = @amountUsd`);
    params.amountUsd = (Number(newAmount) || 0) * (Number(newFx) || 0);
  }
  if (sets.length === 0) return getDetail(row.po_id);
  sets.push(`updated_at = @updatedAt`);
  db.prepare(`UPDATE po_payments SET ${sets.join(', ')} WHERE id = @id`).run(params);
  recomputePayments(row.po_id, userId);
  return getDetail(row.po_id);
}

function removePayment(paymentId, userId = null) {
  const db = getDb();
  const row = db.prepare(`SELECT po_id FROM po_payments WHERE id = ?`).get(paymentId);
  if (!row) return null;
  db.prepare(`DELETE FROM po_payments WHERE id = ?`).run(paymentId);
  recomputePayments(row.po_id, userId);
  return getDetail(row.po_id);
}

function listPayments(poId) {
  if (!poId) return [];
  return getDb().prepare(`SELECT * FROM po_payments WHERE po_id = ? ORDER BY COALESCE(paid_at, created_at) ASC`)
    .all(poId).map(rowToPayment);
}

/**
 * After a payment mutation: re-run the landed cost (an in-landed TT fee
 * may have changed per-unit cost) — recomputeHeader also refreshes the
 * payment cache at its tail and, when the PO is received/closed, the
 * affected products' cost cache so the snapshot tracks.
 *
 * NOTE: the payment-cache WRITE itself lives in recomputePaymentCache()
 * and is called from the tail of recomputeHeader() — that one-way edge
 * (header → payment cache, never the reverse) is what keeps these two
 * from recursing into each other.
 */
function recomputePayments(poId, _userId = null) {
  if (!get(poId)) return;
  inTransaction(() => recomputeHeader(poId));
}

/**
 * Write ONLY the cached payment rollup columns on the header. Reads the
 * already-current total_value_supplier (the amount owed the supplier) +
 * the payment rows. Does not touch landed cost and never calls
 * recomputeHeader — so it's safe to call from recomputeHeader's tail.
 */
function recomputePaymentCache(poId) {
  const db = getDb();
  const owedRow = db.prepare(`SELECT total_value_supplier FROM purchase_orders WHERE id = ?`).get(poId);
  if (!owedRow) return;
  const payments = listPayments(poId);
  const summary = landedCost.summarizePayments({
    owedSupplier: owedRow.total_value_supplier || 0,
    payments,
  });
  db.prepare(`
    UPDATE purchase_orders
       SET total_paid_supplier = ?, total_paid_usd = ?,
           total_tt_fees_usd = ?, payment_status = ?
     WHERE id = ?
  `).run(summary.paidSupplier, summary.paidUsd, summary.ttFeesUsd, summary.status, poId);
}

/* ─── recompute + product cost cache ────────────────────────────── */

/**
 * Re-run the landed cost calc for one PO + write per-line cache cols +
 * write header totals. Called on every line/component/payment mutation so
 * the cached numbers stay in sync. When the PO is a cost source (received
 * or closed) it also refreshes product_landed_costs for its products, so an
 * edit after receiving reaches the products. It does NOT re-convert USD
 * amounts — update() does that (reconvertAmounts) when the FX rate or
 * currency changes.
 */
function recomputeHeader(poId, _userId = null) {
  const db = getDb();
  const po = rowToPO(db.prepare(`SELECT * FROM purchase_orders WHERE id = ?`).get(poId));
  if (!po) return;

  const lines = db.prepare(`SELECT * FROM po_lines WHERE po_id = ?`).all(poId).map(rowToLine);
  const components = db.prepare(`SELECT * FROM po_cost_components WHERE po_id = ?`).all(poId).map(rowToComponent);

  // v0.49.50: TT/bank fees the user flagged "include in landed cost"
  // (and that are actually paid) become a synthetic cost component
  // allocated by value, so each unit's landed cost reflects them.
  const calcComponents = components.map((c) => ({
    id: c.id, kind: c.kind, amountUsd: c.amountUsd, allocationBasis: c.allocationBasis,
  }));
  const ttFeeInLanded = db.prepare(`
    SELECT COALESCE(SUM(tt_fee_usd), 0) AS s
      FROM po_payments
     WHERE po_id = ? AND tt_fee_in_landed = 1 AND status IN ('paid', 'confirmed')
  `).get(poId).s;
  if (ttFeeInLanded > 0) {
    calcComponents.push({ id: '__ttfee__', kind: 'tt_fee', amountUsd: ttFeeInLanded, allocationBasis: 'by_value' });
  }

  const calc = landedCost.calculateLanded({
    lines: lines.map((l) => ({
      id: l.id,
      qty: l.qty,
      unitPriceUsd: l.unitPriceUsdAtPo,
      cartonQty: l.cartonQty,
      cartonWCm: l.cartonWCm,
      cartonHCm: l.cartonHCm,
      cartonDCm: l.cartonDCm,
      weightPerUnitKg: l.weightPerUnitKg,
    })),
    components: calcComponents,
  });

  // Per-line cache.
  const upd = db.prepare(`UPDATE po_lines SET allocated_cost_usd_per_unit = ?, landed_unit_cost_usd = ? WHERE id = ?`);
  for (const l of calc.perLine) {
    upd.run(l.allocatedCostUsdPerUnit, l.landedUnitCostUsd, l.lineId);
  }

  // Header cache. total_components_usd reflects only the REAL cost
  // components (freight/duty/etc), NOT the synthetic in-landed TT fee —
  // the fee changes per-line landed cost but shouldn't inflate the PO's
  // component total or the supplier-spend rollup.
  const totalSupplier = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPriceSupplierCurrency) || 0), 0);
  const realComponentsUsd = components.reduce((s, c) => s + landedCost.componentUsd(c), 0);
  db.prepare(`
    UPDATE purchase_orders
       SET total_value_supplier = ?, total_value_usd = ?,
           total_volume_cbm = ?, total_weight_kg = ?,
           total_components_usd = ?, lines_count = ?, updated_at = ?
     WHERE id = ?
  `).run(
    totalSupplier,
    calc.header.totalValueUsd,
    calc.header.totalVolumeCbm,
    calc.header.totalWeightKg,
    realComponentsUsd,
    lines.length,
    nextUpdatedAt(po.updatedAt),
    poId,
  );

  // v0.49.50: owed-to-supplier (total_value_supplier) just changed, so
  // refresh the payment rollup. One-way edge — recomputePaymentCache
  // never calls back into recomputeHeader, so no recursion.
  recomputePaymentCache(poId);

  if (isCostSource(po.status) && po.receivedAt != null) refreshProductCostsForPO(poId);
}

/**
 * Refresh product_landed_costs for every product on this PO. Runs after
 * a status → received OR after a received PO is deleted / re-opened.
 */
function refreshProductCostsForPO(poId) {
  const db = getDb();
  const productIds = db.prepare(`SELECT DISTINCT product_id FROM po_lines WHERE po_id = ?`).all(poId).map((r) => r.product_id);
  for (const pid of productIds) recomputeProductCost(pid);
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Landed-cost summary for one product from its cost-source PO lines
 * (`rows` newest first: { qty, landed, po_id, received_at }), measured
 * against `now`:
 * - latest = the most recently received line's landed_unit_cost_usd
 * - 3mo avg = weighted by qty over POs received in the last 90 days
 * - 12mo avg = weighted by qty over POs received in the last 365 days
 * Returns null when there are no rows.
 */
function summarizeCostRows(productId, rows, now = Date.now()) {
  if (!rows || rows.length === 0) return null;
  const avg = (subset) => {
    const totalQty = subset.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    if (totalQty <= 0) return null;
    const weighted = subset.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.landed) || 0), 0);
    return weighted / totalQty;
  };
  const latest = rows[0];
  return {
    productId,
    latestLandedCostUsd:  latest.landed,
    latestPoId:           latest.po_id,
    latestReceivedAt:     latest.received_at,
    avgLandedCostUsd3mo:  avg(rows.filter((r) => r.received_at >= now - 90 * DAY_MS)),
    avgLandedCostUsd12mo: avg(rows.filter((r) => r.received_at >= now - 365 * DAY_MS)),
    updatedAt:            now,
  };
}

const COST_ROWS_SELECT = `
  SELECT l.product_id, l.qty, l.landed_unit_cost_usd AS landed, po.id AS po_id, po.received_at
    FROM po_lines l
    JOIN purchase_orders po ON po.id = l.po_id`;

function costRowsForProduct(productId) {
  return getDb().prepare(`${COST_ROWS_SELECT}
     WHERE l.product_id = ? AND ${COST_SOURCE_SQL}
     ORDER BY po.received_at DESC, l.rowid DESC
  `).all(productId);
}

/**
 * Write the product_landed_costs cache row for ONE product across ALL its
 * received/closed POs. The cache keeps "latest" handy for anything that
 * reads the table directly; the reads below (getProductCost /
 * listProductCosts) recompute from the PO lines so the windowed averages
 * age with today's date instead of the date of the last PO edit.
 */
function recomputeProductCost(productId) {
  const db = getDb();
  const summary = summarizeCostRows(productId, costRowsForProduct(productId));
  if (!summary) {
    db.prepare(`DELETE FROM product_landed_costs WHERE product_id = ?`).run(productId);
    return;
  }
  db.prepare(`
    INSERT INTO product_landed_costs (product_id, latest_landed_cost_usd, latest_po_id, latest_received_at, avg_landed_cost_usd_3mo, avg_landed_cost_usd_12mo, updated_at)
    VALUES (@productId, @latest, @poId, @receivedAt, @avg3mo, @avg12mo, @updatedAt)
    ON CONFLICT(product_id) DO UPDATE SET
      latest_landed_cost_usd   = excluded.latest_landed_cost_usd,
      latest_po_id             = excluded.latest_po_id,
      latest_received_at       = excluded.latest_received_at,
      avg_landed_cost_usd_3mo  = excluded.avg_landed_cost_usd_3mo,
      avg_landed_cost_usd_12mo = excluded.avg_landed_cost_usd_12mo,
      updated_at               = excluded.updated_at
  `).run({
    productId,
    latest: summary.latestLandedCostUsd,
    poId: summary.latestPoId,
    receivedAt: summary.latestReceivedAt,
    avg3mo: summary.avgLandedCostUsd3mo,
    avg12mo: summary.avgLandedCostUsd12mo,
    updatedAt: summary.updatedAt,
  });
}

/* ─── reads used by the Product Library + Cost Calculator ───────── */

function getProductCost(productId) {
  if (!productId) return null;
  return summarizeCostRows(productId, costRowsForProduct(productId));
}

function listPosForSupplier(supplierId) {
  if (!supplierId) return [];
  return getDb().prepare(`
    SELECT * FROM purchase_orders WHERE supplier_id = ?
    ORDER BY COALESCE(received_at, ordered_at, created_at) DESC
  `).all(supplierId).map(rowToPO);
}

/**
 * v0.49.48 — bulk cost fetch for the Product Library Cost column.
 * Returns a flat array of cost rows for every product in the company
 * that has received/closed PO history (computed now, so the averages are
 * against today's date). The renderer keys it into a Map. One query
 * instead of N per-row round-trips — important on a 200-row table in
 * client mode.
 */
function listProductCosts(companyId) {
  if (!companyId) return [];
  const rows = getDb().prepare(`${COST_ROWS_SELECT}
      JOIN products p ON p.id = l.product_id
     WHERE p.company_id = ? AND ${COST_SOURCE_SQL}
     ORDER BY l.product_id, po.received_at DESC, l.rowid DESC
  `).all(companyId);
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }
  const now = Date.now();
  return [...byProduct].map(([productId, list]) => summarizeCostRows(productId, list, now));
}

/**
 * v0.49.48 — per-supplier spend rollup for the Suppliers page. Returns
 * a map keyed by supplier_id: { poCount, receivedCount, totalSpendUsd,
 * lastOrderedAt }. totalSpendUsd sums goods value + cost components in
 * USD across every PO for that supplier (any status — a draft PO is
 * committed spend the buyer is planning). Used to show a spend chip +
 * order count per supplier without N queries.
 */
function supplierSpendRollup(companyId) {
  if (!companyId) return {};
  const rows = getDb().prepare(`
    SELECT supplier_id,
           COUNT(*)                                             AS po_count,
           SUM(CASE WHEN status IN ('received', 'closed') AND received_at IS NOT NULL THEN 1 ELSE 0 END) AS received_count,
           SUM(COALESCE(total_value_usd, 0) + COALESCE(total_components_usd, 0)) AS total_spend_usd,
           MAX(COALESCE(ordered_at, created_at))                AS last_ordered_at
      FROM purchase_orders
     WHERE company_id = ?
     GROUP BY supplier_id
  `).all(companyId);
  const map = {};
  for (const r of rows) {
    if (!r.supplier_id) continue;
    map[r.supplier_id] = {
      poCount:       r.po_count || 0,
      receivedCount: r.received_count || 0,
      totalSpendUsd: r.total_spend_usd || 0,
      lastOrderedAt: r.last_ordered_at || null,
    };
  }
  return map;
}

function listPosForProduct(productId) {
  if (!productId) return [];
  return getDb().prepare(`
    SELECT po.*, l.qty, l.landed_unit_cost_usd, l.unit_price_supplier_currency
      FROM po_lines l
      JOIN purchase_orders po ON po.id = l.po_id
     WHERE l.product_id = ?
     ORDER BY COALESCE(po.received_at, po.ordered_at, po.created_at) DESC
  `).all(productId).map((r) => ({
    ...rowToPO(r),
    lineQty: r.qty,
    lineLandedUnitCostUsd: r.landed_unit_cost_usd,
    lineUnitPriceSupplier: r.unit_price_supplier_currency,
  }));
}

module.exports = {
  list, get, getDetail, create, update, setStatus, remove,
  addLine, updateLine, removeLine,
  addComponent, updateComponent, removeComponent,
  addPayment, updatePayment, removePayment, listPayments,
  recomputeHeader, recomputeProductCost,
  getProductCost, listProductCosts, supplierSpendRollup,
  listPosForSupplier, listPosForProduct,
};
