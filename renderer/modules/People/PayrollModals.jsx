import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { hasCap } from '../../lib/capabilities.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { Button, Field, Input, Modal, Pagination, Select, Textarea, paginate } from '../../components/ui.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { useHrTick } from './hrHooks.js';
import { commandBook, createRunPayload, dateLabel, defaultPayDate, decisionPayload, errorText, guardRun, isDefiniteRejection, lastEndedPeriod, minorToInput, moneyLabel, paymentPayload, periodChoices, requestScope, runActions, statutoryOverrideForm, todayKey } from './payrollUiModel.js';

// Durable storage retains only unresolved command payloads across app restarts,
// never full payslips. Acquisition is guarded inside commandBook; salary UI stays gated.
export const pendingPayrollCommands = commandBook(undefined, () => window.localStorage);
const storeCaps = s => s.appMode === 'client' ? (s.clientConnection?.user?.caps || []) : ['*'];
const storeKey = s => `${s.activeCompanyId || ''}|${JSON.stringify(storeCaps(s))}`;

export function usePayrollCaps() {
  const caps = useUserCaps();
  // General navigation grants a loading fallback; salary screens fail closed.
  const unknown = useAppStore(s => s.appMode === 'client' && !Array.isArray(s.clientConnection?.user?.caps));
  return unknown ? [] : caps;
}

/** Rechecks the live store before state/toast/dialog changes; subscription invalidates A-B-A. */
export function usePayrollRequests(companyId, contextKey = '') {
  const caps = usePayrollCaps();
  const key = `${companyId}|${contextKey}|${JSON.stringify(caps)}`;
  const scopeRef = useRef(null);
  if (!scopeRef.current) scopeRef.current = requestScope(key);
  const renderedKey = useRef(key);
  renderedKey.current = key;
  scopeRef.current.bind(key);
  const addToast = useAppStore(s => s.addToast);
  useEffect(() => {
    const scope = scopeRef.current;
    // A fresh scope also handles React's strict-effect remount.
    scope.bind(key);
    let context = storeKey(useAppStore.getState());
    const off = useAppStore.subscribe(state => {
      const next = storeKey(state);
      if (next !== context) { scope.bind(`invalid:${next}`); context = next; }
    });
    return () => { off(); scope.bind(`unmounted:${key}`); };
  }, [key]);
  const current = useCallback(ticket => scopeRef.current.current(ticket) && renderedKey.current === ticket.key &&
    useAppStore.getState().activeCompanyId === companyId && hasCap(storeCaps(useAppStore.getState()), 'payroll.manage'), [companyId]);
  // Timer callbacks must reach their async catch/finally after a switch.
  // Dispatch enforces the live context below; begin only captures a ticket.
  const begin = useCallback(lane => scopeRef.current.begin(lane), []);
  const invoke = useCallback(async (method, payload, { financial = false, guard = value => value } = {}) => {
    if (renderedKey.current !== key || useAppStore.getState().activeCompanyId !== companyId || !hasCap(storeCaps(useAppStore.getState()), 'payroll.manage')) throw new Error('Company or payroll permission changed');
    if (payload.companyId !== companyId) throw new Error('Payroll request belongs to another company');
    const api = window.api?.payroll;
    if (typeof api?.[method] !== 'function') throw new Error(`Payroll method ${method} is unavailable`);
    const call = async input => guard(await api[method](input));
    return financial ? pendingPayrollCommands.send(method, payload, call) : call(payload);
  }, [companyId, key]);
  const failure = useCallback((ticket, error) => {
    if (current(ticket)) addToast(errorText(error), 'error');
    else console.error('Payroll request failed after context changed:', error);
  }, [current, addToast]);
  return useMemo(() => ({ key, current, begin, invoke, failure }), [key, current, begin, invoke, failure]);
}

export function PayrollError({ message, onRetry }) {
  if (!message) return null;
  return <div className="hr-note" role="alert"><p>{message}</p>{onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : null}</div>;
}

export function PayrollPagination({ total, pager }) {
  const range = paginate(total, pager.page, pager.pageSize);
  return <Pagination total={total} {...range} pageSize={pager.pageSize} onPageChange={pager.setPage}
    onPageSizeChange={size => { pager.setPageSize(size); pager.setPage(0); }} />;
}
export function usePayrollPager(total, resetKey) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  useEffect(() => { setPage(0); }, [resetKey]);
  const range = paginate(total, page, pageSize);
  useEffect(() => { if (page !== range.currentPage) setPage(range.currentPage); }, [page, range.currentPage]);
  return { page: range.currentPage, pageSize, setPage, setPageSize, ...range };
}

