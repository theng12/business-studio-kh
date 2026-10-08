/**
 * v0.22.6: audit_log — durable, queryable history of every mutation.
 *
 * Why a separate table (not just trusting the `updated_*` columns)?
 * The existing `updated_by_user_id` + `updated_at` only tell you who
 * touched a row LAST. The user asked for an "audit trail" — i.e. who
 * did what, when, going back through the row's whole life. That can't
 * be reconstructed from current-state columns alone, so we accumulate
 * an immutable per-event log.
 *
 * Shape (defined in main/db/index.js):
 *   id          PK
 *   entity_type 'product' | 'brand' | 'category' | 'image' | 'company' | …
 *   entity_id   product/brand/category id, OR product_id for image events
 *               (so a product's History modal also catches image-grid edits)
 *   user_id     caller's user id, or NULL for server-admin / standalone
 *   action      short verb: 'create' | 'update' | 'delete' | 'bulk-update' |
 *               'image:add' | 'image:remove' | 'image:set-main' | 'image:reorder'
 *   before_json JSON of changed keys' old values (updates) OR full snapshot (deletes)
 *   after_json  JSON of changed keys' new values (updates) OR full snapshot (creates)
 *   created_at  epoch ms
 *
 * The `before`/`after` payloads are deliberately tiny for updates: ONLY
 * the keys that actually changed. A 30-field product edit where the user
 * just retitled one field stores one key on each side. That keeps the
 * SQLite file from growing pathologically on heavy editing days.
 *
 * No retention policy yet. SQLite handles tens of millions of rows fine
 * — at ~150 bytes per audit row, 1M edits is ~150MB. If we ever need a
 * retention sweep, do it from a background job at app boot.
 */

const { getDb } = require('./index');
const { parseJson, getCallerUserId } = require('./_util');

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    userId: row.user_id,
    action: row.action,
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    createdAt: row.created_at,
  };
}

/**
 * Diff two flat objects and return ONLY the keys whose values differ.
 * Returns `{ before, after }` — `before` carries the old values for the
 * changed keys, `after` the new. Returns null if no keys changed (caller
 * uses that to skip logging a no-op update).
 *
 * - Compares with strict equality after JSON-normalizing nested values,
 *   so `{ prices: { retail: 10 } }` vs `{ prices: { retail: 10 } }` is
 *   treated as unchanged.
 * - `before` is the row as it existed BEFORE the patch was applied;
 *   `patch` is whatever keys the caller passed. We diff only the keys
 *   in `patch` to avoid recording unrelated drift (timestamps etc.).
 */
function diffPatch(before, patch) {
  if (!patch || typeof patch !== 'object') return null;
  const b = {};
  const a = {};
  let changed = false;
  for (const key of Object.keys(patch)) {
    // Skip computed / housekeeping fields that the caller may include
    // but that aren't user-meaningful for the audit log.
    if (key === 'updatedAt' || key === 'updatedByUserId' || key === 'expectedUpdatedAt') continue;
    const beforeVal = before?.[key];
    const afterVal = patch[key];
    const sameByValue =
      beforeVal === afterVal ||
      JSON.stringify(beforeVal ?? null) === JSON.stringify(afterVal ?? null);
    if (sameByValue) continue;
    b[key] = beforeVal ?? null;
    a[key] = afterVal;
    changed = true;
  }
  return changed ? { before: b, after: a } : null;
}

/**
 * Write one log entry. Caller passes the user id explicitly when known
 * (e.g. queueRunner calls happen outside an RPC, so getCallerUserId()
 * returns null but the originating user is stored on the task). Most
 * call sites can omit it and we'll fall back to getCallerUserId().
 *
 * Safe to call inside an existing better-sqlite3 transaction — the
 * single-row INSERT is fast and the surrounding txn keeps it atomic
 * with the actual mutation.
 *
 * Returns the auto-incremented id of the new row.
 */
function log({ entityType, entityId, action, before, after, userId, sensitivity = null }) {
  if (!entityType || !action) {
    // Audit logging shouldn't break the calling write; just bail.
    return null;
  }
  const db = getDb();
  const uid = userId !== undefined ? userId : getCallerUserId();
  try {
    // Fixed Assets (review M6): a row's sensitivity (assets pass 'finance') is
    // kept when this database has the audit_log.sensitivity column (HR1 adds
    // it) — checked, so the code works whichever lands first.
    const withSensitivity = sensitivity && hasSensitivityColumn(db);
    const info = db
      .prepare(withSensitivity
        ? `INSERT INTO audit_log (entity_type, entity_id, user_id, action, before_json, after_json, created_at, sensitivity)
           VALUES (@entityType, @entityId, @userId, @action, @beforeJson, @afterJson, @createdAt, @sensitivity)`
        : `INSERT INTO audit_log (entity_type, entity_id, user_id, action, before_json, after_json, created_at)
           VALUES (@entityType, @entityId, @userId, @action, @beforeJson, @afterJson, @createdAt)`)
      .run({
        ...(withSensitivity ? { sensitivity: String(sensitivity) } : {}),
        entityType,
        entityId: entityId ?? null,
        userId: uid ?? null,
        action,
        beforeJson: before == null ? null : JSON.stringify(before),
        afterJson: after == null ? null : JSON.stringify(after),
        createdAt: Date.now(),
      });
    return info?.lastInsertRowid ?? null;
  } catch (err) {
    process.stderr.write(`[audit] log failed (${entityType}/${action}): ${err.message}\n`);
    return null;
  }
}

