const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson, prepareOptimisticPatch, nextUpdatedAt } = require('./_util');
const { normalizeCatalogConfig } = require('../util/catalogModel');

function rowToProject(row) {
  if (!row) return null;
  return { id: row.id, companyId: row.company_id, name: row.name,
    description: row.description, config: parseJson(row.config, {}),
    createdAt: row.created_at, updatedAt: row.updated_at, lastExportedAt: row.last_exported_at };
}
function list(companyId) { return getDb().prepare('SELECT * FROM catalog_projects WHERE company_id = ? ORDER BY updated_at DESC').all(companyId).map(rowToProject); }
function get(id) { return rowToProject(getDb().prepare('SELECT * FROM catalog_projects WHERE id = ?').get(id)); }
function create(input) {
  const id = crypto.randomUUID(); const ts = Date.now();
  /* v0.1.63: run every new project through the shared model, so a project
   * created from a template carries a complete, clamped config rather than
   * whatever subset the template happened to define. Existing rows are NOT
   * re-normalized on read — that would silently change how old catalogs print. */
  const incoming = input.config || {};
  const config = normalizeCatalogConfig({
    ...incoming,
    // The cover title is the project's own name unless the caller supplied one
    // explicitly. Merging (rather than spreading the incoming config over a
    // default cover) is what keeps a template's `cover.enabled` WITHOUT losing
    // the title — the whole cover object used to be replaced.
    cover: { title: input.name || 'Product Catalog', ...(incoming.cover || {}) },
  });
  getDb().prepare('INSERT INTO catalog_projects (id, company_id, name, description, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.companyId, String(input.name || 'Untitled catalog').trim(), input.description ?? null, JSON.stringify(config), ts, ts);
  return get(id);
}
function update(id, patch) {
  const current = get(id); if (!current) throw new Error('Catalog project not found');
  const editable = prepareOptimisticPatch(current, patch, 'catalogProject');
  const next = { ...current, ...editable, config: { ...current.config, ...(editable.config || {}) } };
  getDb().prepare('UPDATE catalog_projects SET name = ?, description = ?, config = ?, updated_at = ? WHERE id = ?')
    .run(String(next.name || 'Untitled catalog').trim(), next.description ?? null,
      JSON.stringify(next.config), nextUpdatedAt(current.updatedAt), id);
  return get(id);
}
function markExported(id) {
  const current = get(id); if (!current) return null;
  getDb().prepare('UPDATE catalog_projects SET last_exported_at = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), nextUpdatedAt(current.updatedAt), id);
  return get(id);
}
function remove(id) { return getDb().prepare('DELETE FROM catalog_projects WHERE id = ?').run(id).changes > 0; }
function duplicate(id) { const p = get(id); if (!p) throw new Error('Catalog project not found'); return create({ ...p, name: `${p.name} copy` }); }
module.exports = { list, get, create, update, markExported, remove, duplicate };
