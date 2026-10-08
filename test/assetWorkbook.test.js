/**
 * Fixed Assets A2: the workbook builder (main/util/assetWorkbook.js) — seven
 * sheets, money in dollars and whole riel, the "confirm with an accountant"
 * note. Pure — plain `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { buildAssetWorkbook } = require('../main/util/assetWorkbook');

test('seven sheets, figures in dollars, the tax notes carried', () => {
  const { filename, bytes } = buildAssetWorkbook({
    companyName: 'Chea Kim', year: 2026, asOf: '2026-09-30',
    register: { rows: [{ tagCode: 'CK-00013', name: 'Truck', categoryName: 'Trucks', branchName: 'PP1', status: 'in_use', treatment: 'capitalised', costMinor: 2_400_000, accumMinor: 157_500, impairmentMinor: 0, nbvMinor: 2_242_500, unpostedDepreciationMinor: 0 }],
      totals: { costMinor: 2_400_000, accumMinor: 157_500, impairmentMinor: 0, nbvMinor: 2_242_500, unpostedDepreciationMinor: 0 } },
    movements: { rows: [], totals: {} },
    depreciation: { rows: [{ period: '2026-03', categoryName: 'Trucks', branchName: 'PP1', monthMinor: 22_500, catchUpMinor: 0, totalMinor: 22_500 }] },
    additions: { rows: [] },
    tax: { pools: { 3: { label: 'Class 3', openingWdvKhr: 1, openingLabel: 'estimate — confirm with an accountant', additionsKhr: 2, proceedsKhr: 0, baseKhr: 3, rateBp: 2500, depreciationKhr: 1, gainKhr: 0, lossKhr: 0, closingWdvKhr: 2 } },
      perAsset: [], bookVsTax: [], notes: ['Every rate and rule here is to be confirmed with an accountant.'] },
  });
  assert.equal(filename, 'fixed-assets-chea-kim-2026.xlsx');
  const wb = XLSX.read(bytes);
  assert.deepEqual(wb.SheetNames, ['Register', 'Movements', 'Book schedule', 'Tax pools', 'Book vs tax', 'Additions & disposals', 'Notes']);
  const reg = XLSX.utils.sheet_to_json(wb.Sheets.Register, { header: 1 });
  assert.equal(reg[1][9], 24000);
  assert.equal(reg[1][12], 22425);
  const notes = XLSX.utils.sheet_to_json(wb.Sheets.Notes, { header: 1 }).flat().join(' ');
  assert.match(notes, /confirm with an accountant/);
  assert.match(XLSX.utils.sheet_to_json(wb.Sheets['Tax pools'], { header: 1 })[1][2], /estimate/);
});
