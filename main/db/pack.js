/**
 * Pick & Pack — Phase 0 data layer (docs/PICK_AND_PACK_PLAN.md §3, §4, §7).
 *
 * Orders + lines + parcel photos, company-scoped. Two rules drive everything
 * here:
 *
 *   1. **Line snapshots.** order_lines stores the SKU and name at import time,
 *      so renaming a product later cannot rewrite what was packed.
 *   2. **Sealed is immutable.** Every mutator refuses a packed order, and the
 *      schema triggers refuse it at SQLite level too. The packer never sees a
 *      price: `getOrder(..., { forPacking: true })` leaves the value out.
 *
 * The optional order value exists only to decide whether a parcel photo is
 * required (pack_settings). It is never sent to the pack screen.
 */

const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson } = require('./_util');
const { normalizeCurrency, WHOLE_NUMBER } = require('../util/currencies');
const { phnomPenhDate } = require('../util/fuelAnomalies');

const SOURCES = new Set(['marketplace', 'chat', 'paper', 'sheet', 'manual']);
const PHOTO_KINDS = new Set(['contents', 'sealed']);
const DAY_MS = 24 * 60 * 60 * 1000;

function assertSource(source) {
  if (!SOURCES.has(source)) throw new Error('Source must be marketplace, chat, paper, sheet or manual');
  return source;
}

function toMinor(amount, currency) {
  if (amount == null || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const cur = normalizeCurrency(currency);
  return Math.round(n * (WHOLE_NUMBER.has(cur) ? 1 : 100));
}

function fromMinor(minor, currency) {
  if (minor == null) return null;
  const cur = normalizeCurrency(currency);
  return minor / (WHOLE_NUMBER.has(cur) ? 1 : 100);
}

/** Asia/Phnom_Penh day bounds (UTC+7, no DST) around `now`. */
function dayBounds(now = Date.now()) {
  const date = phnomPenhDate(now);
  const start = Date.parse(`${date}T00:00:00+07:00`);
  return { start, end: start + DAY_MS };
}

function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    source: row.source,
    externalRef: row.external_ref,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    status: row.status,
    valueMinor: row.value_minor == null ? null : Number(row.value_minor),
    currency: row.currency,
    notes: row.notes,
    packedByUserId: row.packed_by_user_id,
    packedAt: row.packed_at,
    shippedAt: row.shipped_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLine(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    quantity: Number(row.quantity),
    serial: row.serial,
    confirmedQty: Number(row.confirmed_qty),
    confirmedAt: row.confirmed_at,
    imagePath: row.image_path ?? null,
  };
}

function rowToPhoto(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    kind: row.kind,
    relPath: row.rel_path,
    sha256: row.sha256,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    takenByUserId: row.taken_by_user_id,
    takenAt: row.taken_at,
  };
}

function getOrderRow(companyId, id) {
  return getDb().prepare('SELECT * FROM orders WHERE id = ? AND company_id = ?').get(id, companyId);
}

