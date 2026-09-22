/**
 * v0.1.65: the import sample sheet is built from the company, not hard-coded.
 *
 * The customer added a price group, went to import his price list, and found no
 * column for it — the workbook was a fixed header list written before price
 * groups existed. AGENTS.md section 11 asks for the sample to carry "this org's
 * price groups, custom fields, and the full canonical column set".
 *
 * These cases read the real workbook back with the same library the importer
 * uses, so they check what the user will actually open in Excel.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { writeProductSampleWorkbook } = require('../main/fileHandler');

function build(options) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'msk-sample-')), 'sample.xlsx');
  writeProductSampleWorkbook(file, options);
  const wb = XLSX.readFile(file);
  const headers = XLSX.utils.sheet_to_json(wb.Sheets.Products, { header: 1, defval: '' })[0].map(String);
  const row = XLSX.utils.sheet_to_json(wb.Sheets.Products, { defval: '' })[0] || {};
  const instructions = XLSX.utils.sheet_to_json(wb.Sheets.Instructions, { header: 1, defval: '' });
  return { headers, row, instructions };
}

test('a company with no price groups gets the canonical sheet', () => {
  const { headers, row } = build({});
  for (const header of ['SKU', 'Brand', 'Name', 'Retail price', 'Wholesale price', 'Stock on hand']) {
    assert.ok(headers.includes(header), `canonical column ${header} is missing`);
  }
  assert.ok(!headers.includes('Export price'), 'no phantom group column');
  assert.equal(row['Retail price'], 12.5);
  assert.equal(row['Retail currency'], 'USD');
});

test('every price group gets a price column AND a currency column', () => {
  const { headers, row, instructions } = build({
    priceGroups: [{ key: 'export', label: 'Export' }, { key: 'dealer', label: 'Dealer net' }],
  });
  assert.ok(headers.includes('Export price'), 'the new price group has no column — the reported bug');
  assert.ok(headers.includes('Export currency'), 'a group price needs somewhere for its currency');
  assert.ok(headers.includes('Dealer net price'));
  assert.ok(headers.includes('Dealer net currency'));
  // The columns sit next to each other and carry a usable sample.
  assert.equal(headers.indexOf('Export currency'), headers.indexOf('Export price') + 1);
  assert.equal(row['Export price'], 4.75);
  assert.equal(row['Export currency'], 'USD');
  // And the Instructions sheet explains them, naming the group.
  const flat = instructions.map((r) => r.join(' | ')).join('\n');
  assert.match(flat, /Export price/);
  assert.match(flat, /Export price group|“Export” price group/);
});

test('custom fields the company already uses become columns', () => {
  const { headers, row, instructions } = build({ customFields: ['custom.material', 'custom.voltage'] });
  assert.ok(headers.includes('custom.material'));
  assert.ok(headers.includes('custom.voltage'));
  assert.equal(row['custom.material'], '');
  assert.match(instructions.map((r) => r.join(' ')).join('\n'), /custom\.material/);
});

test('custom price groups and custom fields do not disturb the canonical columns', () => {
  const plain = build({}).headers;
  const rich = build({ priceGroups: [{ key: 'export', label: 'Export' }], customFields: ['custom.size'] }).headers;
  // Everything the plain sheet had is still there, in the same order.
  const filtered = rich.filter((h) => !['Export price', 'Export currency', 'custom.size'].includes(h));
  assert.deepEqual(filtered, plain);
});

test('two downloads of the same company produce the same sheet', () => {
  const options = { priceGroups: [{ key: 'b', label: 'B' }, { key: 'a', label: 'A' }] };
  assert.deepEqual(build(options).headers, build(options).headers);
});
