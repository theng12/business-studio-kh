const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson } = require('./_util');

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id, companyId: row.company_id, templateId: row.template_id,
    templateName: row.template_name, format: row.format, layoutMode: row.layout_mode,
    productCount: row.product_count, outputPath: row.output_path,
    settings: parseJson(row.settings, {}), status: row.status,
    errorMessage: row.error_message, createdAt: row.created_at,
  };
}

function list(companyId, limit = 100) {
  return getDb().prepare(
    'SELECT * FROM label_runs WHERE company_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(companyId, Math.max(1, Math.min(500, Number(limit) || 100))).map(rowToRun);
}

function create(input) {
  const id = crypto.randomUUID();
  getDb().prepare(`INSERT INTO label_runs
    (id, company_id, template_id, template_name, format, layout_mode, product_count,
     output_path, settings, status, error_message, created_at)
    VALUES (@id,@companyId,@templateId,@templateName,@format,@layoutMode,@productCount,
     @outputPath,@settings,@status,@errorMessage,@createdAt)`
  ).run({ id, companyId: input.companyId, templateId: input.templateId ?? null,
    templateName: input.templateName ?? null, format: input.format || 'pdf',
    layoutMode: input.layoutMode || 'single', productCount: input.productCount || 0,
    outputPath: input.outputPath ?? null, settings: JSON.stringify(input.settings || {}),
    status: input.status || 'completed', errorMessage: input.errorMessage ?? null,
    createdAt: Date.now() });
  return rowToRun(getDb().prepare('SELECT * FROM label_runs WHERE id = ?').get(id));
}

function addItem(runId, input) {
  const id = crypto.randomUUID();
  getDb().prepare(`INSERT INTO label_generation_items
    (id, run_id, product_id, sku, file_path, product_snapshot, template_snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, runId, input.productId ?? null, input.sku ?? null, input.filePath ?? null,
    JSON.stringify(input.productSnapshot || {}), JSON.stringify(input.templateSnapshot || {}), Date.now());
  return id;
}

function remove(id) { return getDb().prepare('DELETE FROM label_runs WHERE id = ?').run(id).changes > 0; }

module.exports = { list, create, addItem, remove };