function assertOrder(companyId, id) {
  const row = getOrderRow(companyId, id);
  if (!row) {
    const err = new Error('Order not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return row;
}

/** A plain sentence for the person; the trigger is the backstop. */
function assertEditable(row) {
  if (row.status === 'packed') {
    const err = new Error('This parcel is sealed. Its record cannot be changed.');
    err.code = 'PACKED_IMMUTABLE';
    throw err;
  }
}

/* ─── settings ────────────────────────────────────────────────── */

function getSettings(companyId) {
  const row = getDb().prepare('SELECT * FROM pack_settings WHERE company_id = ?').get(companyId);
  return {
    photoRequiredAboveMinor: row?.photo_required_above_minor == null ? null : Number(row.photo_required_above_minor),
    currency: row?.currency ?? null,
  };
}

function updateSettings(companyId, patch = {}, userId = null) {
  const current = getSettings(companyId);
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const threshold = has('photoRequiredAboveMinor') ? patch.photoRequiredAboveMinor : current.photoRequiredAboveMinor;
  if (threshold != null && (!Number.isFinite(Number(threshold)) || Number(threshold) < 0)) {
    throw new Error('The photo threshold must be zero or more, or empty for always required');
  }
  const currency = has('currency')
    ? (patch.currency ? normalizeCurrency(patch.currency) : null)
    : current.currency;
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO pack_settings (company_id, photo_required_above_minor, currency, updated_at, updated_by_user_id)
    VALUES (@companyId, @threshold, @currency, @now, @userId)
    ON CONFLICT(company_id) DO UPDATE SET
      photo_required_above_minor = excluded.photo_required_above_minor,
      currency = excluded.currency,
      updated_at = excluded.updated_at,
      updated_by_user_id = excluded.updated_by_user_id
  `).run({
    companyId,
    threshold: threshold == null ? null : Math.round(Number(threshold)),
    currency: threshold == null ? null : currency,
    now, userId,
  });
  return getSettings(companyId);
}

/** Is a parcel photo required for this order? Unknown value or another currency = required. */
function photoRequired(order, settings = null) {
  const s = settings ?? getSettings(order.companyId);
  if (s.photoRequiredAboveMinor == null) return true;
  if (order.valueMinor == null) return true;
  if (normalizeCurrency(order.currency) !== normalizeCurrency(s.currency)) return true;
  return order.valueMinor >= s.photoRequiredAboveMinor;
}

/* ─── saved import mapping ───────────────────────────────────── */

function getMapping(companyId, source) {
  assertSource(source);
  const row = getDb().prepare('SELECT mapping FROM order_import_mappings WHERE company_id = ? AND source = ?').get(companyId, source);
  return row ? parseJson(row.mapping, {}) : null;
}

function saveMapping(companyId, source, mapping) {
  assertSource(source);
  if (mapping == null || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Mapping must be an object');
  getDb().prepare(`
    INSERT INTO order_import_mappings (company_id, source, mapping, updated_at)
    VALUES (@companyId, @source, @mapping, @now)
    ON CONFLICT(company_id, source) DO UPDATE SET mapping = excluded.mapping, updated_at = excluded.updated_at
  `).run({ companyId, source, mapping: JSON.stringify(mapping), now: Date.now() });
  return getMapping(companyId, source);
}

/* ─── reads ───────────────────────────────────────────────────── */

function listOrders(companyId, { search = '', status = 'all' } = {}) {
  let sql = `SELECT o.*,
      (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count,
      (SELECT COALESCE(SUM(l.quantity), 0) FROM order_lines l WHERE l.order_id = o.id) AS item_count,
      (SELECT COUNT(*) FROM parcel_photos p WHERE p.order_id = o.id) AS photo_count
    FROM orders o WHERE o.company_id = @companyId`;
  const params = { companyId };
  if (status && status !== 'all') { sql += ' AND o.status = @status'; params.status = status; }
  const q = String(search || '').trim();
  if (q) {
    sql += ' AND (o.external_ref LIKE @like OR o.customer_name LIKE @like OR o.customer_phone LIKE @like)';
    params.like = `%${q}%`;
  }
  sql += ' ORDER BY o.created_at DESC';
  return getDb().prepare(sql).all(params).map((row) => ({
    ...rowToOrder(row),
    lineCount: Number(row.line_count),
    itemCount: Number(row.item_count),
    photoCount: Number(row.photo_count),
  }));
}

function getOrder(companyId, id, { forPacking = false } = {}) {
  const row = assertOrder(companyId, id);
  const lines = getDb().prepare(`
    SELECT l.*, (
      SELECT pi.filepath FROM product_images pi
       WHERE pi.product_id = l.product_id ORDER BY pi.order_index ASC LIMIT 1
    ) AS image_path
    FROM order_lines l WHERE l.order_id = ? ORDER BY l.created_at ASC, l.sku ASC
  `).all(id).map(rowToLine);
  const photos = getDb().prepare('SELECT * FROM parcel_photos WHERE order_id = ? ORDER BY taken_at ASC').all(id).map(rowToPhoto);
  const settings = getSettings(companyId);
  const order = rowToOrder(row);
  const out = {
    order: forPacking
      ? {
        id: order.id, source: order.source, externalRef: order.externalRef,
        customerName: order.customerName, customerPhone: order.customerPhone,
        customerAddress: order.customerAddress, status: order.status,
        createdAt: order.createdAt, packedAt: order.packedAt,
      }
      : order,
    lines,
    photos,
    photoRequired: photoRequired(order, settings),
    hasPhoto: photos.length > 0,
    settings,
  };
  return out;
}

function getPhoto(companyId, photoId) {
  const row = getDb().prepare(`
    SELECT p.* FROM parcel_photos p
      JOIN orders o ON o.id = p.order_id
     WHERE p.id = ? AND o.company_id = ?
  `).get(photoId, companyId);
  if (!row) {
    const err = new Error('Photo not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return rowToPhoto(row);
}

/* ─── pack queue ──────────────────────────────────────────────── */

function packCounters(companyId, now = Date.now()) {
  const { start, end } = dayBounds(now);
  const db = getDb();
  const toPack = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE company_id = ? AND status IN ('open','packing')`).get(companyId).n;
  const packedToday = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE company_id = ? AND status = 'packed' AND packed_at >= ? AND packed_at < ?`).get(companyId, start, end).n;
  const withoutPhotos = db.prepare(`
    SELECT COUNT(*) AS n FROM orders o
     WHERE o.company_id = ? AND o.status = 'packed' AND o.packed_at >= ? AND o.packed_at < ?
       AND NOT EXISTS (SELECT 1 FROM parcel_photos p WHERE p.order_id = o.id)
  `).get(companyId, start, end).n;
  return { toPack: Number(toPack), packedToday: Number(packedToday), withoutPhotos: Number(withoutPhotos) };
}

function packList(companyId, tab = 'pack', now = Date.now()) {
  const { start, end } = dayBounds(now);
  const base = `SELECT o.*,
      (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count,
      (SELECT COALESCE(SUM(l.quantity), 0) FROM order_lines l WHERE l.order_id = o.id) AS item_count,
      (SELECT COUNT(*) FROM parcel_photos p WHERE p.order_id = o.id) AS photo_count
    FROM orders o`;
  let sql;
  let params;
  if (tab === 'packed') {
    sql = `${base} WHERE o.company_id = ? AND o.status = 'packed' AND o.packed_at >= ? AND o.packed_at < ? ORDER BY o.packed_at DESC`;
    params = [companyId, start, end];
  } else if (tab === 'problems') {
    sql = `${base} WHERE o.company_id = ? AND o.status = 'packed' AND o.packed_at >= ? AND o.packed_at < ?
      AND NOT EXISTS (SELECT 1 FROM parcel_photos p WHERE p.order_id = o.id) ORDER BY o.packed_at DESC`;
    params = [companyId, start, end];
  } else {
    sql = `${base} WHERE o.company_id = ? AND o.status IN ('open','packing') ORDER BY o.created_at DESC`;
    params = [companyId];
  }
  const rows = getDb().prepare(sql).all(...params).map((row) => ({
    id: row.id,
    source: row.source,
    externalRef: row.external_ref,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    status: row.status,
    createdAt: row.created_at,
    packedAt: row.packed_at,
    lineCount: Number(row.line_count),
    itemCount: Number(row.item_count),
    photoCount: Number(row.photo_count),
  }));
  return { counters: packCounters(companyId, now), orders: rows };
}

/* ─── import ──────────────────────────────────────────────────── */

function productBySku(companyId, sku) {
  return getDb().prepare('SELECT id, sku, name FROM products WHERE company_id = ? AND sku = ? COLLATE NOCASE').get(companyId, sku);
}

function groupImportRows(rows) {
  if (!Array.isArray(rows)) throw new Error('rows must be a list');
  const groups = new Map();
  const skipped = [];
  rows.forEach((raw, index) => {
    const ref = String(raw?.externalRef ?? '').trim();
    if (!ref) { skipped.push({ row: index + 2, reason: 'Order reference is missing' }); return; }
    const sku = String(raw?.sku ?? '').trim();
    if (!sku) { skipped.push({ row: index + 2, reason: `Order ${ref}: item SKU is missing` }); return; }
    const g = groups.get(ref) || { ref, fields: {}, lines: [] };
    for (const [key, value] of [['customerName', raw.customerName], ['customerPhone', raw.customerPhone],
      ['customerAddress', raw.customerAddress], ['currency', raw.currency]]) {
      if (g.fields[key] == null && value != null && String(value).trim() !== '') g.fields[key] = String(value).trim();
    }
    if (g.fields.value == null && raw.value != null && String(raw.value).trim() !== '') g.fields.value = raw.value;
    const qty = raw.quantity == null || String(raw.quantity).trim() === '' ? 1 : Math.round(Number(raw.quantity));
    g.lines.push({ sku, name: raw.lineName == null ? '' : String(raw.lineName).trim(), quantity: Number.isFinite(qty) && qty > 0 ? qty : 1 });
    groups.set(ref, g);
  });
  return { groups: [...groups.values()], skipped };
}

function importOrders(companyId, source, rows, { dryRun = false, userId = null } = {}) {
  assertSource(source);
  const { groups, skipped } = groupImportRows(rows);
  const db = getDb();
  const result = { created: 0, updated: 0, linesAdded: 0, linesUpdated: 0, skipped: [...skipped], orderIds: [] };
  const run = db.transaction(() => {
    const now = Date.now();
    for (const g of groups) {
      let existing = db.prepare('SELECT * FROM orders WHERE company_id = ? AND source = ? AND external_ref = ?').get(companyId, source, g.ref);
      let orderId;
      if (existing && existing.status === 'packed') {
        result.skipped.push({ row: null, reason: `Order ${g.ref} is already sealed` });
        continue;
      }
      if (!existing) {
        orderId = crypto.randomUUID();
        const currency = g.fields.currency ? normalizeCurrency(g.fields.currency) : null;
        db.prepare(`
          INSERT INTO orders (id, company_id, source, external_ref, customer_name, customer_phone, customer_address,
            status, value_minor, currency, created_at, updated_at, created_by_user_id, updated_by_user_id)
          VALUES (@id, @companyId, @source, @externalRef, @customerName, @customerPhone, @customerAddress,
            'open', @valueMinor, @currency, @now, @now, @userId, @userId)
        `).run({
          id: orderId, companyId, source, externalRef: g.ref,
          customerName: g.fields.customerName ?? null, customerPhone: g.fields.customerPhone ?? null,
          customerAddress: g.fields.customerAddress ?? null,
          valueMinor: toMinor(g.fields.value, currency), currency, now, userId,
        });
        result.created += 1;
      } else {
        orderId = existing.id;
        const sets = [];
        const params = { id: orderId, now, userId };
        for (const [col, key] of [['customer_name', 'customerName'], ['customer_phone', 'customerPhone'], ['customer_address', 'customerAddress']]) {
          if (g.fields[key] != null) { sets.push(`${col} = @${key}`); params[key] = g.fields[key]; }
        }
        if (g.fields.value != null) {
          const currency = g.fields.currency ? normalizeCurrency(g.fields.currency) : (existing.currency || null);
          sets.push('value_minor = @valueMinor', 'currency = @currency');
          params.valueMinor = toMinor(g.fields.value, currency);
          params.currency = currency;
        } else if (g.fields.currency != null) {
          sets.push('currency = @currency');
          params.currency = normalizeCurrency(g.fields.currency);
        }
        if (sets.length) {
          sets.push('updated_at = @now', 'updated_by_user_id = @userId');
          db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = @id`).run(params);
        }
        result.updated += 1;
      }
      result.orderIds.push(orderId);
      for (const line of g.lines) {
        const product = productBySku(companyId, line.sku);
        const name = line.name || product?.name || line.sku;
        const current = db.prepare('SELECT * FROM order_lines WHERE order_id = ? AND sku = ? COLLATE NOCASE').get(orderId, line.sku);
        if (current) {
          const nextQty = line.quantity;
          const confirmed = Math.min(Number(current.confirmed_qty), nextQty);
          db.prepare(`UPDATE order_lines SET quantity = ?, name = ?, product_id = COALESCE(?, product_id),
              confirmed_qty = ?, updated_at = ? WHERE id = ?`)
            .run(nextQty, name, product?.id ?? null, confirmed, now, current.id);
          result.linesUpdated += 1;
        } else {
          db.prepare(`
            INSERT INTO order_lines (id, order_id, product_id, sku, name, quantity, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(crypto.randomUUID(), orderId, product?.id ?? null, line.sku, name, line.quantity, now, now);
          result.linesAdded += 1;
        }
      }
    }
    if (dryRun) {
      const err = new Error('dry run');
      err.__packDryRun = result;
      throw err;
    }
  });
  try {
    run();
  } catch (err) {
    if (err && err.__packDryRun) return err.__packDryRun;
    throw err;
  }
  return result;
}

/* ─── quick add ───────────────────────────────────────────────── */

function quickAdd(companyId, input = {}, userId = null) {
  const source = input.source || 'manual';
  assertSource(source);
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length) throw new Error('Add at least one item');
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const currency = input.currency ? normalizeCurrency(input.currency) : null;
  const externalRef = input.externalRef == null || String(input.externalRef).trim() === ''
    ? null : String(input.externalRef).trim();
  if (externalRef) {
    const clash = db.prepare('SELECT 1 FROM orders WHERE company_id = ? AND source = ? AND external_ref = ?').get(companyId, source, externalRef);
    if (clash) throw new Error(`Order ${externalRef} already exists for ${source}`);
  }
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (id, company_id, source, external_ref, customer_name, customer_phone, customer_address,
        status, value_minor, currency, notes, created_at, updated_at, created_by_user_id, updated_by_user_id)
      VALUES (@id, @companyId, @source, @externalRef, @customerName, @customerPhone, @customerAddress,
        'open', @valueMinor, @currency, @notes, @now, @now, @userId, @userId)
    `).run({
      id, companyId, source, externalRef,
      customerName: input.customerName == null ? null : String(input.customerName).trim(),
      customerPhone: input.customerPhone == null ? null : String(input.customerPhone).trim(),
      customerAddress: input.customerAddress == null ? null : String(input.customerAddress).trim(),
      valueMinor: toMinor(input.value, currency), currency,
      notes: input.notes == null ? null : String(input.notes).trim(),
      now, userId,
    });
    const insert = db.prepare(`
      INSERT INTO order_lines (id, order_id, product_id, sku, name, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const line of lines) {
      const product = line.productId
        ? db.prepare('SELECT id, sku, name FROM products WHERE id = ? AND company_id = ?').get(line.productId, companyId)
        : productBySku(companyId, String(line.sku || '').trim());
      if (!product) throw new Error(line.productId ? 'That product no longer exists' : `No product with SKU ${line.sku}`);
      const qty = Math.round(Number(line.quantity));
      insert.run(crypto.randomUUID(), id, product.id, product.sku, product.name || product.sku,
        Number.isFinite(qty) && qty > 0 ? qty : 1, now, now);
    }
  });
  tx();
  return getOrder(companyId, id);
}

/* ─── edit / remove open orders ──────────────────────────────── */

function updateOrder(companyId, id, patch = {}, userId = null) {
  const order = assertOrder(companyId, id);
  assertEditable(order);
  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    const sets = [];
    const params = { id, now, userId };
    for (const [col, key] of [['customer_name', 'customerName'], ['customer_phone', 'customerPhone'],
      ['customer_address', 'customerAddress'], ['notes', 'notes']]) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        sets.push(`${col} = @${key}`);
        params[key] = patch[key] == null ? null : String(patch[key]).trim();
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'currency')) {
      sets.push('currency = @currency');
      params.currency = patch.currency ? normalizeCurrency(patch.currency) : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'valueMinor')) {
      sets.push('value_minor = @valueMinor');
      params.valueMinor = patch.valueMinor == null ? null : Math.round(Number(patch.valueMinor));
    }
    if (sets.length) {
      sets.push('updated_at = @now', 'updated_by_user_id = @userId');
      db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = @id`).run(params);
    }
    if (Array.isArray(patch.lines)) {
      for (const line of patch.lines) {
        const current = db.prepare('SELECT * FROM order_lines WHERE id = ? AND order_id = ?').get(line.id, id);
        if (!current) throw new Error('One of those items is no longer on this order');
        const qty = Math.round(Number(line.quantity));
        if (!Number.isFinite(qty) || qty < 1) throw new Error('Quantity must be one or more');
        db.prepare('UPDATE order_lines SET quantity = ?, confirmed_qty = ?, updated_at = ? WHERE id = ?')
          .run(qty, Math.min(Number(current.confirmed_qty), qty), now, current.id);
      }
    }
  });
  tx();
  return getOrder(companyId, id);
}

