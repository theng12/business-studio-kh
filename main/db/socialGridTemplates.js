const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson, prepareOptimisticPatch, nextUpdatedAt } = require('./_util');
const { designOnly } = require('../util/socialGridModel');

/**
 * v0.1.62 — Social Grid templates: the reusable half of a post.
 *
 * A saved post (main/db/socialGridPresets.js) is "these products, drawn like
 * this". A template is only "drawn like this": the customer could design a
 * square three-up promo and had no way to reuse it — every new post started
 * from the defaults again, and the Product Library had nothing to apply.
 *
 * The one rule that matters here: **a template never stores which products.**
 * `designOnly()` resets every selection key (source, brand/category filters,
 * stock scope, hand-picked ids, cap) to its default before the row is written,
 * so applying a template can never smuggle in a half-remembered product list.
 * It also means a template stays valid when products are added or removed.
 *
 * Config is stored fully normalized, same reasoning as the presets table: a row
 * is read back by a later version that may have grown new fields, so writing
 * the defaults in now keeps it self-describing.
 */
function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    config: designOnly(parseJson(row.config, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function list(companyId) {
  return getDb()
    .prepare('SELECT * FROM social_grid_templates WHERE company_id = ? ORDER BY updated_at DESC')
    .all(companyId)
    .map(rowToTemplate);
}

function get(id) {
  return rowToTemplate(getDb().prepare('SELECT * FROM social_grid_templates WHERE id = ?').get(id));
}

function create(input) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  const config = designOnly(input.config || {});
  getDb()
    .prepare(`INSERT INTO social_grid_templates (id, company_id, name, config, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, input.companyId, String(input.name || 'Untitled template').trim(),
      JSON.stringify(config), ts, ts);
  return get(id);
}

function update(id, patch) {
  const current = get(id);
  if (!current) throw new Error('Social template not found');
  const editable = prepareOptimisticPatch(current, patch, 'socialGridTemplate');
  const nextName = editable.name ?? current.name;
  // Always designOnly again: renaming a template must not be a way to keep a
  // selection that an older build might have written.
  const nextConfig = editable.config
    ? designOnly({ ...current.config, ...editable.config })
    : current.config;
  getDb()
    .prepare('UPDATE social_grid_templates SET name = ?, config = ?, updated_at = ? WHERE id = ?')
    .run(String(nextName || 'Untitled template').trim(), JSON.stringify(nextConfig),
      nextUpdatedAt(current.updatedAt), id);
  return get(id);
}

function remove(id) {
  return getDb().prepare('DELETE FROM social_grid_templates WHERE id = ?').run(id).changes > 0;
}

function duplicate(id) {
  const t = get(id);
  if (!t) throw new Error('Social template not found');
  return create({ companyId: t.companyId, name: `${t.name} copy`, config: t.config });
}

module.exports = { list, get, create, update, remove, duplicate };
