/**
 * Library → Export → Excel workbook: which rows to export (owner, 2026-10-11:
 * "the option for filtered, selection or all rows"). Pure, so the rules are
 * tested without a screen (test/productWorkbook.test.js).
 *
 * The filtered and selected exports send the Library's own ids in its
 * on-screen order; "all" sends none and the server exports the whole company.
 */

export function workbookScopeOptions({ totalCount = 0, filteredIds = [], selectedIds = [] } = {}) {
  const filterIsOn = filteredIds.length < totalCount;
  return [
    {
      scope: 'all',
      label: `All products (${totalCount.toLocaleString()})`,
      hint: 'Every product in this company.',
      count: totalCount,
      disabled: totalCount === 0,
    },
    {
      scope: 'filtered',
      label: `Products matching the current filter (${filteredIds.length.toLocaleString()})`,
      hint: filterIsOn ? 'What the list shows now, in the same order.' : 'No search or filter is on, so this is every product.',
      count: filteredIds.length,
      disabled: !filterIsOn || filteredIds.length === 0,
    },
    {
      scope: 'selection',
      label: `Selected products (${selectedIds.length.toLocaleString()})`,
      hint: selectedIds.length ? 'Only the ticked products, in list order.' : 'Tick products in the list first.',
      count: selectedIds.length,
      disabled: selectedIds.length === 0,
    },
  ];
}

/** The scope to start on: the selection if there is one, else the filter if one is on, else all. */
export function defaultWorkbookScope(options) {
  const usable = (scope) => options.find((o) => o.scope === scope && !o.disabled);
  return (usable('selection') || usable('filtered') || usable('all') || options[0]).scope;
}

/** Arguments for exports:saveProductsWorkbook. */
export function workbookExportArgs({ companyId, scope, filteredIds = [], selectedIds = [] }) {
  if (scope === 'filtered') return { companyId, scope, ids: [...filteredIds] };
  if (scope === 'selection') return { companyId, scope, ids: [...selectedIds] };
  return { companyId, scope: 'all' };
}