function removeOrder(companyId, id) {
  const order = assertOrder(companyId, id);
  assertEditable(order);
  getDb().prepare('DELETE FROM orders WHERE id = ?').run(id);
  return { deleted: 1 };
}

/* ─── packing ─────────────────────────────────────────────────── */

function lineForScan(companyId, orderId, code) {
  const value = String(code || '').trim();
  if (!value) return null;
  return getDb().prepare(`
    SELECT l.*, p.barcode AS product_barcode, p.secondary_code AS product_secondary
      FROM order_lines l
      LEFT JOIN products p ON p.id = l.product_id
      JOIN orders o ON o.id = l.order_id
     WHERE l.order_id = ? AND o.company_id = ?
       AND (l.sku = ? COLLATE NOCASE OR p.barcode = ? COLLATE NOCASE OR p.secondary_code = ? COLLATE NOCASE)
     LIMIT 1
  `).get(orderId, companyId, value, value, value);
}

function scan(companyId, orderId, code, userId = null) {
  const order = assertOrder(companyId, orderId);
  assertEditable(order);
  const row = lineForScan(companyId, orderId, code);
  if (!row) return { matched: false, message: 'Not in this order' };
  const qty = Number(row.quantity);
  if (Number(row.confirmed_qty) >= qty) {
    return { matched: true, already: true, line: rowToLine(row) };
  }
  const now = Date.now();
  getDb().prepare(`UPDATE order_lines SET confirmed_qty = confirmed_qty + 1, confirmed_at = ?, confirmed_by_user_id = ?,
      updated_at = ? WHERE id = ?`).run(now, userId, now, row.id);
  const updated = getDb().prepare(`
    SELECT l.*, (SELECT pi.filepath FROM product_images pi WHERE pi.product_id = l.product_id ORDER BY pi.order_index ASC LIMIT 1) AS image_path
      FROM order_lines l WHERE l.id = ?
  `).get(row.id);
  return { matched: true, line: rowToLine(updated) };
}