const _sensitivityColumn = new WeakMap();
/** Remembered once found (a column is never dropped); looked up again until then. */
function hasSensitivityColumn(db) {
  if (_sensitivityColumn.get(db)) return true;
  let has;
  try { has = db.prepare('PRAGMA table_info(audit_log)').all().some((c) => c.name === 'sensitivity'); } catch (_) { has = false; }
  if (has) _sensitivityColumn.set(db, true);
  return has;
}

/**
 * Convenience wrapper for the update case — diffs before/patch and
 * only logs if there's a real change. Used by db/products.update etc.
 * so the per-table caller stays compact.
 */
function logUpdate({ entityType, entityId, beforeRow, patch, userId }) {
  const d = diffPatch(beforeRow, patch);
  if (!d) return null;
  return log({
    entityType,
    entityId,
    action: 'update',
    before: d.before,
    after: d.after,
    userId,
  });
}

/**
 * Per-entity history feed for the side panel. Newest first. The
 * default limit is 200 — generous enough for a product's full life
 * in normal use, small enough to keep the modal snappy.
 *
 * Image events live under `entity_type='image', entity_id=<product_id>`
 * so a product's history modal naturally surfaces them via the same
 * query (no UNION needed) — that's why we use product_id (not the
 * product_images.id) as the entity_id for image events.
 */
function listForEntity(entityType, entityId, limit = 200) {
  if (!entityType || !entityId) return [];
  const db = getDb();
  const cappedLimit = Math.min(Math.max(1, Number(limit) || 200), 1000);
  // For products, also pull image events (entity_type='image',
  // entity_id=<productId>) interleaved by created_at so the modal
  // shows one timeline.
  let rows;
  if (entityType === 'product') {
    rows = db
      .prepare(`
        SELECT * FROM audit_log
         WHERE (entity_type = 'product' AND entity_id = @id)
            OR (entity_type = 'image'   AND entity_id = @id)
         ORDER BY created_at DESC
         LIMIT @limit
      `)
      .all({ id: entityId, limit: cappedLimit });
  } else {
    rows = db
      .prepare(`
        SELECT * FROM audit_log
         WHERE entity_type = @type AND entity_id = @id
         ORDER BY created_at DESC
         LIMIT @limit
      `)
      .all({ type: entityType, id: entityId, limit: cappedLimit });
  }
  return rows.map(rowToEntry);
}

/**
 * Best-effort total count for a per-entity history modal that wants
 * to say "2 of 142 events shown". For products this includes the
 * interleaved image events the same way listForEntity does.
 */
function countForEntity(entityType, entityId) {
  if (!entityType || !entityId) return 0;
  const db = getDb();
  let row;
  if (entityType === 'product') {
    row = db
      .prepare(`
        SELECT COUNT(*) AS n FROM audit_log
         WHERE (entity_type = 'product' AND entity_id = @id)
            OR (entity_type = 'image'   AND entity_id = @id)
      `)
      .get({ id: entityId });
  } else {
    row = db
      .prepare(`
        SELECT COUNT(*) AS n FROM audit_log
         WHERE entity_type = @type AND entity_id = @id
      `)
      .get({ type: entityType, id: entityId });
  }
  return Number(row?.n ?? 0);
}

/**
 * v0.26.31: global history feed. Returns the newest events across the
 * entire audit_log, optionally filtered by entity type and/or user.
 * Used by the new dedicated History page in the sidebar.
 *
 * Caps:
 *   - limit clamped to 1–500 (a single page; the renderer paginates)
 *   - offset accepts arbitrary values for "show me page N"
 *
 * Filters:
 *   - entityType: 'product' | 'brand' | 'category' | 'image' | null
 *     (null = no filter). 'product' here is exact match; if the caller
 *     wants the same product-+-image interleave behaviour the per-entity
 *     view uses, they pass 'product' AND the renderer can fold image
 *     rows that share the same entity_id.
 *   - userId: arbitrary user id string, or null for "any user including
 *     server admin (null user_id)".
 *
 * Index used: idx_audit_log_created_at_desc — see db/index.js. Plenty
 * fast even on a 100k-row table because every query is "DESC ORDER BY
 * indexed column".
 */
