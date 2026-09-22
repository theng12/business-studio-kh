const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson, prepareOptimisticPatch, nextUpdatedAt } = require('./_util');
const { catalogDesignOnly } = require('../util/catalogModel');

/**
 * v0.1.63 — Catalog templates: the reusable half of a catalog.
 *
 * What was there before: five layouts hard-coded in
 * renderer/modules/CatalogStudio/index.jsx, a preview modal, and a "Use
 * template" button. The layout CONTROLS existed — inside a project's Design tab
 * — but nothing could save them, and nothing could build a new one. The
 * customer's words: "we can't build a template for the catalog too — it doesn't
 * have a builder at all".
 *
 * The rule that makes a template reusable is the same one Social Grid follows
 * (main/db/socialGridTemplates.js): **a template never stores which products.**
 * `catalogDesignOnly()` resets selectionMode / productIds / brandIds /
 * categoryIds before the row is written, so creating a catalog from a template
 * cannot smuggle in the products the template happened to be designed against.
 * The cover's title and subtitle stay out too — those are content, and a
 * template reused three times must not rename three catalogs.
 *
 * Config is stored fully normalized so a row stays self-describing for a later
 * version that has grown new settings.
 */
function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    description: row.description ?? null,
    config: catalogDesignOnly(parseJson(row.config, {})),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function list(companyId) {
  return getDb()
    .prepare('SELECT * FROM catalog_templates WHERE company_id = ? ORDER BY updated_at DESC')
    .all(companyId)
    .map(rowToTemplate);
}

function get(id) {
  return rowToTemplate(getDb().prepare('SELECT * FROM catalog_templates WHERE id = ?').get(id));
}

function create(input) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  const config = catalogDesignOnly(input.config || {});
  getDb()
    .prepare(`INSERT INTO catalog_templates (id, company_id, name, description, config, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.companyId, String(input.name || 'Untitled template').trim(),
      input.description == null ? null : String(input.description), JSON.stringify(config), ts, ts);
  return get(id);
}

function update(id, patch) {
  const current = get(id);
  if (!current) throw new Error('Catalog template not found');
  const editable = prepareOptimisticPatch(current, patch, 'catalogTemplate');
  const nextName = editable.name ?? current.name;
  const nextDescription = editable.description === undefined ? current.description : editable.description;
  // Always designOnly again: a rename or a small patch must not be a way to
  // keep a selection that an older build might have written.
  const nextConfig = editable.config
    ? catalogDesignOnly({ ...current.config, ...editable.config })
    : current.config;
  getDb()
    .prepare('UPDATE catalog_templates SET name = ?, description = ?, config = ?, updated_at = ? WHERE id = ?')
    .run(String(nextName || 'Untitled template').trim(),
      nextDescription == null ? null : String(nextDescription),
      JSON.stringify(nextConfig), nextUpdatedAt(current.updatedAt), id);
  return get(id);
}

function remove(id) {
  return getDb().prepare('DELETE FROM catalog_templates WHERE id = ?').run(id).changes > 0;
}

function duplicate(id) {
  const t = get(id);
  if (!t) throw new Error('Catalog template not found');
  return create({ companyId: t.companyId, name: `${t.name} copy`, description: t.description, config: t.config });
}

module.exports = { list, get, create, update, remove, duplicate };