function confirmLine(companyId, orderId, lineId, delta = 1, userId = null) {
  const order = assertOrder(companyId, orderId);
  assertEditable(order);
  const row = getDb().prepare('SELECT * FROM order_lines WHERE id = ? AND order_id = ?').get(lineId, orderId);
  if (!row) {
    const err = new Error('That item is not on this order');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const step = Number(delta) === 0 ? 0 : (Number(delta) > 0 ? Math.round(Number(delta)) : Math.round(Number(delta)));
  const next = Math.max(0, Math.min(Number(row.quantity), Number(row.confirmed_qty) + step));
  const now = Date.now();
  getDb().prepare(`UPDATE order_lines SET confirmed_qty = ?, confirmed_at = ?, confirmed_by_user_id = ?, updated_at = ? WHERE id = ?`)
    .run(next, next > 0 ? now : null, next > 0 ? userId : null, now, row.id);
  const updated = getDb().prepare(`
    SELECT l.*, (SELECT pi.filepath FROM product_images pi WHERE pi.product_id = l.product_id ORDER BY pi.order_index ASC LIMIT 1) AS image_path
      FROM order_lines l WHERE l.id = ?
  `).get(row.id);
  return { line: rowToLine(updated) };
}

/** Insert one prepared parcel photo. The file is written by main/packPhotos.js first. */
function addPhotoRow(companyId, orderId, photo, userId = null) {
  const order = assertOrder(companyId, orderId);
  assertEditable(order);
  if (!PHOTO_KINDS.has(photo.kind)) throw new Error('Photo kind must be contents or sealed');
  const now = Date.now();
  const id = crypto.randomUUID();
  const tx = getDb().transaction(() => {
    getDb().prepare(`
      INSERT INTO parcel_photos (id, order_id, kind, rel_path, sha256, bytes, width, height, taken_by_user_id, taken_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orderId, photo.kind, photo.relPath, photo.sha256, photo.bytes ?? null,
      photo.width ?? null, photo.height ?? null, userId, now);
    if (order.status === 'open') {
      getDb().prepare('UPDATE orders SET status = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?')
        .run('packing', now, userId, orderId);
    }
  });
  tx();
  return rowToPhoto(getDb().prepare('SELECT * FROM parcel_photos WHERE id = ?').get(id));
}

function seal(companyId, orderId, userId = null) {
  const order = assertOrder(companyId, orderId);
  if (order.status === 'packed') return getOrder(companyId, orderId, { forPacking: true });
  assertEditable(order);
  const db = getDb();
  const lines = db.prepare('SELECT quantity, confirmed_qty, sku FROM order_lines WHERE order_id = ?').all(orderId);
  if (!lines.length) throw new Error('This order has no items to pack');
  const unconfirmed = lines.filter((l) => Number(l.confirmed_qty) < Number(l.quantity));
  if (unconfirmed.length) {
    throw new Error(`Confirm every item first (${unconfirmed.map((l) => l.sku).join(', ')})`);
  }
  const photos = db.prepare('SELECT COUNT(*) AS n FROM parcel_photos WHERE order_id = ?').get(orderId).n;
  if (photoRequired(rowToOrder(order)) && Number(photos) === 0) {
    throw new Error('Take a parcel photo before sealing');
  }
  const now = Date.now();
  db.prepare(`UPDATE orders SET status = 'packed', packed_at = ?, packed_by_user_id = ?, updated_at = ?, updated_by_user_id = ? WHERE id = ?`)
    .run(now, userId, now, userId, orderId);
  return getOrder(companyId, orderId, { forPacking: true });
}

/* ─── product lookup for quick add ───────────────────────────── */

function lookupProduct(companyId, code) {
  const value = String(code || '').trim();
  if (!value) return null;
  const row = getDb().prepare(`
    SELECT p.id, p.sku, p.name, p.barcode,
      (SELECT pi.filepath FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.order_index ASC LIMIT 1) AS image_path
    FROM products p
    WHERE p.company_id = ? AND (p.sku = ? COLLATE NOCASE OR p.barcode = ? COLLATE NOCASE OR p.secondary_code = ? COLLATE NOCASE)
    ORDER BY CASE WHEN p.sku = ? COLLATE NOCASE THEN 0 WHEN p.barcode = ? COLLATE NOCASE THEN 1 ELSE 2 END
    LIMIT 1
  `).get(companyId, value, value, value, value, value);
  if (!row) return null;
  return { id: row.id, sku: row.sku, name: row.name, barcode: row.barcode, imagePath: row.image_path ?? null };
}

module.exports = {
  SOURCES,
  PHOTO_KINDS,
  toMinor,
  fromMinor,
  dayBounds,
  getSettings,
  updateSettings,
  photoRequired,
  getMapping,
  saveMapping,
  listOrders,
  getOrder,
  getPhoto,
  packCounters,
  packList,
  importOrders,
  quickAdd,
  updateOrder,
  removeOrder,
  scan,
  confirmLine,
  addPhotoRow,
  seal,
  lookupProduct,
};