/** v0.1.89: the History page's "this Mac / server admin" choice — rows with
 *  no user id. A real user id is a UUID, so it can never collide. */
const NO_USER = '@local';

/**
 * v0.1.89: the shared WHERE for the global feed and its count.
 *
 *   entityType  exact entity_type ('image' rows are a product's photo events)
 *   userId      a user id, or NO_USER for rows written with no caller
 *   since/until epoch ms, inclusive / exclusive
 *   q           text: matches the product's SKU or name, the brand's or
 *               category's name, the action, or a changed value
 *
 * The text search looks the names up in the live tables (an entity's name is
 * never copied onto an audit row — HANDOFF, "An account's name is looked up
 * from the id"), so a deleted product is found by what changed, not its name.
 */
/** Fuel F1: staff and fuel rows are only for callers with fuel.manage (see main/ipc/audit.js). */
const FUEL_ENTITY_SQL = "entity_type <> 'employee' AND substr(entity_type, 1, 5) <> 'fuel_'";
function isFuelEntityType(t) { return t === 'employee' || (typeof t === 'string' && t.startsWith('fuel_')); }

/**
 * Fixed Assets (review M6): rows about asset values and the books are only for
 * callers with assets.view or assets.manage (main/ipc/audit.js), and History's
 * "Clear" keeps them. Branch rows stay visible — branch names are not sensitive.
 */
const ASSET_ENTITY_TYPES = ['fixed_asset', 'asset_event', 'asset_category', 'asset_settings', 'journal_entry', 'gl_account',
  'fx_rate', 'ledger_period', 'accounting_period', 'depreciation_run', 'tax_year', 'stocktake'];
const ASSET_ENTITY_SQL = `entity_type NOT IN (${ASSET_ENTITY_TYPES.map((t) => `'${t}'`).join(', ')})`;
function isAssetEntityType(t) { return ASSET_ENTITY_TYPES.includes(t); }

function recentWhere({ entityType = null, userId = null, since = null, until = null, q = null, hideFuel = false, hideAssets = false } = {}) {
  const wheres = [];
  const params = {};
  if (hideFuel) wheres.push(FUEL_ENTITY_SQL);
  if (hideAssets) wheres.push(ASSET_ENTITY_SQL);
  if (entityType) { wheres.push('entity_type = @entityType'); params.entityType = entityType; }
  if (userId === NO_USER) wheres.push('user_id IS NULL');
  else if (userId) { wheres.push('user_id = @userId'); params.userId = userId; }
  const from = Number(since);
  if (since != null && Number.isFinite(from)) { wheres.push('created_at >= @since'); params.since = from; }
  const to = Number(until);
  if (until != null && Number.isFinite(to)) { wheres.push('created_at < @until'); params.until = to; }
  const text = typeof q === 'string' ? q.trim().slice(0, 200) : '';
  if (text) {
    // LIKE with the user's own % and _ escaped, so "50%" means fifty percent.
    params.q = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    wheres.push(`(
      action LIKE @q ESCAPE '\\'
      OR before_json LIKE @q ESCAPE '\\'
      OR after_json LIKE @q ESCAPE '\\'
      OR (entity_type IN ('product', 'image') AND entity_id IN (
            SELECT id FROM products WHERE sku LIKE @q ESCAPE '\\' OR name LIKE @q ESCAPE '\\'))
      OR (entity_type = 'brand' AND entity_id IN (SELECT id FROM brands WHERE name LIKE @q ESCAPE '\\'))
      OR (entity_type = 'category' AND entity_id IN (SELECT id FROM categories WHERE name LIKE @q ESCAPE '\\'))
    )`);
  }
  return { whereSql: wheres.length ? `WHERE ${wheres.join(' AND ')}` : '', params };
}

function listRecent({ limit = 100, offset = 0, entityType = null, userId = null, since = null, until = null, q = null, hideFuel = false, hideAssets = false } = {}) {
  const db = getDb();
  const cappedLimit  = Math.min(Math.max(1, Number(limit)  || 100), 500);
  const cappedOffset = Math.max(0, Number(offset) || 0);
  const built = recentWhere({ entityType, userId, since, until, q, hideFuel, hideAssets });
  const params = { ...built.params, limit: cappedLimit, offset: cappedOffset };
  const whereSql = built.whereSql;
  const rows = db
    .prepare(`
      SELECT * FROM audit_log
      ${whereSql}
       ORDER BY created_at DESC
       LIMIT @limit OFFSET @offset
    `)
    .all(params);
  return attachEntityNames(db, rows.map(rowToEntry));
}