export function PayrollPending({ companyId, requests, onResolved }) {
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = pendingPayrollCommands.pending(companyId);
  void version;
  if (!pending.length) return null;
  async function retry(record) {
    if (busy) return;
    const ticket = requests.begin('pending'); setBusy(true);
    try {
      const result = await requests.invoke(record.method, record.payload, { financial: true, guard: value => {
        if (value?.companyId !== companyId || !value?.id) throw new Error('Invalid payroll command response');
        return value;
      } });
      if (!requests.current(ticket)) return;
      setError(null); setVersion(v => v + 1); onResolved?.(record, result);
    } catch (err) { requests.failure(ticket, err); if (requests.current(ticket)) { setError(errorText(err)); setVersion(v => v + 1); } }
    finally { if (requests.current(ticket)) setBusy(false); }
  }
  return <section className="hr-note" aria-label="Unresolved payroll requests">
    <strong>A financial request needs confirmation</strong>
    <p>Retry sends the original operation and amount. Check its result before recording another payment.</p>
    <PayrollError message={error} />
    {pending.map(record => <div className="hr-actions-row" key={record.payload.operationId}>
      <span>{record.method} · {record.payload.id || 'new run'}{record.error ? ` · ${record.error}` : ''}</span>
      <Button size="sm" disabled={busy || record.running} onClick={() => retry(record)}>Retry original request</Button>
    </div>)}
  </section>;
}

export function PayrollStatutoryFields({ form, onChange, disabled }) {
  const explicit = form.applyTax !== 'inherit' || form.applyNssf !== 'inherit';
  return <fieldset className="form-grid payroll-fields" disabled={disabled}>
    {[['applyTax', 'Salary tax'], ['applyNssf', 'NSSF']].map(([key, label]) => <Field key={key} label={label}>{({ id }) => <Select id={id} value={form[key]} onChange={e => onChange(key, e.target.value)}><option value="inherit">Inherit</option><option value="yes">Apply</option><option value="no">Do not apply</option></Select>}</Field>)}
    <Field label="Override reason" required={explicit} span="full" hint="A reason is required for either Apply or Do not apply.">{({ id }) => <Textarea id={id} value={form.reason} disabled={!explicit} onChange={e => onChange('reason', e.target.value)} />}</Field>
  </fieldset>;
}

