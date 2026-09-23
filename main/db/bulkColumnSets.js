const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson, prepareOptimisticPatch, nextUpdatedAt } = require('./_util');

/**
 * v0.1.71 — Bulk table column sets.
 *
 * The bulk edit table's columns are a catalogue (one entry per product field,
 * per price-group amount/currency, per custom field). This table remembers a
 * NAMED selection of those keys so the same view can be recalled on another
 * Mac: the owner runs two Macs and a client Mac, so a localStorage-only
 * preference would not travel. Company-scoped, so each business keeps its own
 * saved views.
 *
 * A set is just `columns`: an ORDERED JSON array of catalogue keys. It is
 * deliberately NOT validated against the catalogue here — the catalogue is a
 * renderer concern (custom fields and price groups are dynamic, and the CLI
 * renderer knows what exists). Unknown/removed keys are dropped on read by
 * `normalizeColumns` only for type/duplicate safety; the editor ignores any
 * key the catalogue does not currently offer, so a set saved before a custom
 * field was deleted stays usable instead of failing to load.
 *
 * Additive on purpose: CREATE TABLE IF NOT EXISTS on the normal boot path in
 * main/db/index.js, no SCHEMA_VERSION bump (AGENTS.md section 14).
 */
function normalizeColumns(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * v0.1.72: the width map is `{ [columnKey]: px }`. Only positive finite
 * numbers survive, coerced to whole pixels — the renderer additionally clamps
 * each value to its column's floor/ceiling on read, so a stale or hostile map
 * can never collapse a column. Same forgiving-read posture as normalizeColumns.
 */
function normalizeWidths(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawKey, rawPx] of Object.entries(value)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    const px = Number(rawPx);
    if (!key || !Number.isFinite(px) || px <= 0) continue;
    out[key] = Math.round(px);
  }
  return out;
}

function rowToSet(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    columns: normalizeColumns(parseJson(row.columns, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function list(companyId) {
  return getDb()
    .prepare('SELECT * FROM bulk_column_sets WHERE company_id = ? ORDER BY updated_at DESC')
    .all(companyId)
    .map(rowToSet);
}

function get(id) {
  return rowToSet(getDb().prepare('SELECT * FROM bulk_column_sets WHERE id = ?').get(id));
}

function create(input) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb()
    .prepare(`INSERT INTO bulk_column_sets (id, company_id, name, columns, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, input.companyId, String(input.name || 'Untitled set').trim(),
      JSON.stringify(normalizeColumns(input.columns)), ts, ts);
  return get(id);
}

function update(id, patch) {
  const current = get(id);
  if (!current) throw new Error('Column set not found');
  const editable = prepareOptimisticPatch(current, patch, 'bulkColumnSet');
  const nextName = editable.name ?? current.name;
  const nextColumns = Object.prototype.hasOwnProperty.call(editable, 'columns')
    ? normalizeColumns(editable.columns)
    : current.columns;
  getDb()
    .prepare('UPDATE bulk_column_sets SET name = ?, columns = ?, updated_at = ? WHERE id = ?')
    .run(String(nextName || 'Untitled set').trim(), JSON.stringify(nextColumns),
      nextUpdatedAt(current.updatedAt), id);
  return get(id);
}

function remove(id) {
  return getDb().prepare('DELETE FROM bulk_column_sets WHERE id = ?').run(id).changes > 0;
}

/**
 * v0.1.72: the remembered column widths for one company. Returns `null` when
 * this company has never stored a layout (so the renderer knows to keep its
 * localStorage cache rather than adopt an empty map), or the normalized map.
 */
function getWidths(companyId) {
  const row = getDb()
    .prepare('SELECT widths FROM bulk_column_widths WHERE company_id = ?')
    .get(companyId);
  if (!row) return null;
  return normalizeWidths(parseJson(row.widths, {}));
}

/**
 * v0.1.72: upsert the whole width map for a company. An EMPTY map deletes the
 * row instead of storing `'{}'` — so "Reset columns" clears the DB row as well
 * as the localStorage cache, and the next Mac to open the table falls back to
 * the type defaults. Returns the stored map, or null after a delete.
 */
function setWidths(companyId, widths) {
  const next = normalizeWidths(widths);
  const db = getDb();
  if (Object.keys(next).length === 0) {
    db.prepare('DELETE FROM bulk_column_widths WHERE company_id = ?').run(companyId);
    return null;
  }
  db.prepare(`INSERT INTO bulk_column_widths (company_id, widths, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(company_id) DO UPDATE SET
                widths = excluded.widths,
                updated_at = excluded.updated_at`)
    .run(companyId, JSON.stringify(next), new Date().toISOString());
  return getWidths(companyId);
}

/**
 * Copy a set as "<name> copy", uniquifying with a numeric suffix when that
 * name is already taken in the same company — so a duplicate is always
 * findable in the menu instead of shadowing an existing set.
 */
function duplicate(id) {
  const set = get(id);
  if (!set) throw new Error('Column set not found');
  const taken = new Set(list(set.companyId).map((s) => s.name));
  const base = `${set.name} copy`;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
  return create({ companyId: set.companyId, name, columns: set.columns });
}

module.exports = {
  list, get, create, update, remove, duplicate,
  getWidths, setWidths, normalizeColumns, normalizeWidths,
};