/**
 * Name every row of the global feed from the live tables, in the same call.
 *
 * The History page used to look names up in the renderer's product list,
 * which only holds the ACTIVE company — so most rows about another
 * company's products said "(deleted product)" while those products were
 * alive and well. Names are still looked up at read time, never copied onto
 * an audit row (HANDOFF: an entity's name follows the live record), but here
 * against every company: one query per entity type for the page's ids.
 *
 * Adds `entity: { exists, sku, name, companyId, companyName }` to each entry.
 * `exists: false` means the row is really gone (or in Recently deleted).
 */
function attachEntityNames(db, entries) {
  const idsOf = (types) => [...new Set(entries.filter((e) => types.includes(e.entityType)).map((e) => e.entityId).filter(Boolean))];
  const lookup = (table, cols, ids) => {
    const map = new Map();
    // SQLite's default variable limit is 999; a page is at most 500 rows.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = db.prepare(`
        SELECT t.id, ${cols}, t.company_id, c.name AS company_name
          FROM ${table} t
          LEFT JOIN companies c ON c.id = t.company_id
         WHERE t.id IN (${chunk.map(() => '?').join(',')})
      `).all(...chunk);
      for (const r of rows) map.set(r.id, r);
    }
    return map;
  };
  let products = new Map();
  let brands = new Map();
  let categories = new Map();
  try {
    products = lookup('products', 't.sku, t.name', idsOf(['product', 'image']));
    brands = lookup('brands', 'NULL AS sku, t.name', idsOf(['brand']));
    categories = lookup('categories', 'NULL AS sku, t.name', idsOf(['category']));
  } catch (err) {
    // A lookup failure must not take the feed down: the renderer falls back
    // to its own lookup when `entity` is absent.
    process.stderr.write(`[auditLog] entity names unavailable: ${err.message}\n`);
    return entries;
  }
  return entries.map((e) => {
    const map = e.entityType === 'product' || e.entityType === 'image' ? products
      : e.entityType === 'brand' ? brands
        : e.entityType === 'category' ? categories : null;
    if (!map) return e;
    const r = map.get(e.entityId);
    return {
      ...e,
      entity: r
        ? { exists: true, sku: r.sku ?? null, name: r.name ?? null, companyId: r.company_id ?? null, companyName: r.company_name ?? null }
        : { exists: false, sku: null, name: null, companyId: null, companyName: null },
    };
  });
}

/**
 * Total count for the global history feed. Used by the History page
 * to render "Showing 1–50 of 12,847" pagination labels.
 */
function countRecent({ entityType = null, userId = null, since = null, until = null, q = null, hideFuel = false, hideAssets = false } = {}) {
  const db = getDb();
  const { whereSql, params } = recentWhere({ entityType, userId, since, until, q, hideFuel, hideAssets });
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`)
    .get(params);
  return Number(row?.n ?? 0);
}

/**
 * v0.33.0: total count + age span of the whole audit_log, for the
 * History page's "X events, oldest N days ago" line + to gate the clear
 * button. Cheap (COUNT + MIN/MAX on the created_at index).
 */
function stats() {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM audit_log')
    .get();
  return {
    total: Number(row?.n ?? 0),
    oldest: row?.oldest ?? null,
    newest: row?.newest ?? null,
  };
}

/**
 * v0.33.0: retention sweep / manual clear. Deletes audit_log rows older
 * than `days` (e.g. 15 / 30 / 90). `days <= 0` (or non-numeric) clears the
 * ENTIRE log. Returns the number of rows removed.
 *
 * Note: SQLite doesn't shrink the DB file on DELETE — the freed pages are
 * reused by future writes. That's fine for a log table; we don't VACUUM
 * (it would lock the DB and isn't worth the stall on a shared server).
 */
function clearOlderThan(days) {
  // Fixed Assets (review M6): rows about asset values and the books are never cleared.
  const db = getDb();
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) {
    const kept = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE NOT (${ASSET_ENTITY_SQL})`).get().n;
    const info = db.prepare(`DELETE FROM audit_log WHERE ${ASSET_ENTITY_SQL}`).run();
    return { deleted: info.changes, kept };
  }
  const cutoff = Date.now() - n * 24 * 60 * 60 * 1000;
  const kept = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE created_at < ? AND NOT (${ASSET_ENTITY_SQL})`).get(cutoff).n;
  const info = db.prepare(`DELETE FROM audit_log WHERE created_at < ? AND ${ASSET_ENTITY_SQL}`).run(cutoff);
  return { deleted: info.changes, kept };
}

module.exports = {
  NO_USER,
  recentWhere,
  isFuelEntityType,
  isAssetEntityType,
  ASSET_ENTITY_TYPES,
  log,
  logUpdate,
  diffPatch,
  listForEntity,
  countForEntity,
  listRecent,
  countRecent,
  stats,
  clearOlderThan,
};
