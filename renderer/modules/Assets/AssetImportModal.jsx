/**
 * Fixed Assets — Import from Excel (AGENTS.md §11): pick file → map columns →
 * review. The file is read with `files:parseWorkbook`; each header is guessed
 * against `assets:importColumns` (key, label, aliases) and shown with one
 * sample value; "Check rows" asks `assets:importPlan` (a dry run: what each
 * row would do, its warnings and errors); "Import" applies the plan's rows with
 * `assets:importApply`. Upserts by tag code; only filled cells change
 * anything; imported assets are drafts. "Download sample" saves a workbook
 * with an Instructions sheet and this company's categories and branches.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, Modal, Pagination, Select, paginate } from '../../components/ui.jsx';
import { Notice } from './AssetsShared.jsx';
import { IMPORT_ACTION, buildImportRows, convertYearsToMonths, errText, eventLabel, guessMapping, sampleValues, yearsIntoMonths } from './assetsModel.js';

export function AssetImportModal({ open, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const [step, setStep] = useState('pick'); // pick | map | review | done
  const [columns, setColumns] = useState([]);
  const [workbook, setWorkbook] = useState(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapping, setMapping] = useState({});
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    if (!open) return;
    setConvertYears(false);
    setStep('pick'); setWorkbook(null); setSheetIdx(0); setMapping({}); setPlan(null); setResult(null); setError(''); setBusy(false); setPage(0);
    window.api.assets.importColumns().then((c) => setColumns(c || [])).catch((err) => setError(errText(err)));
  }, [open]);

  const sheet = workbook?.sheets?.[sheetIdx] || null;
  const samples = useMemo(() => (sheet ? sampleValues(sheet.rows, sheet.headers) : {}), [sheet]);
  const mappedCount = Object.values(mapping).filter(Boolean).length;
  // A header that says years, matched to a months column ("Life (years)" → useful life in months).
  const yearCols = useMemo(() => yearsIntoMonths(mapping), [mapping]);
  const [convertYears, setConvertYears] = useState(false);
  const rows = useMemo(() => {
    const built = sheet ? buildImportRows(sheet.rows, mapping) : [];
    return convertYears ? convertYearsToMonths(built, yearCols.map((c) => c.key)) : built;
  }, [sheet, mapping, convertYears, yearCols]);

  async function pick() {
    setError('');
    try {
      const filePath = await window.api.files.pickWorkbook();
      if (!filePath) return;
      setBusy(true);
      const wb = await window.api.files.parseWorkbook(filePath);
      if (!wb?.sheets?.length) { setError('That file has no sheets to read.'); return; }
      // The sample's first sheet is "Assets"; a workbook with an Instructions sheet first still opens on the data.
      const idx = Math.max(0, wb.sheets.findIndex((s) => /^assets$/i.test(s.name)));
      setWorkbook(wb);
      setSheetIdx(idx);
      setMapping(guessMapping(wb.sheets[idx].headers, columns));
      setStep('map');
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  async function sample() {
    try {
      const path = await window.api.assets.saveImportSample();
      if (path) addToast(`Sample saved to ${path}`, 'success');
    } catch (err) { addToast(`Couldn't save the sample: ${errText(err)}`, 'error'); }
  }
  async function check() {
    if (!rows.length) { setError('No rows with a value in a mapped column.'); return; }
    setBusy(true); setError('');
    try {
      const p = await window.api.assets.importPlan(rows);
      setPlan(p); setPage(0); setStep('review');
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    try {
      const res = await window.api.assets.importApply(rows);
      setResult(res); setStep('done');
      addToast(`Imported ${res.created || 0} new, updated ${res.updated || 0}`, 'success');
      onDone?.();
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }

  const footer = step === 'pick' ? (
    <><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={pick} disabled={busy || !columns.length}>{busy ? 'Reading…' : 'Choose a file…'}</Button></>
  ) : step === 'map' ? (
    <><Button onClick={() => setStep('pick')} disabled={busy}>Back</Button><Button variant="primary" onClick={check} disabled={busy || !mappedCount}>{busy ? 'Checking…' : `Check ${rows.length} row${rows.length === 1 ? '' : 's'}`}</Button></>
  ) : step === 'review' ? (
    <><Button onClick={() => setStep('map')} disabled={busy}>Back</Button><Button variant="primary" onClick={apply} disabled={busy || !(plan?.summary?.create || plan?.summary?.update)}>{busy ? 'Importing…' : `Import ${(plan?.summary?.create || 0) + (plan?.summary?.update || 0)} row${(plan?.summary?.create || 0) + (plan?.summary?.update || 0) === 1 ? '' : 's'}`}</Button></>
  ) : (
    <Button variant="primary" onClick={onClose}>Done</Button>
  );

  const planRows = plan?.rows || [];
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(planRows.length, page, pageSize);

  return (
    <Modal open={open} onClose={onClose} title="Import assets from Excel" size="xl" busy={busy} footer={footer}>
      <ol className="assets-steps" aria-label="Steps">
        {['Pick a file', 'Match the columns', 'Review'].map((label, i) => (
          <li key={label} className={['pick', 'map', 'review'].indexOf(step === 'done' ? 'review' : step) === i ? 'is-active' : ''}>{i + 1}. {label}</li>
        ))}
      </ol>
      {error ? <Notice tone="rose">{error}</Notice> : null}

      {step === 'pick' ? (
        <>
          <p className="assets-modal-text">An .xlsx, .xls or .csv with one asset per row. A row with an existing tag code updates that asset; a blank tag adds a new one with a new tag. Only cells with a value change anything, and new assets come in as drafts — activate them on their page.</p>
          <div className="assets-inline"><Button onClick={sample}>Download sample…</Button><span className="muted">It has an Instructions sheet and your categories and branches.</span></div>
          <h3 className="section-title assets-subhead">The columns it reads</h3>
          <div className="data-table-wrap assets-rules">
            <table className="data-table">
              <thead><tr><th>Column</th><th>What it takes</th></tr></thead>
              <tbody>{columns.map((c) => <tr key={c.key}><td className="assets-nowrap"><strong>{c.label}</strong>{c.draftOnly ? <div className="muted">drafts only</div> : null}</td><td>{c.accepts}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      ) : null}

      {step === 'map' && sheet ? (
        <>
          <div className="toolbar">
            <span className="muted">{workbook.fileName} · {sheet.rowCount} row{sheet.rowCount === 1 ? '' : 's'}</span>
            {workbook.sheets.length > 1 ? (
              <Select aria-label="Sheet" value={String(sheetIdx)} onChange={(e) => { const i = Number(e.target.value); setSheetIdx(i); setMapping(guessMapping(workbook.sheets[i].headers, columns)); }}>
                {workbook.sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
              </Select>
            ) : null}
            <div className="toolbar__spacer" />
            <span className="toolbar__count">{mappedCount} of {sheet.headers.length} columns matched</span>
          </div>
          {yearCols.length ? (
            <Notice tone="amber" title="Years or months?">
              {yearCols.map((c) => `“${c.header}”`).join(', ')} {yearCols.length === 1 ? 'mentions' : 'mention'} years, but {yearCols.length === 1 ? 'goes' : 'go'} into a field counted in MONTHS — 8 would be read as 8 months.
              <label className="assets-check">
                <input type="checkbox" checked={convertYears} onChange={(e) => setConvertYears(e.target.checked)} />
                <span>My file has years — multiply by 12</span>
              </label>
            </Notice>
          ) : null}
          {sheet.looksLikeTitleRow ? <Notice tone="amber">The first row looks like a title, not column names. Put the column names in the first row and pick the file again.</Notice> : null}
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>In your file</th><th>First value</th><th>Goes into</th></tr></thead>
              <tbody>
                {sheet.headers.map((h) => (
                  <tr key={h}>
                    <td><strong>{h}</strong></td>
                    <td className="muted">{samples[h] || '—'}</td>
                    <td>
                      <Select aria-label={`Column for ${h}`} value={mapping[h] || ''} onChange={(e) => {
                        const key = e.target.value;
                        // One file column per field: taking a field frees it elsewhere.
                        setMapping((m) => Object.fromEntries(Object.entries(m).map(([hh, k]) => [hh, hh === h ? key : (key && k === key ? '' : k)])));
                      }}>
                        <option value="">Ignore</option>
                        {columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {step === 'review' && plan ? (
        <>
          <div className="assets-summary">
            <Badge tone="emerald">{plan.summary.create || 0} new</Badge>
            <Badge tone="blue">{plan.summary.update || 0} to update</Badge>
            <Badge tone="slate">{plan.summary.skip || 0} unchanged</Badge>
            <Badge tone={plan.summary.error ? 'rose' : 'slate'}>{plan.summary.error || 0} with errors (skipped)</Badge>
            {plan.summary.warnings ? <Badge tone="amber">{plan.summary.warnings} warning{plan.summary.warnings === 1 ? '' : 's'}</Badge> : null}
          </div>
          <PlanTable rows={planRows.slice(pageStart, pageEnd)} />
          <Pagination total={planRows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      ) : null}

      {step === 'done' && result ? (
        <>
          <div className="assets-summary">
            <Badge tone="emerald">{result.created || 0} added</Badge>
            <Badge tone="blue">{result.updated || 0} updated</Badge>
            <Badge tone="slate">{result.skipped || 0} unchanged</Badge>
            <Badge tone={result.failed ? 'rose' : 'slate'}>{result.failed || 0} failed</Badge>
          </div>
          <p className="muted">New assets are drafts: open each one, check it, and press Activate to put it on the books.</p>
          {(result.rows || []).some((r) => r.errors?.length || r.warnings?.length) ? <PlanTable rows={(result.rows || []).filter((r) => r.errors?.length || r.warnings?.length)} /> : null}
        </>
      ) : null}
    </Modal>
  );
}

function PlanTable({ rows }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr><th className="is-num">Row</th><th>Result</th><th>Tag</th><th>Name</th><th>Notes</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const a = IMPORT_ACTION[r.action] || { label: r.action, tone: 'slate' };
            return (
              <tr key={r.rowNo}>
                <td className="is-num">{r.rowNo}</td>
                <td><Badge tone={a.tone}>{a.label}</Badge></td>
                <td>{r.tagCode || <span className="muted">new tag</span>}</td>
                <td>{r.values?.name || r.name || ''}</td>
                <td>
                  {(r.errors || []).map((e, i) => <div key={`e${i}`} className="assets-error">{e}</div>)}
                  {(r.warnings || []).map((w, i) => <div key={`w${i}`} className="muted">{w}</div>)}
                  {(r.events || []).map((e, i) => <div key={`v${i}`} className="muted">Recorded as an event: {eventLabel(e.kind)}</div>)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
