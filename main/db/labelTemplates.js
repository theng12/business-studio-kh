const crypto = require('node:crypto');
const { getDb } = require('./index');
const { parseJson, prepareOptimisticPatch, nextUpdatedAt } = require('./_util');

function rowToTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    description: row.description,
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    backgroundColor: row.background_color,
    elements: parseJson(row.elements, []),
    isStarter: !!row.is_starter,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function list(companyId) {
  return getDb().prepare(
    'SELECT * FROM label_templates WHERE company_id = ? ORDER BY updated_at DESC',
  ).all(companyId).map(rowToTemplate);
}

function get(id) {
  return rowToTemplate(getDb().prepare('SELECT * FROM label_templates WHERE id = ?').get(id));
}

function create(input) {
  const id = crypto.randomUUID();
  const ts = Date.now();
  getDb().prepare(`
    INSERT INTO label_templates
      (id, company_id, name, description, width_mm, height_mm, background_color,
       elements, is_starter, created_at, updated_at)
    VALUES
      (@id, @companyId, @name, @description, @widthMm, @heightMm, @backgroundColor,
       @elements, @isStarter, @createdAt, @updatedAt)
  `).run({
    id,
    companyId: input.companyId,
    name: String(input.name || 'Untitled label').trim(),
    description: input.description ?? null,
    widthMm: Number(input.widthMm) || 50,
    heightMm: Number(input.heightMm) || 30,
    backgroundColor: input.backgroundColor || '#ffffff',
    elements: JSON.stringify(input.elements || []),
    isStarter: input.isStarter ? 1 : 0,
    createdAt: ts,
    updatedAt: ts,
  });
  return get(id);
}

function update(id, patch) {
  const current = get(id);
  if (!current) throw new Error('Label template not found');
  const editable = prepareOptimisticPatch(current, patch, 'labelTemplate');
  const next = { ...current, ...editable };
  getDb().prepare(`
    UPDATE label_templates SET
      name = @name, description = @description, width_mm = @widthMm,
      height_mm = @heightMm, background_color = @backgroundColor,
      elements = @elements, updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    name: String(next.name || 'Untitled label').trim(),
    description: next.description ?? null,
    widthMm: Math.max(5, Number(next.widthMm) || 50),
    heightMm: Math.max(5, Number(next.heightMm) || 30),
    backgroundColor: next.backgroundColor || '#ffffff',
    elements: JSON.stringify(next.elements || []),
    updatedAt: nextUpdatedAt(current.updatedAt),
  });
  return get(id);
}

function remove(id) {
  return getDb().prepare('DELETE FROM label_templates WHERE id = ?').run(id).changes > 0;
}

function duplicate(id) {
  const source = get(id);
  if (!source) throw new Error('Label template not found');
  return create({ ...source, name: `${source.name} copy`, isStarter: false });
}

const STARTERS = [
  {
    name: 'Clean retail label', widthMm: 60, heightMm: 40,
    elements: [
      { id: 'name', type: 'text', field: 'name', x: 4, y: 4, width: 52, height: 7, fontSize: 14, fontWeight: 700, align: 'left' },
      { id: 'sku', type: 'text', field: 'sku', prefix: 'SKU ', x: 4, y: 13, width: 28, height: 5, fontSize: 9 },
      { id: 'price', type: 'price', field: 'priceRetail', x: 34, y: 12, width: 22, height: 8, fontSize: 18, fontWeight: 800, align: 'right', prefix: '$' },
      { id: 'barcode', type: 'barcode', field: 'barcode', x: 4, y: 22, width: 52, height: 13, showText: true },
    ],
  },
  {
    name: 'Compact barcode', widthMm: 50, heightMm: 25,
    elements: [
      { id: 'name', type: 'text', field: 'name', x: 3, y: 2.5, width: 44, height: 5, fontSize: 10, fontWeight: 700, align: 'center' },
      { id: 'barcode', type: 'barcode', field: 'barcode', x: 4, y: 8, width: 42, height: 11, showText: true },
      { id: 'sku', type: 'text', field: 'sku', x: 3, y: 20, width: 44, height: 3, fontSize: 7, align: 'center' },
    ],
  },
  {
    name: 'Product shelf card', widthMm: 90, heightMm: 60,
    elements: [
      { id: 'image', type: 'productImage', x: 4, y: 4, width: 34, height: 42, fit: 'contain' },
      { id: 'name', type: 'text', field: 'name', x: 42, y: 5, width: 44, height: 12, fontSize: 17, fontWeight: 750 },
      { id: 'desc', type: 'text', field: 'description', x: 42, y: 19, width: 44, height: 13, fontSize: 9 },
      { id: 'price', type: 'price', field: 'priceRetail', x: 42, y: 35, width: 44, height: 10, fontSize: 24, fontWeight: 800, prefix: '$' },
      { id: 'barcode', type: 'barcode', field: 'barcode', x: 5, y: 48, width: 80, height: 9, showText: true },
    ],
  },
];

function ensureStarters(companyId) {
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM label_templates WHERE company_id = ?').get(companyId)?.n || 0;
  if (count > 0) return list(companyId);
  for (const starter of STARTERS) create({ ...starter, companyId, isStarter: true });
  return list(companyId);
}

module.exports = { list, get, create, update, remove, duplicate, ensureStarters };
