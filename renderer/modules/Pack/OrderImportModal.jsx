/**
 * Pick & Pack — daily order import (docs/PICK_AND_PACK_PLAN.md §3.1, §7).
 *
 * The house 3-step wizard: pick file → map columns → review. The column
 * mapping is saved per source (marketplace / chat / paper / sheet / manual), so
 * the next daily import with the same headers goes pick → next → import.
 */

import { useMemo, useState } from 'react';
import { Button, Field, Modal, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { ORDER_FIELDS, ORDER_SOURCES, applySavedMapping, buildOrderRows, mappingReady } from './orderImport.js';

export function OrderImportModal({ open, onClose, onImported }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const [step, setStep] = useState('pick');
  const [source, setSource] = useState('marketplace');
  const [workbook, setWorkbook] = useState(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapping, setMapping] = useState({});
  const [savedMapping, setSavedMapping] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const sheet = workbook?.sheets[sheetIdx] ?? null;
  const headers = useMemo(() => sheet?.headers ?? [], [sheet]);
  const sample = useMemo(() => {
    const out = {};
    for (const header of headers) out[header] = sheet?.rows?.[0]?.[header] ?? '';
    return out;
  }, [sheet, headers]);
  function reset() {
    setStep('pick');
    setSource('marketplace');
    setWorkbook(null);
    setSheetIdx(0);
    setMapping({});
    setSavedMapping(null);
    setPreview(null);
    setBusy(false);
  }

  function close() {
    if (busy) return;
    reset();
    onClose();
  }

  async function loadMappingFor(nextSource, wb) {
    let saved = null;
    try { saved = await window.api.orders.getMapping(nextSource); } catch (_) { saved = null; }
    setSavedMapping(saved);
    const first = wb.sheets[0];
    const next = applySavedMapping(first.headers, saved);
    setMapping(next);
    setWorkbook(wb);
    setSheetIdx(0);
    return { saved, mapping: next };
  }

  async function handlePick() {
    try {
      const filePath = await window.api.files.pickWorkbook();
      if (!filePath) return;
      const wb = await window.api.files.parseWorkbook(filePath);
      if (!wb || !wb.sheets.length) { addToast('Workbook is empty', 'error'); return; }
      const { saved, mapping: next } = await loadMappingFor(source, wb);
      // A saved mapping that still fits the file skips the map screen.
      if (saved && mappingReady(wb.sheets[0].headers, next)) {
        await runPreview(wb.sheets[0], next);
      } else {
        setStep('map');
      }
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function handleSourceChange(next) {
    setSource(next);
    if (!workbook) return;
    const { mapping: nextMapping } = await loadMappingFor(next, workbook);
    setStep('map');
    setMapping(nextMapping);
  }

  async function runPreview(sheetToUse, mappingToUse) {
    setBusy(true);
    try {
      const rows = buildOrderRows(sheetToUse, mappingToUse);
      if (!rows.length) { addToast('No rows with an order reference and SKU', 'error'); return; }
      const res = await window.api.orders.import({ companyId: activeCompanyId, source, rows, dryRun: true });
      setPreview({ ...res, rowCount: rows.length, rows });
      setStep('review');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleGoToReview() {
    if (!sheet) return;
    if (!mappingReady(headers, mapping)) {
      addToast('Map the order reference and item SKU columns before importing.', 'error');
      return;
    }
    await runPreview(sheet, mapping);
  }

  async function handleImport() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await window.api.orders.import({ companyId: activeCompanyId, source, rows: preview.rows, dryRun: false });
      try { await window.api.orders.saveMapping(source, mapping); } catch (_) { /* the import itself succeeded */ }
      addToast(`Imported ${res.created} new and updated ${res.updated} order${res.created + res.updated === 1 ? '' : 's'}`, 'success');
      onImported?.();
      reset();
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <Button onClick={close} disabled={busy}>Cancel</Button>
      {step === 'map' ? <Button onClick={() => setStep('pick')} disabled={busy}>Back</Button> : null}
      {step === 'map' ? <Button variant="primary" onClick={handleGoToReview} disabled={busy}>Next</Button> : null}
      {step === 'review' ? <Button onClick={() => setStep('map')} disabled={busy}>Back</Button> : null}
      {step === 'review' ? <Button variant="primary" onClick={handleImport} disabled={busy}>{busy ? 'Importing…' : 'Import'}</Button> : null}
    </div>
  );

  return (
    <Modal open={open} onClose={close} title="Import orders" footer={footer} size="lg" busy={busy}>
      {step === 'pick' ? (
        <div className="stack">
          <p className="muted">One file can hold many orders. Repeat imports update the same order reference and never blank a field the file does not supply.</p>
          <Field label="Where did this file come from?" hint="The column mapping is remembered for each source.">
            {({ id }) => (
              <Select id={id} value={source} onChange={(e) => handleSourceChange(e.target.value)}>
                {ORDER_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            )}
          </Field>
          <Button variant="primary" onClick={handlePick} disabled={busy}>Pick file…</Button>
          {savedMapping ? <p className="small muted">A saved mapping for this source is ready — pick the file and go straight to review.</p> : null}
        </div>
      ) : null}

      {step === 'map' ? (
        <div className="stack">
          <p className="muted">{sheet?.name ? `Sheet: ${sheet.name}. ` : ''}Check each column. The sample shows the first row.</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Column</th><th>Sample</th><th>Maps to</th></tr>
              </thead>
              <tbody>
                {headers.map((header) => (
                  <tr key={header}>
                    <td>{header}</td>
                    <td className="muted">{String(sample[header] ?? '')}</td>
                    <td>
                      <Select value={mapping[header] || '__skip__'} onChange={(e) => setMapping({ ...mapping, [header]: e.target.value })} aria-label={`Map ${header}`}>
                        {ORDER_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {step === 'review' ? (
        <div className="stack">
          <p><strong>{preview?.created || 0}</strong> new order{(preview?.created || 0) === 1 ? '' : 's'} · <strong>{preview?.updated || 0}</strong> existing updated · <strong>{preview?.linesAdded || 0}</strong> new items</p>
          <p className="small muted">{preview?.rowCount || 0} rows read from the file.</p>
          {preview?.skipped?.length ? (
            <div>
              <p className="small"><strong>Skipped {preview.skipped.length}:</strong></p>
              <ul className="small muted">
                {preview.skipped.slice(0, 8).map((s, i) => <li key={i}>{s.row ? `Row ${s.row}: ` : ''}{s.reason}</li>)}
                {preview.skipped.length > 8 ? <li>…and {preview.skipped.length - 8} more</li> : null}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