export function NewPayrollRunModal({ companyId, settings, employees, rateSets, onClose, onCreated }) {
  const requests = usePayrollRequests(companyId, 'new-run');
  const month = lastEndedPeriod();
  const [form, setForm] = useState(() => ({ month, period: periodChoices(month, settings.payCycle)[0].value,
    payDate: defaultPayDate(month, settings), employeeIds: [], statutoryRateSetId: '', statutoryOverride: statutoryOverrideForm(null), currency: 'USD', advance: '',
    ...Object.fromEntries(['taxRateKhrPerUsd', 'rateSource', 'nssfRateKhrPerUsd', 'nssfRateSource', 'loanRateKhrPerUsd', 'loanRateSource'].map(k => [k, settings[k] ?? ''])) }));
  const [search, setSearch] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const choices = /^\d{4}-(0[1-9]|1[0-2])$/.test(form.month) ? periodChoices(form.month, settings.payCycle) : [];
  const selected = choices.find(x => x.value === form.period);
  const filtered = employees.filter(e => `${e.staffCode} ${e.nameEn} ${e.nameKm}`.toLowerCase().includes(search.toLowerCase()));
  const pager = usePayrollPager(filtered.length, search);
  const unresolved = pendingPayrollCommands.pending(companyId).some(x => x.method === 'create');
  const change = (key, value) => { setError(null); setForm(f => ({ ...f, [key]: value })); };
  async function create() {
    if (running.current || unresolved) return;
    const ticket = requests.begin('create');
    try {
      const payload = createRunPayload(companyId, form, settings);
      running.current = true; setBusy(true);
      const run = await requests.invoke('create', payload, { financial: true, guard: value => guardRun(value, companyId) });
      if (requests.current(ticket)) onCreated(run);
    } catch (err) { requests.failure(ticket, err); if (requests.current(ticket)) setError(errorText(err)); }
    finally { running.current = false; if (requests.current(ticket)) setBusy(false); }
  }
  return <Modal open title="New payroll run" wide onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || unresolved} onClick={create}>{busy ? 'Creating…' : 'Create draft'}</Button></>}>
    <p className="hr-note">Draft estimate. Creating or calculating a run does not approve it or pay anyone.</p>
    <PayrollError message={error} />
    {unresolved ? <p role="alert">Close this dialog and retry the original creation request above the run list.</p> : null}
    <fieldset disabled={busy || unresolved} className="form-grid payroll-fields">
      <Field label="Month" required>{({ id }) => <Input id={id} type="month" value={form.month} onChange={e => {
        const value = e.target.value;
        change('month', value);
        if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) setForm(f => ({ ...f, period: periodChoices(value, settings.payCycle)[0].value, payDate: defaultPayDate(value, settings) }));
      }} />}</Field>
      <Field label="Period" hint="Allowed by company pay-cycle policy.">{({ id }) => <Select id={id} value={form.period} onChange={e => change('period', e.target.value)}>{choices.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>}</Field>
      <Field label="Pay date" required>{({ id }) => <Input id={id} type="date" value={form.payDate} onChange={e => change('payDate', e.target.value)} />}</Field>
      <Field label="Statutory set" hint="Approval requires confirmed coverage for this period.">{({ id }) => <Select id={id} value={form.statutoryRateSetId} onChange={e => change('statutoryRateSetId', e.target.value)}><option value="">Choose a set</option>{rateSets.map(s => <option key={s.id} value={s.id}>{s.name} · {s.status} · {s.effectiveFrom}</option>)}</Select>}</Field>
      {selected?.kind === 'advance' ? <><Field label="Advance currency">{({ id }) => <Select id={id} value={form.currency} onChange={e => change('currency', e.target.value)}><option>USD</option><option>KHR</option></Select>}</Field><Field label="Advance per person" required>{({ id }) => <Input id={id} inputMode="decimal" value={form.advance} onChange={e => change('advance', e.target.value)} />}</Field></> : null}
    </fieldset>
    <details className="hr-subhead">
      <summary>Exchange rates and sources · KHR per USD</summary>
      <div className="form-grid">
        {[['taxRateKhrPerUsd', 'rateSource', 'Salary tax'], ['nssfRateKhrPerUsd', 'nssfRateSource', 'NSSF'], ['loanRateKhrPerUsd', 'loanRateSource', 'Loan conversion']].map(([rate, source, label]) => <fieldset className="form-grid payroll-fields field--full" key={rate} disabled={busy || unresolved}><legend className="section-title">{label}</legend>
          <Field label={`${label} rate`}>{({ id }) => <Input id={id} inputMode="decimal" value={form[rate]} onChange={e => change(rate, e.target.value)} />}</Field>
          <Field label={`${label} source`}>{({ id }) => <Input id={id} value={form[source]} onChange={e => change(source, e.target.value)} />}</Field>
        </fieldset>)}
      </div>
      <p className="muted">Blank fields may inherit saved company values. Inspect the draft input snapshot before approval; each conversion needs its own source.</p>
    </details>
    <details className="hr-subhead"><summary>Advanced · run statutory treatment</summary>
      <PayrollStatutoryFields form={form.statutoryOverride} disabled={busy || unresolved} onChange={(key, value) => setForm(f => ({ ...f, statutoryOverride: { ...f.statutoryOverride, [key]: value } }))} />
      <p className="muted">Inherit uses each employee’s policy. Run treatment is fixed at creation; line decisions may override it. These choices do not establish a legal exemption. Confirmed statutory coverage and professional policy evidence are still required.</p>
    </details>
    <section className="hr-subhead">
      <div className="section-head"><h2 className="section-title">Staff · {form.employeeIds.length} selected</h2></div>
      <Field label="Find staff">{({ id }) => <Input id={id} type="search" value={search} onChange={e => setSearch(e.target.value)} />}</Field>
      <div className="hr-pick-list">
        <div className="hr-pick-list__head"><span>{filtered.length} matching staff</span><Button size="sm" disabled={busy || unresolved} onClick={() => change('employeeIds', filtered.slice(0, 500).map(e => e.id))}>Select matching (up to 500)</Button><Button size="sm" onClick={() => change('employeeIds', [])} disabled={busy || unresolved}>Clear</Button></div>
        {filtered.slice(pager.pageStart, pager.pageEnd).map(e => <label className="fuel-check hr-pick" key={e.id}><input type="checkbox" disabled={busy || unresolved} checked={form.employeeIds.includes(e.id)} onChange={ev => change('employeeIds', ev.target.checked ? [...form.employeeIds, e.id] : form.employeeIds.filter(id => id !== e.id))} />{e.staffCode} · {e.nameEn || e.nameKm} · {e.status}</label>)}
      </div>
      <PayrollPagination total={filtered.length} pager={pager} />
    </section>
  </Modal>;
}

