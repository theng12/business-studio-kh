import { useMemo, useState } from 'react';
import { Button, Modal, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { createNameIdResolver } from '../../lib/nameIdResolver.js';

/* v0.1.65: the target list is built per company.
 *
 * A price group the user created in Settings had no destination here, so the
 * sheet could contain an "Export price" column and the mapper could only call it
 * Skip — the number never reached the product. The builder below appends one
 * target per group (plus a currency target for groups and for retail/wholesale),
 * and one per custom field already in use. */
export function buildProductFields(priceGroups = [], customFieldKeys = []) { return [
  { key: '__skip__',      label: '— Skip —' },
  { key: 'sku',           label: 'SKU *',          required: true },
  { key: 'name',          label: 'Name' },
  { key: 'brand',         label: 'Brand (by name)' },
  { key: 'barcode',       label: 'Barcode' },
  { key: 'secondaryCode', label: 'Secondary code' },
  { key: 'category',      label: 'Category (by name)' },
  { key: 'subcategory',   label: 'Subcategory' },
  { key: 'colorFinish',   label: 'Color / Finish' },
  { key: 'description',   label: 'Description' },
  { key: 'unit',          label: 'Unit' },
  { key: 'variant',       label: 'Variant' },
  { key: 'priceRetail',   label: 'Retail price' },
  { key: 'priceWholesale',label: 'Wholesale price' },
  { key: 'tags',          label: 'Tags (comma-separated)' },
  { key: 'status',        label: 'Status' },
  // v0.49.49: logistics & sourcing — bulk-import the carton + weight data
  // straight off a supplier's packing list so it prefills PO lines later.
  // Supplier (by id) is intentionally NOT importable here — it's a foreign
  // key the user sets per-product via the dropdown; a name column would
  // need fuzzy resolution and risk bad references. The numeric carton /
  // weight fields are the high-value bulk import.
  { key: 'supplierSku',     label: 'Supplier SKU' },
  { key: 'hsCode',          label: 'HS code' },
  { key: 'cartonQty',       label: 'Units per carton' },
  { key: 'cartonWCm',       label: 'Carton width (cm)' },
  { key: 'cartonHCm',       label: 'Carton height (cm)' },
  { key: 'cartonDCm',       label: 'Carton length/depth (cm)' },
  { key: 'weightPerUnitKg', label: 'Weight per unit (kg)' },
  // v0.1.25: units on hand, for the Social Grid filters + sorting.
  { key: 'stockQty',        label: 'Stock on hand' },
  // Price currencies. Retail and wholesale are real columns; a custom group's
  // currency lives inside its `prices` entry.
  { key: 'priceRetailCurrency',    label: 'Retail currency' },
  { key: 'priceWholesaleCurrency', label: 'Wholesale currency' },
  ...priceGroups.flatMap((g) => [
    { key: `price.${g.key}`, label: `${g.label} price` },
    { key: `price.${g.key}.currency`, label: `${g.label} currency` },
  ]),
  ...customFieldKeys.map((key) => ({ key, label: `Custom field · ${key.replace(/^custom\./, '')}` })),
]; }

/** The base list, for callers that only need the labels (and for tests). */
export const PRODUCT_FIELDS = buildProductFields();

export function autoGuess(header, priceGroups = [], customFieldKeys = []) {
  const raw = String(header || '').trim();
  const h = raw.toLowerCase();
  if (!h) return '__skip__';
  /* A custom field column is named after its key, so it maps by exact match
   * before any heuristic can steal it. */
  const custom = customFieldKeys.find((key) => key.toLowerCase() === h || key.slice(7).toLowerCase() === h);
  if (custom) return custom;
  /* Price groups: "Export price", "price export", "Export" and "Export amount"
   * all mean the same column; "Export currency" is the currency beside it.
   * Checked BEFORE the retail/wholesale rules so a group the user named
   * "Wholesale export" is not read as the wholesale column. */
  for (const group of priceGroups) {
    const label = String(group.label || '').toLowerCase();
    const key = String(group.key || '').toLowerCase();
    const names = [label, key].filter(Boolean);
    const isCurrency = names.some((n) => h === `${n} currency` || h === `currency ${n}` || h === `${n} ccy`);
    if (isCurrency) return `price.${group.key}.currency`;
    const isAmount = names.some((n) => h === `${n} price` || h === `${n} amount` || h === n
      || h === `price ${n}` || h === `price(${n})` || h === `${n} (price)`);
    if (isAmount) return `price.${group.key}`;
  }
  if (h === 'sku' || h === 'code' || h === 'item code') return 'sku';
  if (h === 'name' || h === 'product' || h === 'product name') return 'name';
  if (h === 'brand') return 'brand';
  if (h === 'barcode' || h === 'bar code' || h === 'ean' || h === 'upc') return 'barcode';
  // v0.49.49: logistics & sourcing. These come BEFORE the generic
  // "supplier* → secondaryCode" rule so "supplier sku"/"supplier code"
  // resolve to the dedicated field instead of the legacy alt-SKU column.
  if (h === 'supplier sku' || h === 'supplier code' || h === 'factory code' || h === 'factory sku' || h === 'vendor sku' || h === 'vendor code') return 'supplierSku';
  if (h === 'hs code' || h === 'hscode' || h === 'hs_code' || h === 'hs' || h === 'tariff' || h === 'tariff code' || h === 'hts') return 'hsCode';
  if (h === 'carton qty' || h === 'qty/ctn' || h === 'qty per carton' || h === 'units per carton' || h === 'pcs/carton' || h === 'pcs/ctn' || h === 'pcs per carton' || h.includes('per carton') || h.includes('units/carton')) return 'cartonQty';
  if ((h.includes('carton') || h.includes('ctn')) && (h.includes('width') || h === 'ctn w' || h.endsWith(' w'))) return 'cartonWCm';
  if ((h.includes('carton') || h.includes('ctn')) && (h.includes('height') || h === 'ctn h' || h.endsWith(' h'))) return 'cartonHCm';
  if ((h.includes('carton') || h.includes('ctn')) && (h.includes('length') || h.includes('depth') || h === 'ctn l' || h.endsWith(' l') || h.endsWith(' d'))) return 'cartonDCm';
  // Per-unit weight only — avoid matching a bare "weight" / "gross weight"
  // (usually carton GW, not per-unit) so we don't silently feed the wrong
  // number into weight-based cost allocation.
  if (h === 'unit weight' || h === 'weight per unit' || h === 'weight/pc' || h === 'weight per pc' || h === 'net weight per pc' || h.includes('weight per unit') || h.includes('weight/unit')) return 'weightPerUnitKg';
  if (h.startsWith('secondary') || h === 'alt sku' || h === 'alt code' || h.startsWith('supplier')) return 'secondaryCode';
  // v0.1.25: stock on hand. Deliberately placed AFTER the carton rules above,
  // so "qty/ctn" and "units per carton" still resolve to cartonQty rather
  // than being read as on-hand stock — those two numbers mean opposite things
  // and silently swapping them would corrupt the PO cost allocation.
  if (h === 'stock' || h === 'stock on hand' || h === 'stock qty' || h === 'stock quantity' || h === 'on hand' || h === 'inventory' || h === 'qty' || h === 'quantity' || h === 'available' || h.includes('on hand')) return 'stockQty';
  if (h === 'category') return 'category';
  if (h === 'subcategory' || h === 'sub-category') return 'subcategory';
  if (h.includes('color') || h.includes('colour') || h.includes('finish')) return 'colorFinish';
  if (h === 'description' || h === 'desc') return 'description';
  if (h === 'unit') return 'unit';
  if (h === 'variant') return 'variant';
  if (h === 'tags') return 'tags';
  if (h === 'status') return 'status';
  if (h.includes('retail') && h.includes('currency')) return 'priceRetailCurrency';
  if (h.includes('wholesale') && h.includes('currency')) return 'priceWholesaleCurrency';
  if (h.includes('retail') && h.includes('price')) return 'priceRetail';
  if (h.includes('wholesale') && h.includes('price')) return 'priceWholesale';
  if (h === 'price') return 'priceRetail';
  return '__skip__';
}

/**
 * Whether to hint that row 1 may be a title rather than the headers.
 *
 * A single-value first row followed by a richer second row is ambiguous: it is
 * either a title above the headers, or a valid header row with blank trailing
 * cells. Surface it as a conditional hint either way. Hiding it when the single
 * value happens to be recognized (a title of "Code", say) silently imported the
 * real header row as data; commanding deletion when it is a real header row
 * destroyed the header. The copy is conditional and the hint does not block.
 */
export function shouldSuggestTitleRow(sheet) {
  return !!sheet?.looksLikeTitleRow;
}

export function ImportModal({ open, onClose }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  const refreshBrands = useAppStore((s) => s.refreshBrands);
  const refreshCategories = useAppStore((s) => s.refreshCategories);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);
  const createBrand = useAppStore((s) => s.createBrand);
  const createCategory = useAppStore((s) => s.createCategory);
  const addToast = useAppStore((s) => s.addToast);

  const [step, setStep] = useState('pick'); // 'pick' | 'map' | 'preview' | 'review'
  const [workbook, setWorkbook] = useState(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapping, setMapping] = useState({});
  /* v0.1.65: build the mapping targets from THIS company — one per price group
   * it has defined, one per custom field its products already use. A `?? []`
   * because component tests stub the store with only what a case needs. */
  const importCompanies = useAppStore((s) => s.companies);
  const priceGroups = useMemo(
    () => ((importCompanies ?? []).find((c) => c.id === activeCompanyId)?.priceGroups) ?? [],
    [importCompanies, activeCompanyId],
  );
  /* Custom fields have no company-level registry — they exist because a sheet
   * or the user put them on a product — so the columns offered are the ones the
   * loaded products already carry. Read once per open: the list is a
   * convenience, not something that must track every later edit. */
  const [customFieldKeys] = useState(() => {
    const keys = new Set();
    for (const product of (useAppStore.getState?.().products ?? [])) {
      for (const key of Object.keys(product.customFields ?? {})) keys.add(`custom.${key}`);
    }
    return Array.from(keys).sort();
  });
  const productFields = useMemo(
    () => buildProductFields(priceGroups, customFieldKeys),
    [priceGroups, customFieldKeys],
  );

  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  // v0.33.0: batched-apply progress { done, total } | null.
  const [applyProgress, setApplyProgress] = useState(null);
  // Preview state. `preview` holds the dry-run result; `conflictPolicy`
  // is editable on the preview screen and the rerun-on-change updates
  // the preview without committing.
  const [preview, setPreview] = useState(null);
  const [conflictPolicy, setConflictPolicy] = useState('merge'); // 'merge' | 'overwrite' | 'skip'
  // Cached row payload so we don't rebuild it when re-previewing under a
  // different conflict policy.
  const [cachedRows, setCachedRows] = useState(null);
  /* v0.1.27: the parsed rows are cached so "Preview" then "Apply" does not
   * re-read the workbook — but they are a snapshot of ONE column mapping, and
   * the cache was never invalidated when the mapping changed. So: preview,
   * click Back, remap a column, preview again → the second preview (and the
   * import itself) still used the FIRST mapping, quietly putting the old
   * column's values into the new field. Any change to the mapping now drops the
   * cache. */
  function applyMapping(next) {
    setCachedRows(null);
    setMapping(next);
  }

  function reset() {
    setStep('pick');
    setWorkbook(null);
    setSheetIdx(0);
    setMapping({});
    setResult(null);
    setPreview(null);
    setConflictPolicy('merge');
    setCachedRows(null);
    setStep('pick');
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handlePick() {
    try {
      const filePath = await window.api.files.pickWorkbook();
      if (!filePath) return;
      const wb = await window.api.files.parseWorkbook(filePath);
      if (!wb || wb.sheets.length === 0) {
        addToast('Workbook is empty', 'error');
        return;
      }
      setWorkbook(wb);
      const headers = wb.sheets[0].headers;
      const guessed = {};
      headers.forEach((h) => { guessed[h] = autoGuess(h, priceGroups, customFieldKeys); });
      setMapping(guessed);
      setSheetIdx(0);
      setStep('map');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleDownloadSample() {
    try {
      const saved = await window.api.samples.generateProductSheet();
      if (saved) addToast(`Saved to ${saved}`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  const sheet = workbook?.sheets[sheetIdx] ?? null;

  const skuMapped = useMemo(
    () => sheet ? sheet.headers.some((h) => mapping[h] === 'sku') : false,
    [sheet, mapping],
  );

  function toNumber(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function buildRows() {
    const rows = [];
    // One resolver per preview run. The `brands` / `categories` arrays above
    // are captured for THIS render and do not change when createBrand() /
    // createCategory() refresh the store mid-run, so without a per-run cache a
    // file whose Brand column repeats a name would create it once per ROW —
    // thousands of redundant IPC round trips on a large import. See
    // renderer/lib/nameIdResolver.js.
    const resolveBrandId = createNameIdResolver(brands, (name) => createBrand({ name }));
    const resolveCategoryId = createNameIdResolver(categories, (name) => createCategory({ name }));
    for (const row of sheet.rows) {
      const out = {};
      for (const header of sheet.headers) {
        const field = mapping[header];
        if (!field || field === '__skip__') continue;
        const raw = row[header];
        /* A mapped-but-blank cell is kept as an explicit null rather than
         * dropping the key. The conflict policy is applied server-side and
         * needs that distinction: Merge ignores a null/empty value, while
         * Overwrite clears the existing value — which is what its label
         * promises. Dropping the key here silently made Overwrite behave like
         * Merge for every blank cell. A column mapped to "Skip" is still
         * omitted entirely. */
        const blank = raw === '' || raw == null;

        if (field === 'brand') {
          out.brandId = blank ? null : await resolveBrandId(raw);
        } else if (field === 'category') {
          out.categoryId = blank ? null : await resolveCategoryId(raw);
        } else if (field === 'tags') {
          out.tags = blank ? [] : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
        } else if (field === 'priceRetail' || field === 'priceWholesale'
          // v0.49.49: numeric logistics fields coerce the same way.
          || field === 'cartonQty' || field === 'cartonWCm' || field === 'cartonHCm'
          || field === 'cartonDCm' || field === 'weightPerUnitKg'
          // v0.1.25: stock on hand. Merge ignores a null, so an empty stock
          // column still leaves the existing count alone.
          || field === 'stockQty') {
          out[field] = blank ? null : toNumber(raw);
        } else if (field.startsWith('price.')) {
          /* A custom price group: `price.<key>` is the amount, and
           * `price.<key>.currency` the currency beside it. They arrive as
           * separate columns, so they are folded into ONE `prices` entry here —
           * a blank amount stays explicit as null so Overwrite can clear the
           * group while Merge leaves it alone. */
          const rest = field.slice('price.'.length);
          const isCurrency = rest.endsWith('.currency');
          const groupKey = isCurrency ? rest.slice(0, -'.currency'.length) : rest;
          const entry = { ...(out.prices?.[groupKey] || {}) };
          if (isCurrency) {
            if (!blank) entry.currency = String(raw).trim().toUpperCase();
          } else {
            entry.amount = blank ? null : toNumber(raw);
          }
          out.prices = { ...(out.prices || {}), [groupKey]: entry };
        } else if (field.startsWith('custom.')) {
          out.customFields = { ...(out.customFields || {}), [field.slice('custom.'.length)]: blank ? null : String(raw).trim() };
        } else if (field === 'status') {
          /* status is NOT NULL (default 'active'). A blank or unrecognized
           * value must leave the existing value alone — emitting null would
           * fail the whole row's update ("NOT NULL constraint failed"),
           * silently skipping every other field in that row under Overwrite.
           * New rows default to 'active' in create(). */
          const v = blank ? '' : String(raw).trim().toLowerCase();
          if (['active', 'inactive', 'draft'].includes(v)) out.status = v;
        } else {
          out[field] = blank ? null : String(raw).trim();
        }
      }
      if (out.sku) rows.push(out);
    }
    return rows;
  }

  /**
   * Build rows + run a dry-run to compute the preview. Brand/category name→id
   * creation happens during buildRows, so even the preview reflects what'll
   * be on disk. The preview itself is a no-op (no writes), so re-running it
   * under a different conflict policy is cheap.
   */
  async function handleGoToPreview() {
    if (!skuMapped) {
      addToast('Map the SKU column before importing.', 'error');
      return;
    }
    setBusy(true);
    try {
      const rows = cachedRows ?? await buildRows();
      if (!cachedRows) setCachedRows(rows);
      const res = await window.api.products.bulkUpsert(activeCompanyId, rows, {
        dryRun: true,
        conflictPolicy,
      });
      setPreview({ ...res, rowsConsidered: rows.length, sourceRowCount: sheet.rowCount });
      // The dry-run may have auto-created brands/categories during buildRows
      // — refresh those lookups so the diff shows resolved names.
      await Promise.all([refreshBrands(), refreshCategories()]);
      setStep('preview');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Re-run the dry-run with the newly-picked conflict policy. */
  async function handleChangePolicy(nextPolicy) {
    if (nextPolicy === conflictPolicy) return;
    setConflictPolicy(nextPolicy);
    setBusy(true);
    try {
      const rows = cachedRows ?? await buildRows();
      const res = await window.api.products.bulkUpsert(activeCompanyId, rows, {
        dryRun: true,
        conflictPolicy: nextPolicy,
      });
      setPreview({ ...res, rowsConsidered: rows.length, sourceRowCount: sheet.rowCount });
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Commit the changes shown in the preview.
   *
   * v0.33.0: chunk the write into batches instead of one giant bulkUpsert.
   * A single call with thousands of rows is one huge RPC payload + one long
   * server transaction that can stall a client connection (and stalls the
   * server's event loop for everyone). Looping ~250-row batches keeps each
   * call small + fast, lets us show real progress, and recovers gracefully
   * if one batch fails. Recurses (loops) until every row is committed.
   */
  async function handleApplyChanges() {
    if (!cachedRows) {
      addToast('Preview missing — go back and try again', 'error');
      return;
    }
    setBusy(true);
    const BATCH_SIZE = 250;
    const total = cachedRows.length;
    const agg = { inserted: 0, updated: 0, skips: [], rowsConsidered: total, conflictPolicy };
    try {
      for (let i = 0; i < total; i += BATCH_SIZE) {
        const batch = cachedRows.slice(i, i + BATCH_SIZE);
        setApplyProgress({ done: i, total });
        const res = await window.api.products.bulkUpsert(activeCompanyId, batch, {
          dryRun: false,
          conflictPolicy,
        });
        agg.inserted += res.inserted || 0;
        agg.updated += res.updated || 0;
        if (Array.isArray(res.skips)) agg.skips.push(...res.skips);
      }
      setApplyProgress({ done: total, total });
      setResult(agg);
      // One refresh after all batches land (not per-batch) so the Library
      // re-pulls the catalog once.
      await Promise.all([refreshBrands(), refreshCategories(), refreshProducts(), refreshDashboard()]);
      setStep('review');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
      setApplyProgress(null);
    }
  }

  const footer =
    step === 'pick' ? (
      <Button onClick={handleClose}>Cancel</Button>
    ) : step === 'map' ? (
      <>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="primary" disabled={!skuMapped || busy} onClick={handleGoToPreview}>
          {busy ? 'Building preview…' : `Preview ${sheet?.rowCount ?? 0} row${sheet?.rowCount === 1 ? '' : 's'}`}
        </Button>
      </>
    ) : step === 'preview' ? (
      <>
        <Button onClick={() => setStep('map')} disabled={busy}>← Back</Button>
        <Button
          variant="primary"
          disabled={busy || !preview}
          onClick={handleApplyChanges}
        >
          {busy
            ? (applyProgress ? `Applying ${applyProgress.done}/${applyProgress.total}…` : 'Applying…')
            : `Apply ${(preview?.changes ?? []).filter((c) => c.action === 'insert' || c.action === 'update').length} change${(preview?.changes ?? []).filter((c) => c.action === 'insert' || c.action === 'update').length === 1 ? '' : 's'}`}
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={handleClose}>Done</Button>
    );

  return (
    <Modal open={open} onClose={handleClose} title="Import Excel / CSV" footer={footer} size="xl">
      {step === 'pick' ? (
        <>
          <p>Imports run as three steps: pick file → map columns → review.</p>
          <p className="ws-hint">Rows are matched to existing products by SKU. Blank cells leave existing data alone.</p>
          <div className="import-pick">
            <Button variant="primary" onClick={handlePick}>Choose file…</Button>
            <span className="muted">or</span>
            <Button variant="ghost" onClick={handleDownloadSample}>Download sample</Button>
          </div>
        </>
      ) : step === 'map' && sheet ? (
        <>
          {workbook.sheets.length > 1 ? (
            <div className="field" style={{ marginBottom: 'var(--s-3)' }}>
              <span className="field__label">Sheet</span>
              <Select
                value={String(sheetIdx)}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setSheetIdx(next);
                  const headers = workbook.sheets[next].headers;
                  const guessed = {};
                  headers.forEach((h) => { guessed[h] = autoGuess(h, priceGroups, customFieldKeys); });
                  applyMapping(guessed);
                }}
              >
                {workbook.sheets.map((s, i) => (
                  <option key={s.name} value={i}>{s.name} ({s.rowCount} row{s.rowCount === 1 ? '' : 's'})</option>
                ))}
              </Select>
            </div>
          ) : null}

          {shouldSuggestTitleRow(sheet) ? (
            <p className="ws-hint" role="status">
              Row 1 has a single value. This import reads the <strong>first row</strong> as the
              column names — if that value is a title rather than column names, delete that row
              (or move the column names to row 1), save, and choose the file again.
            </p>
          ) : null}

          <p className="ws-hint">
            <strong>How updates work.</strong> New SKUs are inserted; existing SKUs are updated.
            Only the fields you supply a value for are overwritten. Under Merge, blank cells leave
            existing data alone; Overwrite clears them. Images and variants are never touched by import.
          </p>

          <div className="import-table-wrap">
            <table className="import-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Sample</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {sheet.headers.map((h) => {
                  const sample = sheet.rows[0]?.[h] ?? '';
                  return (
                    <tr key={h}>
                      <td className="import-table__col">{h}</td>
                      <td className="import-table__sample">{String(sample).slice(0, 60)}</td>
                      <td>
                        <Select
                          value={mapping[h] ?? '__skip__'}
                          onChange={(e) => applyMapping({ ...mapping, [h]: e.target.value })}
                        >
                          {productFields.map((f) => (
                            <option key={f.key} value={f.key}>{f.label}</option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!skuMapped ? (
            <p className="field__error">Map at least one column to <strong>SKU</strong> before importing.</p>
          ) : null}
        </>
      ) : step === 'preview' && preview ? (
        <ImportPreview
          preview={preview}
          conflictPolicy={conflictPolicy}
          onChangePolicy={handleChangePolicy}
          busy={busy}
        />
      ) : step === 'review' && result ? (
        <ImportReview result={result} />
      ) : null}
    </Modal>
  );
}

/**
 * Preview screen — shown after dry-running the bulk-upsert. Lets the user
 * see exactly what'll change before committing, and pick how to handle
 * conflicts.
 *
 * Three policies, surfaced as a segmented control:
 *   - Merge     — only fill empty fields on existing rows (safest, default)
 *   - Overwrite — apply every mapped field, including blanks (use when the
 *                 import IS the source of truth)
 *   - Skip      — leave existing rows alone; only inserts new SKUs
 *
 * Each row's diff is collapsible. The list is virtual-ish (capped to 200
 * visible) so a 10K-row import doesn't choke the modal.
 */
/* Exported for the rendered regression in test/productImportPreview.test.js. */
const POLICY_HELP = {
  merge: {
    label: 'Merge',
    detail: 'Existing products keep any value your file leaves blank. Only the cells your file fills in are written.',
  },
  overwrite: {
    label: 'Overwrite',
    detail: 'Every mapped column is written to existing products — a blank cell in your file CLEARS that value.',
  },
  skip: {
    label: 'Skip existing',
    detail: 'Existing products are left exactly as they are. Only brand-new SKUs are added.',
  },
};

export function ImportPreview({ preview, conflictPolicy, onChangePolicy, busy }) {
  const changes = preview.changes ?? [];
  const counts = changes.reduce((acc, c) => {
    acc[c.action] = (acc[c.action] ?? 0) + 1;
    return acc;
  }, {});
  const inserts = changes.filter((c) => c.action === 'insert');
  const updates = changes.filter((c) => c.action === 'update');
  const noChanges = changes.filter((c) => c.action === 'no_change');
  const skips = changes.filter((c) => c.action === 'skip');
  // Rows the parser read but buildRows dropped because the value in the mapped
  // SKU column was blank. They used to disappear silently: a 3-row file whose
  // SKU column didn't line up reported "out of 1 row" with no explanation, which
  // reads as "the import is broken" rather than "2 rows had no SKU".
  const sourceRowCount = preview.sourceRowCount ?? preview.rowsConsidered;
  const droppedNoSku = Math.max(0, sourceRowCount - preview.rowsConsidered);
  // Concrete feedback for the two policies that change existing rows: how many
  // existing values this run would blank. Only Overwrite can clear a value, so
  // this is the number that distinguishes it from Merge.
  const clearedValues = conflictPolicy === 'overwrite'
    ? changes.reduce((n, c) => n + (Array.isArray(c.diffs)
      ? c.diffs.filter((d) => d.newValue === null || d.newValue === ''
        || (Array.isArray(d.newValue) && d.newValue.length === 0)).length
      : 0), 0)
    : 0;

  return (
    <div className="import-preview">
      <div className="import-preview__head">
        <div className="import-preview__counts">
          <strong>{counts.insert ?? 0} new</strong>,{' '}
          <strong>{counts.update ?? 0} updated</strong>
          {(counts.no_change ?? 0) > 0 ? <>, <span className="muted">{counts.no_change} unchanged</span></> : null}
          {(counts.skip ?? 0) > 0 ? <>, <span className="muted">{counts.skip} skipped</span></> : null}
          {' '}out of {preview.rowsConsidered} row{preview.rowsConsidered === 1 ? '' : 's'}.
        </div>
        {droppedNoSku > 0 ? (
          <p className="field__error" role="status">
            {droppedNoSku} of {sourceRowCount} row{sourceRowCount === 1 ? '' : 's'} had no SKU and
            {' '}were skipped. Check that the column mapped to <strong>SKU *</strong> is the one
            holding each product&apos;s SKU, and that every data row has a value there.
          </p>
        ) : null}

        <div className="import-preview__policy">
          <span className="import-preview__policy-label">On conflict</span>
          <div className="ws-toolbar__group">
            <button
              type="button"
              className={`segment${conflictPolicy === 'merge' ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => onChangePolicy('merge')}
              title="Only fill empty fields on existing rows. Safest — won't blank out values you didn't include in the import."
            >Merge</button>
            <button
              type="button"
              className={`segment${conflictPolicy === 'overwrite' ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => onChangePolicy('overwrite')}
              title="Apply every mapped field. Blank cells in the import overwrite existing values."
            >Overwrite</button>
            <button
              type="button"
              className={`segment${conflictPolicy === 'skip' ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => onChangePolicy('skip')}
              title="Leave existing rows alone. Only insert new SKUs."
            >Skip existing</button>
          </div>
        </div>
        <p className="import-preview__policy-help" role="status">
          <strong>{POLICY_HELP[conflictPolicy].label}:</strong> {POLICY_HELP[conflictPolicy].detail}
          {clearedValues > 0 ? (
            <> This run will clear <strong>{clearedValues}</strong> existing
              {' '}value{clearedValues === 1 ? '' : 's'} to blank.</>
          ) : null}
        </p>
      </div>

      <p className="muted import-preview__hint">
        Click <strong>Apply</strong> below to commit. No products have been written yet
        — but any new brand or category named in your file has already been added, so
        the preview can show you the right names.
      </p>

      {inserts.length > 0 ? (
        <DiffGroup
          title={`New products to add (${inserts.length})`}
          tone="emerald"
          rows={inserts}
        />
      ) : null}
      {updates.length > 0 ? (
        <DiffGroup
          title={`Existing products to update (${updates.length})`}
          tone="amber"
          rows={updates}
        />
      ) : null}
      {noChanges.length > 0 ? (
        <DiffGroup
          title={`Already up to date (${noChanges.length}) — no changes needed`}
          tone="slate"
          rows={noChanges}
          collapsed={inserts.length > 0 || updates.length > 0}
        />
      ) : null}
      {skips.length > 0 ? (
        <DiffGroup
          title={`Skipped (${skips.length}) — see reasons`}
          tone="rose"
          rows={skips}
        />
      ) : null}
    </div>
  );
}

function DiffGroup({ title, tone, rows, collapsed = false }) {
  const visible = rows.slice(0, 200);
  return (
    <details className={`import-preview__group import-preview__group--${tone}`} open={!collapsed}>
      <summary><strong>{title}</strong></summary>
      <ul className="import-preview__list">
        {visible.map((r, i) => (
          <li key={i} className="import-preview__row">
            <div className="import-preview__row-head">
              <code>{r.sku || `(row ${(r.rowIndex ?? 0) + 1})`}</code>
              {r.reason ? <span className="muted"> — {r.reason}</span> : null}
            </div>
            {Array.isArray(r.diffs) && r.diffs.length > 0 ? (
              <table className="import-preview__diffs">
                <tbody>
                  {r.diffs.map((d, j) => (
                    <tr key={j}>
                      <td className="import-preview__field">{d.field}</td>
                      <td className="import-preview__old">{fmtValue(d.oldValue)}</td>
                      <td className="import-preview__arrow">→</td>
                      <td className="import-preview__new">{fmtValue(d.newValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </li>
        ))}
        {rows.length > visible.length ? (
          <li className="muted">…and {rows.length - visible.length} more</li>
        ) : null}
      </ul>
    </details>
  );
}

function fmtValue(v) {
  if (v === null || v === undefined || v === '') return <span className="muted">(empty)</span>;
  if (Array.isArray(v)) return v.length === 0 ? <span className="muted">(empty)</span> : v.join(', ');
  return String(v);
}

/**
 * Review screen shown after a bulk-upsert finishes. Surfaces:
 *   - top-line totals (added / updated / rows considered)
 *   - any per-row skips grouped by reason category, so the user can
 *     act on them (re-import after fixing, or accept them)
 *
 * Skip categories come from the main process — see bulkUpsert in
 * main/db/products.js. We map them to friendly labels + actionable hints.
 */
const SKIP_CATEGORY_INFO = {
  duplicate: {
    label: 'Duplicate SKU within the file',
    hint:  'These rows share a SKU with another row already imported in this run. The earlier row\'s fields win; later rows that supply different values were skipped to avoid silent overwrites.',
  },
  bad_reference: {
    label: 'Bad brand / category reference',
    hint:  'These rows reference a brand or category that doesn\'t exist and couldn\'t be auto-created. Check the column mapping or pre-create the missing brand / category.',
  },
  missing_field: {
    label: 'Required field empty',
    hint:  'A column the database requires (e.g. SKU) was blank on these rows.',
  },
  missing_sku: {
    label: 'Missing SKU',
    hint:  'These rows had no SKU value, so they couldn\'t be matched or inserted.',
  },
  error: {
    label: 'Other errors',
    hint:  'Unexpected errors. Check the message for each row.',
  },
};

function ImportReview({ result }) {
  const skips = Array.isArray(result.skips) ? result.skips : [];
  const grouped = skips.reduce((acc, s) => {
    const key = s.category ?? 'error';
    (acc[key] = acc[key] ?? []).push(s);
    return acc;
  }, {});
  const orderedKeys = ['duplicate', 'bad_reference', 'missing_field', 'missing_sku', 'error']
    .filter((k) => grouped[k]?.length);

  return (
    <>
      <p>
        <strong>{result.inserted} new added</strong>,{' '}
        <strong>{result.updated} existing updated</strong>
        {skips.length > 0 ? <>, <strong>{skips.length} skipped</strong></> : null}
        {' '}out of {result.rowsConsidered} row{result.rowsConsidered === 1 ? '' : 's'}.
      </p>
      <p className="muted">Brands and categories referenced by name were created if they didn't exist.</p>

      {orderedKeys.length > 0 ? (
        <div className="import-review__skips">
          {orderedKeys.map((k) => {
            const info = SKIP_CATEGORY_INFO[k] ?? SKIP_CATEGORY_INFO.error;
            const rows = grouped[k];
            return (
              <details key={k} className="import-review__group">
                <summary>
                  <strong>{info.label}</strong>
                  <span className="muted"> · {rows.length} row{rows.length === 1 ? '' : 's'}</span>
                </summary>
                <p className="import-review__hint">{info.hint}</p>
                <ul className="import-review__list">
                  {rows.slice(0, 100).map((r, i) => (
                    <li key={i}>
                      <code>{r.sku || `(row ${r.rowIndex + 1})`}</code>
                      {r.reason ? <span className="muted"> — {r.reason}</span> : null}
                    </li>
                  ))}
                  {rows.length > 100 ? <li className="muted">…and {rows.length - 100} more</li> : null}
                </ul>
              </details>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
