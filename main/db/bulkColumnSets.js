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

function duplicate(id) {
  const set = get(id);
  if (!set) throw new Error('Column set not found');
  return create({ companyId: set.companyId, name: `${set.name} copy`, columns: set.columns });
}

module.exports = { list, get, create, update, remove, duplicate, normalizeColumns };