export function PayrollActionModal({ companyId, run, action, settings, onClose, onChanged }) {
  const caps = usePayrollCaps();
  const requests = usePayrollRequests(companyId, `${run.id}:${action.method}:${action.line?.id || action.payment?.id || ''}`);
  const [form, setForm] = useState(() => ({ amount: minorToInput(action.line?.remainingMinor, action.line?.currency), method: 'bank', paidAt: todayKey(), reference: '', reason: '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const running = useRef(false);
  const allowed = runActions(run, settings, caps);
  const method = action.method;
  const revisionMatches = action.revision === undefined || action.revision === run.revision;
  const permitted = revisionMatches && (method === 'pay' ? allowed.pay : method === 'reversePayment' ? allowed.reverse : method === 'voidRun' ? allowed.void : allowed[method]);
  const pending = pendingPayrollCommands.pending(companyId).find(x => x.method === method && x.payload.id === (action.line?.id || action.payment?.id));
  const title = { calculate: 'Calculate draft payroll', review: 'Review payroll', approve: 'Approve payroll', pay: 'Record payment', reversePayment: 'Reverse payment', voidRun: 'Void payroll run' }[method];
  const change = (key, value) => setForm(f => ({ ...f, [key]: value }));
  async function execute() {
    if (running.current || !permitted) return;
    const ticket = requests.begin('action');
    try {
      let payload;
      if (pending) payload = pending.payload;
      else if (method === 'pay') payload = paymentPayload(companyId, action.line, form, run.periodStart);
      else if (method === 'reversePayment' || method === 'voidRun') {
        if (!form.reason.trim()) throw new Error('A reason is required');
        payload = { companyId, id: method === 'reversePayment' ? action.payment.id : run.id, reason: form.reason.trim() };
      } else payload = { companyId, id: run.id, ...(['review', 'approve'].includes(method) ? { expectedRevision: run.revision } : {}) };
      running.current = true; setBusy(true);
      const financial = ['pay', 'reversePayment'].includes(method);
      const result = await requests.invoke(method, payload, { financial, guard: value => {
        if (financial) {
          if (value?.companyId !== companyId || !value?.id || !Number.isSafeInteger(value.amountMinor) || value.lineId !== (action.line?.id || action.payment?.lineId)) throw new Error('Payment response does not match this line');
          return value;
        }
        return guardRun(value, companyId, run.id);
      } });
      if (requests.current(ticket)) onChanged(result);
    } catch (err) { requests.failure(ticket, err); if (requests.current(ticket)) setError(errorText(err)); }
    finally { running.current = false; if (requests.current(ticket)) setBusy(false); }
  }
  return <Modal open title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={['voidRun', 'reversePayment'].includes(method) ? 'danger' : 'primary'} disabled={busy || !permitted} onClick={execute}>{busy ? 'Working…' : pending ? 'Retry original request' : title}</Button></>}>
    <PayrollError message={error} />
    {!permitted ? <p role="alert">{!revisionMatches ? 'Payroll revision changed. Close this dialog and review the current run.' : 'This action is unavailable under the current status, blockers or approval policy.'}</p> : null}
    {pending ? <p className="hr-note">Retrying the original request: {moneyLabel(pending.payload.amountMinor, action.line?.currency)}. Its amount, date and operation ID stay unchanged.</p> : null}
    {method === 'pay' ? <><p className="hr-note">Remaining: {moneyLabel(action.line.remainingMinor, action.line.currency)}. Recording the first payment also posts the frozen loan deductions.</p>
      <fieldset disabled={busy || !!pending} className="form-grid payroll-fields">
        <Field label={`Amount (${action.line.currency})`} required>{({ id }) => <Input id={id} inputMode="decimal" value={form.amount} onChange={e => change('amount', e.target.value)} />}</Field>
        <Field label="Method">{({ id }) => <Select id={id} value={form.method} onChange={e => change('method', e.target.value)}><option value="bank">Bank</option><option value="cash">Cash</option><option value="other">Other</option></Select>}</Field>
        <Field label="Payment date" required>{({ id }) => <Input id={id} type="date" max={todayKey()} value={form.paidAt} onChange={e => change('paidAt', e.target.value)} />}</Field>
        <Field label="Reference">{({ id }) => <Input id={id} value={form.reference} onChange={e => change('reference', e.target.value)} />}</Field>
      </fieldset></> : null}
    {method === 'reversePayment' || method === 'voidRun' ? <><p>{method === 'reversePayment' ? 'This adds a reversal and reverses linked loan repayments in the same transaction.' : 'Every payment must be reversed first. Historical records are retained.'}</p><Field label="Reason" required>{({ id }) => <Textarea id={id} disabled={busy || !!pending} value={form.reason} onChange={e => change('reason', e.target.value)} />}</Field></> : null}
    {method === 'approve' ? <p>Approve revision {run.revision} and freeze its inputs. The backend rechecks sources, statutory coverage and company policy. No payment is made.</p> : null}
    {method === 'review' ? <p>Record a review of revision {run.revision}. Changed attendance, pay rates or settings require recalculation.</p> : null}
    {method === 'calculate' ? <p>Recalculate this draft from current company settings, dated pay rates and reviewed attendance. Nothing is paid.</p> : null}
  </Modal>;
}

export function PayrollDecisionModal({ companyId, run, line, kind, date, plan, onClose, onChanged }) {
  const caps = usePayrollCaps();
  const requests = usePayrollRequests(companyId, `${run.id}:${line.id}:${run.revision}:${run.status}:decision`);
  const activeCompanyId = useAppStore(s => s.activeCompanyId);
  const context = `${companyId}:${run.id}:${line.employeeId}`;
  const completionContext = useRef(context); completionContext.current = context;
  useEffect(() => () => { completionContext.current = null; }, []);
  const [opened, setOpened] = useState(() => ({ context, revision: run.revision, lineId: line.id }));
  const sameContext = opened.context === context && activeCompanyId === companyId && run.companyId === companyId && line.companyId === companyId && line.runId === run.id && hasCap(caps, 'payroll.manage');
  const editable = sameContext && run.lines.some(x => x.id === line.id) && runActions(run, {}, caps).editable;
  const permitted = editable && opened.lineId === line.id && opened.revision === run.revision;
  const initialForm = () => {
    if (kind === 'statutory') return { kind, ...statutoryOverrideForm(line.decisions?.statutoryOverride) };
    const previous = kind === 'day' ? line.decisions?.dayDecisions?.find(x => x.date === date) : line.decisions?.loanDecisions?.find(x => x.loanId === plan.loanId);
    return { kind, date, payable: previous ? (previous.payable ? 'yes' : 'no') : '', loanId: plan?.loanId, currency: plan?.currency,
      amount: minorToInput(previous?.amountMinor ?? plan?.amountMinor, plan?.currency), reason: previous?.reason || '' };
  };
  const [form, setForm] = useState(initialForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const running = useRef(false);
  const pending = useRef(null);
  async function save() {
    if (running.current || !permitted) return;
    const ticket = requests.begin('decision');
    try {
      const payload = pending.current || decisionPayload(run, line, form);
      running.current = true; pending.current = payload; setBusy(true);
      const result = await requests.invoke('updateLine', payload, { guard: value => guardRun(value, companyId, run.id) });
      pending.current = null;
      if (requests.current(ticket)) onChanged(result);
    } catch (err) { if (isDefiniteRejection(err, 'updateLine')) pending.current = null; requests.failure(ticket, err); if (requests.current(ticket)) setError(errorText(err)); }
    finally {
      running.current = false;
      if (completionContext.current === context && useAppStore.getState().activeCompanyId === companyId && hasCap(storeCaps(useAppStore.getState()), 'payroll.manage')) setBusy(false);
    }
  }
  function discardDraft() {
    if (!editable || running.current) return;
    setForm(initialForm()); setOpened({ context, revision: run.revision, lineId: line.id });
    pending.current = null; setError(null);
  }
  return <Modal open title={kind === 'statutory' ? 'Line statutory treatment' : kind === 'day' ? `Whole-day decision · ${dateLabel(date)}` : 'Loan repayment decision'} onClose={onClose}
    footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !permitted} onClick={save}>{busy ? 'Saving…' : pending.current ? 'Retry original decision' : 'Save decision and recalculate'}</Button></>}>
    {!permitted ? <p role="alert">Payroll line, revision or access changed. Saving this draft is blocked. Review the current decision before saving.</p> : null}
    {sameContext ? <>
    {!permitted ? <Button disabled={busy || !editable} onClick={discardDraft}>Discard draft and load current decision</Button> : null}
    <PayrollError message={error} />
    <p className="hr-note">Revision {run.revision}. Reasons are required. Company limits and backend validation still apply.</p>
    {pending.current && !busy ? <p className="hr-note">The outcome is unconfirmed. Retry uses the original line, revision and decision; a superseded line will be rejected. Close and refresh the run to inspect the result.</p> : null}
    {kind === 'statutory' ? <details open><summary>Advanced · line statutory treatment</summary>
      <PayrollStatutoryFields form={form} disabled={busy || !!pending.current || !permitted} onChange={(key, value) => setForm(f => ({ ...f, [key]: value }))} />
      <p className="muted">Inherit uses the run override, then the employee policy. Both Inherit clears this line’s override. Confirmed statutory coverage and professional policy evidence are still required; these choices do not establish a legal exemption.</p>
    </details> : <fieldset className="form-grid payroll-fields" disabled={busy || !!pending.current || !permitted}>
    {kind === 'day' ? <Field label="Whole day" required>{({ id }) => <Select id={id} disabled={busy} value={form.payable} onChange={e => setForm(f => ({ ...f, payable: e.target.value }))}><option value="">Choose a decision</option><option value="yes">Payable whole day</option><option value="no">Unpaid whole day</option></Select>}</Field>
      : <Field label={`Repayment in loan currency (${plan.currency})`} required>{({ id }) => <Input id={id} disabled={busy} inputMode="decimal" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />}</Field>}
    <Field label="Reason" required>{({ id }) => <Textarea id={id} disabled={busy} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />}</Field>
    </fieldset>}
    </> : null}
  </Modal>;
}

/** Editable persisted notes only; explicit decisions, approvals and money never autosave. */
export function PayrollLineNote({ companyId, run, line, onChanged }) {
  const requests = usePayrollRequests(companyId, `${run.id}:${line.id}:note`);
  const tick = useHrTick(['loan', 'payroll']);
  const [note, setNote] = useState(line.decisions?.note || '');
  const [status, setStatus] = useState({ state: 'saved', savedAt: null });
  const dirty = useRef(false);
  const running = useRef(false);
  const inFlight = useRef(null);
  const latest = useRef(note); latest.current = note;
  useEffect(() => { if (!dirty.current && !running.current) setNote(line.decisions?.note || ''); }, [line.id, line.decisions?.note]);
  const save = useCallback(async () => {
    if (running.current) return inFlight.current;
    if (!dirty.current) return;
    const ticket = requests.begin('note'); running.current = true;
    const sent = latest.current;
    setStatus(s => ({ ...s, state: 'saving' }));
    try {
      inFlight.current = requests.invoke('updateLine', { companyId, id: line.id, expectedRevision: run.revision, patch: { note: sent.trim() || null } }, { guard: value => guardRun(value, companyId, run.id) });
      const result = await inFlight.current;
      if (!requests.current(ticket)) return;
      dirty.current = latest.current !== sent;
      setStatus({ state: dirty.current ? 'dirty' : 'saved', savedAt: Date.now() }); onChanged(result);
    } catch (err) { requests.failure(ticket, err); if (requests.current(ticket)) setStatus(s => ({ ...s, state: 'error', error: errorText(err) })); return { error: err }; }
    finally { running.current = false; }
  }, [requests, companyId, line.id, run.id, run.revision, onChanged]);
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => registerCompanySwitchFlusher(async () => {
    const result = await saveRef.current();
    if (result?.error) throw result.error;
  }), []);
  // Closing within 500 ms still saves a persisted edit to its original company.
  // Dispatch's live-company check rejects an already-completed company switch.
  useEffect(() => () => { if (dirty.current && !running.current) void saveRef.current(); }, []);
  useEffect(() => { if (!dirty.current || status.state === 'error') return undefined; const timer = setTimeout(save, 500); return () => clearTimeout(timer); }, [note, save, status.state, tick]);
  return <section><div className="section-head"><h3 className="section-title">Review note</h3><SaveStatus {...status} onSave={save} /></div>
    {status.error ? <PayrollError message={status.error} /> : null}
    <Field label="Note">{({ id }) => <Textarea id={id} disabled={status.state === 'saving'} value={note} onChange={e => { dirty.current = true; setNote(e.target.value); setStatus(s => ({ ...s, state: 'dirty', error: null })); }} />}</Field>
  </section>;
}
