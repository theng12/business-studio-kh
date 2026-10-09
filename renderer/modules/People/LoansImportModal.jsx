import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { hasCap } from '../../lib/capabilities.js';
import { Badge, Button, Modal, Pagination, Select, paginate } from '../../components/ui.jsx';
import { formatMinor, pendingAfterFailure } from './loansModel.js';
import { buildImportRows, formatImportCell, guessMapping, hasUniqueTargets, importApplyOutcome, isImportCompanyCurrent, makeImportOperation, retryImportOperation, sampleValues } from './loanImportModel.js';

const errorText = (error) => error?.message || String(error);
const PER_PAGE = 50;

export function LoansImportModal({ open, companyId, pendingOperation, onClose, onPendingOperation, onDone }) {
  const addToast = useAppStore((state) => state.addToast);
  const activeCompanyId = useAppStore((state) => state.activeCompanyId);
  const canManage = hasCap(useUserCaps(), 'loans.manage');
  const [step, setStep] = useState('pick');
  const [columns, setColumns] = useState([]);
  const [workbook, setWorkbook] = useState(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState({});
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [operation, setOperation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PER_PAGE);
  const contextRef = useRef(null);
  if (!contextRef.current || Object.entries({ companyId, open, activeCompanyId, canManage }).some(([key, value]) => contextRef.current[key] !== value)) {
    contextRef.current = { companyId, open, activeCompanyId, canManage };
  }
  const context = contextRef.current; // Identity distinguishes A → B → A and close → reopen.
  const initialized = useRef(null);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const reviewed = useRef(null);
  const applying = useRef(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const current = (request) => mounted.current && request === contextRef.current && request.open && request.canManage
    && isImportCompanyCurrent(request.companyId, useAppStore.getState().activeCompanyId);
  const sheets = workbook?.sheets || [];
  const sheet = sheets[sheetIndex] || null;
  const samples = useMemo(() => sampleValues(sheet?.rows, sheet?.headers), [sheet]);
  const rows = useMemo(() => buildImportRows(sheet?.rows, mapping), [sheet, mapping]);
  const planRows = plan?.rows || [];
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(planRows.length, page, pageSize);
  const hasErrors = (plan?.summary?.error || 0) > 0 || plan?.valid === false || planRows.some((row) => row.action === 'error' || row.errors?.length);
  const importable = plan?.valid === true && !hasErrors && (plan?.summary?.create || 0) + (plan?.summary?.update || 0) > 0;
  const locked = Boolean(operation || uncertain);

  useEffect(() => {
    if (!current(context) || initialized.current === context) return;
    initialized.current = context;
    const sequence = ++requestSequence.current;
    reviewed.current = null;
    const requestedCompany = companyId;
    setStep(pendingOperation ? 'review' : 'pick');
    setWorkbook(null);
    setColumns([]);
    setSheetIndex(0);
    setMapping({});
    setPlan(null);
    setResult(null);
    setError('');
    setBusy(false);
    setUncertain(Boolean(pendingOperation));
    setOperation(pendingOperation || null);
    setPage(0);
    window.api.loans.importColumns({ companyId: requestedCompany }).then((value) => {
      if (current(context)) setColumns(value || []);
    }).catch((err) => {
      if (current(context)) setError(errorText(err));
    });
    if (pendingOperation) {
      window.api.loans.importPlan({ rows: pendingOperation.rows, companyId: requestedCompany }).then((value) => {
        if (current(context) && sequence === requestSequence.current) setPlan(value);
      }).catch((err) => {
        if (current(context) && sequence === requestSequence.current) setError(errorText(err));
      });
    }
  }, [context, companyId, pendingOperation]);

  function invalidatePlan() {
    requestSequence.current += 1;
    reviewed.current = null;
    setPlan(null);
    setBusy(false);
  }

  async function pickFile() {
    if (!current(context) || locked) return;
    invalidatePlan();
    const sequence = requestSequence.current;
    setError('');
    setBusy(true);
    try {
      const filePath = await window.api.files.pickWorkbook();
      if (!current(context) || sequence !== requestSequence.current || !filePath) return;
      const parsed = await window.api.files.parseWorkbook(filePath);
      if (!current(context) || sequence !== requestSequence.current) return;
      if (!parsed?.sheets?.length) { setError('That file has no sheets to read.'); return; }
      const index = Math.max(0, parsed.sheets.findIndex((item) => /^loans$/i.test(item.name)));
      setWorkbook(parsed);
      setSheetIndex(index);
      setMapping(guessMapping(parsed.sheets[index].headers, columns));
      setStep('map');
    } catch (err) {
      if (current(context) && sequence === requestSequence.current) setError(errorText(err));
    } finally { if (current(context) && sequence === requestSequence.current) setBusy(false); }
  }

  async function downloadSample() {
    if (!current(context)) return;
    setError('');
    const requestedCompany = companyId;
    try {
      const path = await window.api.loans.saveImportSample({ companyId: requestedCompany });
      if (!current(context)) return;
      if (path) addToast(`Sample saved to ${path}`, 'success');
    } catch (err) {
      if (current(context)) setError(errorText(err));
    }
  }

  async function checkRows() {
    if (!current(context) || locked) return;
    if (!rows.length) { setError('No rows have a value in a mapped column.'); return; }
    if (!hasUniqueTargets(mapping)) { setError('Each import field can be mapped from only one file column.'); return; }
    setBusy(true);
    setError('');
    const sequence = ++requestSequence.current;
    reviewed.current = null;
    const snapshot = makeImportOperation(companyId, rows).rows;
    const requestedCompany = companyId;
    try {
      const value = await window.api.loans.importPlan({ rows: snapshot, companyId: requestedCompany });
      if (!current(context) || sequence !== requestSequence.current) return;
      reviewed.current = { rows: snapshot, plan: value, context };
      setPlan(value);
      setPage(0);
      setStep('review');
    } catch (err) {
      if (current(context) && sequence === requestSequence.current) setError(errorText(err));
    } finally { if (current(context) && sequence === requestSequence.current) setBusy(false); }
  }

  async function applyRows() {
    if (!current(context) || applying.current?.context === context) return;
    if (!operation && (!importable || reviewed.current?.plan !== plan || reviewed.current?.context !== context)) return;
    setBusy(true);
    setError('');
    const requestedCompany = companyId;
    const command = operation || makeImportOperation(requestedCompany, reviewed.current.rows, globalThis.crypto?.randomUUID?.());
    if (!command.operationId) {
      setBusy(false);
      setError('This device could not create a safe operation ID. Please reload and try again.');
      return;
    }
    reviewed.current = null;
    requestSequence.current += 1;
    setOperation(command);
    setUncertain(true);
    const attempt = { context, command };
    applying.current = attempt;
    try {
      onPendingOperation(command);
      const value = await window.api.loans.importApply(retryImportOperation(command));
      const outcome = importApplyOutcome(value);
      if (outcome === 'unknown') {
        if (!current(context)) return;
        setOperation(command);
        setUncertain(true);
        setError('The import result could not be confirmed. Retry this exact batch with the same operation key.');
        return;
      }
      // Bookkeeping is company-scoped, not a UI callback: settle even after close/revocation.
      onPendingOperation(null, requestedCompany, command);
      if (!current(context)) return;
      setOperation(null);
      setUncertain(false);
      if (outcome === 'applied') {
        setResult(value);
        setStep('done');
        addToast(`Opening balances imported: ${value.created || 0} new, ${value.updated || 0} updated, ${value.skipped || 0} unchanged.`, 'success');
        onDone?.(requestedCompany);
      } else if (outcome === 'rejected') {
        setPlan({ valid: false, summary: { ...(plan?.summary || {}), error: value.failed || value.rows?.filter((row) => row.action === 'error').length || 1 }, rows: value.rows || [] });
        setStep('review');
        setError('The batch was not applied. Correct every error and check the rows again.');
      }
    } catch (err) {
      // Already retained before IPC. An older failed attempt must not resurrect a resolved batch.
      let failure = err;
      if (pendingAfterFailure(command, err) === null) {
        try {
          onPendingOperation(null, requestedCompany, command);
          if (!current(context)) return;
          setOperation(null);
          setUncertain(false);
          setError(errorText(err));
          return;
        } catch (storageError) { failure = storageError; }
      }
      if (!current(context)) return;
      setOperation(command);
      setUncertain(true);
      setError(`The import result could not be confirmed: ${errorText(failure)}. Retry this exact batch with the same operation key.`);
    } finally {
      if (applying.current === attempt) applying.current = null;
      if (current(context)) setBusy(false);
    }
  }

  const reviewBack = () => {
    if (!current(context) || locked) return;
    invalidatePlan();
    if (sheet) setStep('map');
    else { setPlan(null); setStep('pick'); }
  };
  const footer = step === 'pick' ? <><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={pickFile} disabled={busy || !columns.length}>{busy ? 'Reading…' : 'Choose a file…'}</Button></>
    : step === 'map' ? <><Button onClick={() => setStep('pick')} disabled={busy}>Back</Button><Button variant="primary" onClick={checkRows} disabled={busy || locked || !Object.values(mapping).some(Boolean)}>{busy ? 'Checking…' : `Check ${rows.length} row${rows.length === 1 ? '' : 's'}`}</Button></>
      : step === 'review' ? <><Button onClick={reviewBack} disabled={busy || locked}>{sheet ? 'Back' : 'Choose a corrected file'}</Button><Button variant="primary" onClick={applyRows} disabled={busy || (!locked && !importable)}>{busy ? 'Importing…' : locked ? 'Retry the same import' : `Import ${((plan?.summary?.create || 0) + (plan?.summary?.update || 0))} row${((plan?.summary?.create || 0) + (plan?.summary?.update || 0)) === 1 ? '' : 's'}`}</Button></>
        : <Button variant="primary" onClick={onClose}>Done</Button>;

  return <Modal open={open} onClose={onClose} title="Import opening loan balances" size="xl" busy={busy} footer={footer}>
    <ol aria-label="Import steps">
      {['Pick a file', 'Match columns', 'Review'].map((label, index) => <li key={label}>{['pick', 'map', 'review'].indexOf(step === 'done' ? 'review' : step) === index ? <strong>{label}</strong> : label}</li>)}
    </ol>
    {error ? <p className="field__error" role="alert">{error}</p> : null}

    {step === 'pick' ? <>
      <p>An opening balance records the remaining debt as of a past month end. Imported loans remain drafts. Approval records the opening balance; import does not disburse cash or invent past repayments.</p>
      <p>Money cells are integer USD cents or whole KHR riel. For USD, 10,000 means $100.00. KHR values are riel. The importer never converts between currencies.</p>
      <div className="toolbar"><Button onClick={downloadSample} disabled={busy}>Download sample…</Button><span className="muted">Includes the required columns and an Instructions sheet.</span></div>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Column</th><th>Accepted values</th></tr></thead><tbody>{columns.map((column) => <tr key={column.key}><td><strong>{column.label}</strong></td><td>{column.accepts}</td></tr>)}</tbody></table></div>
    </> : null}

    {step === 'map' && sheet ? <>
      <div className="toolbar"><span className="muted">{workbook.fileName} · {sheet.rowCount} row{sheet.rowCount === 1 ? '' : 's'}</span>
        {sheets.length > 1 ? <Select aria-label="Sheet" value={String(sheetIndex)} onChange={(event) => { if (!current(context) || locked) return; invalidatePlan(); const index = Number(event.target.value); setSheetIndex(index); setMapping(guessMapping(sheets[index].headers, columns)); }} disabled={busy || locked}>{sheets.map((item, index) => <option key={`${item.name}-${index}`} value={index}>{item.name}</option>)}</Select> : null}
        <div className="toolbar__spacer" /><span className="toolbar__count">{Object.values(mapping).filter(Boolean).length} of {sheet.headers.length} columns matched</span>
      </div>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>In your file</th><th>First value</th><th>Goes into</th></tr></thead><tbody>
        {sheet.headers.map((header, index) => {
          const sampleRow = (sheet.rows || []).find((row) => row && String(row[header] ?? '').trim() !== '');
          const value = samples[header];
          const currencyHeader = Object.entries(mapping).find(([, key]) => key === 'currency')?.[0];
          const currency = String(sampleRow?.[currencyHeader] || 'USD').toUpperCase();
          return <tr key={`${header}-${index}`}><td><strong>{header || '(blank header)'}</strong></td><td className="muted">{value === '' ? '—' : formatImportCell(value, mapping[header], currency)}</td><td><Select aria-label={`Column for ${header || `column ${index + 1}`}`} value={mapping[header] || ''} disabled={busy || locked} onChange={(event) => {
            if (!current(context) || locked) return;
            invalidatePlan();
            const target = event.target.value;
            setMapping((previous) => Object.fromEntries(Object.entries(previous).map(([name, key]) => [name, name === header ? target : (target && key === target ? '' : key)])));
          }}><option value="">Ignore</option>{columns.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}</Select></td></tr>;
        })}
      </tbody></table></div>
      {!hasUniqueTargets(mapping) ? <p className="field__error">Map each import field from one file column only.</p> : null}
    </> : null}

    {step === 'review' ? <>
      {uncertain ? <div className="card" role="status"><strong>Import result not confirmed</strong><p>The exact rows and operation key are retained. Retry this same request to resolve it before editing or importing anything else for this company.</p></div> : null}
      {plan ? <>
        <div className="toolbar"><Badge tone="emerald">{plan.summary?.create || 0} new drafts</Badge><Badge tone="blue">{plan.summary?.update || 0} draft updates</Badge><Badge tone="slate">{plan.summary?.skip || 0} unchanged</Badge><Badge tone={hasErrors ? 'rose' : 'slate'}>{plan.summary?.error || 0} errors</Badge></div>
        {hasErrors ? <p className="field__error">Every row must be valid before the batch can be applied. No rows will be imported while errors remain.</p> : <p className="muted">Review every row. Applying creates or updates drafts only; approval remains a separate loan action.</p>}
        <div className="data-table-wrap"><table className="data-table"><thead><tr><th className="is-num">Row</th><th>Result</th><th>Loan number</th><th>Currency</th><th className="is-num">Original principal</th><th className="is-num">Opening principal</th><th className="is-num">Unpaid interest</th><th>Issues</th></tr></thead><tbody>
          {planRows.slice(pageStart, pageEnd).map((row, index) => <tr key={`${row.rowNo ?? pageStart + index}-${row.loanNo || row.values?.loanNo || ''}`}>
            <td className="is-num">{row.rowNo}</td><td><Badge tone={row.action === 'create' ? 'emerald' : row.action === 'update' ? 'blue' : row.action === 'skip' ? 'slate' : 'rose'}>{row.action}</Badge></td>
            <td>{row.loanNo || row.values?.loanNo || '—'}</td><td>{row.values?.currency || '—'}</td>
            <td className="is-num">{Number.isSafeInteger(row.values?.originalPrincipalMinor) ? formatMinor(row.values.originalPrincipalMinor, row.values.currency) : '—'}</td>
            <td className="is-num">{Number.isSafeInteger(row.values?.currentPrincipalMinor) ? formatMinor(row.values.currentPrincipalMinor, row.values.currency) : '—'}</td>
            <td className="is-num">{Number.isSafeInteger(row.values?.unpaidInterestMinor) ? formatMinor(row.values.unpaidInterestMinor, row.values.currency) : '—'}</td>
            <td>{(row.errors || []).map((message, i) => <div key={`e${i}`} className="field__error">{message}</div>)}{(row.warnings || []).map((message, i) => <div key={`w${i}`} className="muted">{message}</div>)}</td>
          </tr>)}
        </tbody></table></div>
        <Pagination total={planRows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(0); }} />
      </> : <p className="muted">Loading the retained batch preview…</p>}
    </> : null}

    {step === 'done' && result ? <>
      <div className="toolbar"><Badge tone="emerald">{result.created || 0} new drafts</Badge><Badge tone="blue">{result.updated || 0} updated drafts</Badge><Badge tone="slate">{result.skipped || 0} unchanged</Badge></div>
      <p>Opening balances were recorded on drafts. Approve each loan separately to add the opening balance to its ledger.</p>
    </> : null}
  </Modal>;
}
