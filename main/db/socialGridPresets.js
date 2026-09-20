const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson, prepareOptimisticPatch, nextUpdatedAt } = require('./_util');
const { DEFAULTS, normalizeConfig } = require('../util/socialGridModel');

function rowToPreset(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    config: normalizeConfig(parseJson(row.config, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastExportedAt: row.last_exported_at,
  };
}

function list(companyId) {
  return getDb()
    .prepare('SELECT * FROM social_grid_presets WHERE company_id = ? ORDER BY updated_at DESC')
    .all(companyId)
    .map(rowToPreset);
}

function get(id) {
  return rowToPreset(getDb().prepare('SELECT * FROM social_grid_presets WHERE id = ?').get(id));
}

function create(input) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  // Store the fully-normalized config, not the raw input: a preset is read
  // back on a later version that may have added fields, and writing defaults
  // in now means the row is self-describing.
  const config = normalizeConfig({ ...DEFAULTS, ...(input.config || {}) });
  getDb()
    .prepare(`INSERT INTO social_grid_presets (id, company_id, name, config, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, input.companyId, String(input.name || 'Untitled post').trim(),
      JSON.stringify(config), ts, ts);
  return get(id);
}

function update(id, patch) {
  const current = get(id);
  if (!current) throw new Error('Post preset not found');
  const editable = prepareOptimisticPatch(current, patch, 'socialGridPreset');
  const nextName = editable.name ?? current.name;
  const nextConfig = editable.config ? normalizeConfig({ ...current.config, ...editable.config }) : current.config;
  getDb()
    .prepare(`UPDATE social_grid_presets SET name = ?, config = ?, updated_at = ? WHERE id = ?`)
    .run(String(nextName || 'Untitled post').trim(), JSON.stringify(nextConfig),
      nextUpdatedAt(current.updatedAt), id);
  return get(id);
}

function markExported(id) {
  const current = get(id);
  if (!current) return null;
  const exportedAt = Date.now();
  getDb().prepare('UPDATE social_grid_presets SET last_exported_at = ?, updated_at = ? WHERE id = ?')
    .run(exportedAt, nextUpdatedAt(current.updatedAt), id);
  return get(id);
}

function remove(id) {
  return getDb().prepare('DELETE FROM social_grid_presets WHERE id = ?').run(id).changes > 0;
}

function duplicate(id) {
  const p = get(id);
  if (!p) throw new Error('Post preset not found');
  return create({ companyId: p.companyId, name: `${p.name} copy`, config: p.config });
}

module.exports = { list, get, create, update, markExported, remove, duplicate };
