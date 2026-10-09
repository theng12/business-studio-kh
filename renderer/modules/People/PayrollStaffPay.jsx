import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { hasCap } from '../../lib/capabilities.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { useHrTick } from './hrHooks.js';
import { PayrollError, PayrollPagination, usePayrollCaps, usePayrollPager, usePayrollRequests } from './PayrollModals.jsx';
import { assignmentPayload, componentPayload, dateLabel, employeePolicyPayload, errorText, guardRows, isDefiniteRejection, moneyLabel, payRatePayload, todayKey } from './payrollUiModel.js';

const EXTRA_TYPES = [['seniority', 'Seniority indemnity'], ['thirteenth_month', '13th-month pay'], ['bonus', 'Bonus'], ['allowance', 'Allowance']];

/** Reusable Staff panel: employeeId optional; company always comes from useAppStore. */
export function PayrollStaffPay({ employeeId }) {
  const companyId = useAppStore(s => s.activeCompanyId);
  const caps = usePayrollCaps();
  if (!companyId) return <EmptyState title="Choose a company" body="Staff pay belongs to the active company." />;
  if (!hasCap(caps, 'payroll.manage')) return <EmptyState title="Payroll access required" body="Salary data requires payroll permission." />;
  return <StaffPayCompany key={`${companyId}|${employeeId || ''}|${JSON.stringify(caps)}`} companyId={companyId} employeeId={employeeId} />;
}

function StaffPayCompany({ companyId, employeeId }) {
  const requests = usePayrollRequests(companyId, 'staff-lookup');
  const tick = useHrTick(['loan', 'payroll']);
  const [load, setLoad] = useState(null);
  const [selectedId, setSelectedId] = useState(employeeId || '');
  const [retry, setRetry] = useState(0);
  const data = load?.key === requests.key && load.companyId === companyId ? load : null;
  useEffect(() => {
    const ticket = requests.begin('employees');
    requests.invoke('listEmployees', { companyId }, { guard: value => guardRows(value, companyId) })
      .then(employees => { if (requests.current(ticket)) setLoad({ key: requests.key, companyId, employees }); })
      .catch(err => { requests.failure(ticket, err); if (requests.current(ticket)) setLoad(previous => ({ ...(previous?.key === requests.key && previous.companyId === companyId ? previous : {}), key: requests.key, companyId, error: errorText(err) })); });
  }, [requests, companyId, tick, retry]);
  return <div className="hr-sections">
    {!employeeId ? <Field label="Staff member">{({ id }) => <Select id={id} value={selectedId} disabled={!data?.employees} onChange={e => setSelectedId(e.target.value)}><option value="">Choose staff</option>{(data?.employees || []).map(e => <option key={e.id} value={e.id}>{e.staffCode} · {e.nameEn || e.nameKm}</option>)}</Select>}</Field> : null}
    <PayrollError message={data?.error} onRetry={() => setRetry(n => n + 1)} />
    {!data ? <p role="status" className="muted">Loading staff…</p> : selectedId && data.employees?.some(x => x.id === selectedId) ? <StaffPayEditor key={selectedId} companyId={companyId} employeeId={selectedId} /> : !data.error ? <EmptyState title={selectedId ? 'Staff member unavailable' : 'Choose a staff member'} body={selectedId ? 'This person is not in the active company.' : 'Set dated rates and explicit tax and NSSF policy.'} /> : null}
  </div>;
}

function StaffPayEditor({ companyId, employeeId }) {
  const requests = usePayrollRequests(companyId, employeeId);
  const tick = useHrTick(['loan', 'payroll']);
  const [load, setLoad] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [modal, setModal] = useState(null);
  const data = load?.key === requests.key && load.companyId === companyId && load.employeeId === employeeId ? load : null;
  const reload = useCallback(() => setRefresh(n => n + 1), []);
  useEffect(() => {
    const ticket = requests.begin('staff-pay');
    Promise.all([
      requests.invoke('listPayRates', { companyId, employeeId }, { guard: value => guardRows(value, companyId, employeeId) }),
      requests.invoke('getEmployeePolicy', { companyId, employeeId }, { guard: value => {
        if (value && (value.companyId !== companyId || value.employeeId !== employeeId)) throw new Error('Policy response does not match this employee');
        return value;
      } }),
      requests.invoke('listComponents', { companyId }, { guard: value => guardRows(value, companyId) }),
      requests.invoke('listEmployeeComponents', { companyId, employeeId }, { guard: value => guardRows(value, companyId, employeeId) }),
    ]).then(([rates, policy, components, assignments]) => {
      if (requests.current(ticket)) setLoad({ key: requests.key, companyId, employeeId, rates, policy, components, assignments });
    }).catch(err => { requests.failure(ticket, err); if (requests.current(ticket)) setLoad(previous => ({ ...(previous?.key === requests.key && previous.companyId === companyId && previous.employeeId === employeeId ? previous : {}), key: requests.key, companyId, employeeId, error: errorText(err) })); });
  }, [requests, companyId, employeeId, tick, refresh]);
  if (!data?.rates) return <><PayrollError message={data?.error} onRetry={reload} />{!data?.error ? <p className="muted" role="status">Loading pay configuration…</p> : null}</>;
  return <div className="hr-sections">
    <PayrollError message={data.error} onRetry={reload} />
    <section className="card hr-card"><div className="section-head"><h2 className="section-title">Dated pay rates</h2><div className="section-head__actions"><Button onClick={() => setModal({ kind: 'rate' })}>+ Add pay rate…</Button></div></div>
      <p className="muted">Rates are dated history. Corrections use a new effective date; approved payroll keeps its frozen inputs.</p>
      <PayRatesTable rates={data.rates} />
    </section>
    <EmployeePolicyEditor key={`${employeeId}:policy`} companyId={companyId} employeeId={employeeId} policy={data.policy} />
    <details className="hr-subhead"><summary>Optional pay components · {data.assignments.length} assignments</summary>
      <p className="muted">New extra types start inactive. Activation and statutory treatment are deliberate company choices.</p>
      <div className="hr-actions-row"><Button onClick={() => setModal({ kind: 'component' })}>+ New component…</Button><Button onClick={() => setModal({ kind: 'assignment' })} disabled={!data.components.some(x => x.active && x.calc !== 'percent')}>+ Assign component…</Button></div>
      <ComponentsTable components={data.components} onEdit={component => setModal({ kind: 'component', component })} />
      <AssignmentsTable assignments={data.assignments} components={data.components} />
    </details>
    {modal?.kind === 'rate' ? <PayRateModal companyId={companyId} employeeId={employeeId} rates={data.rates} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} /> : null}
    {modal?.kind === 'component' ? <ComponentModal key={modal.component?.id || 'new'} companyId={companyId} component={modal.component} onClose={() => { setModal(null); reload(); }} onSaved={reload} /> : null}
    {modal?.kind === 'assignment' ? <AssignmentModal companyId={companyId} employeeId={employeeId} components={data.components} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} /> : null}
  </div>;
}

function PayRatesTable({ rates }) {
  const pager = usePayrollPager(rates.length, rates[0]?.employeeId);
  if (!rates.length) return <EmptyState title="No pay rate yet" body="Add a dated monthly, daily or hourly rate before calculating payroll." />;
  return <><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Effective from</th><th>Basis</th><th>Currency</th><th className="is-num">Rate</th><th>Reason</th></tr></thead><tbody>{rates.slice(pager.pageStart, pager.pageEnd).map(rate => <tr key={rate.id}><td>{dateLabel(rate.effectiveFrom)}</td><td>{rate.basis}</td><td>{rate.currency}</td><td className="is-num">{moneyLabel(rate.amountMinor, rate.currency)}</td><td className="hr-cell-text">{rate.reason}</td></tr>)}</tbody></table></div><PayrollPagination total={rates.length} pager={pager} /></>;
}

/** Two persisted configuration editors share the same debounced/explicit save path. */
function usePayConfigEditor(companyId, contextKey, initial, method, buildPayload, onSaved, autosave = true, refreshed = null) {
  const requests = usePayrollRequests(companyId, contextKey);
  const [form, setForm] = useState(initial);
  const [status, setStatus] = useState({ state: 'saved', savedAt: null, error: null });
  const dirty = useRef(false);
  const running = useRef(false);
  const inFlight = useRef(null);
  const observedSource = useRef(refreshed);
  const conflict = useRef(false);
  const conflictMessage = 'Employee policy changed while you had unsaved edits. Your draft is kept; discard it and use the refreshed policy before editing again.';
  // Reconcile during render so a queued Save/debounce cannot send stale fields
  // between a refreshed policy arriving and an effect running.
  if (refreshed && refreshed.source !== observedSource.current.source) {
    const changed = JSON.stringify(refreshed.form) !== JSON.stringify(observedSource.current.form);
    observedSource.current = refreshed;
    if (dirty.current && changed && JSON.stringify(form) !== JSON.stringify(refreshed.form)) conflict.current = true;
    if (!dirty.current) {
      setForm(refreshed.form);
      setStatus(s => ({ ...s, state: 'saved', error: null }));
    }
  }
  const latest = useRef({ form, buildPayload, onSaved }); latest.current = { form, buildPayload, onSaved };
  const save = useCallback(async () => {
    if (conflict.current) return { error: new Error(conflictMessage) };
    if (running.current) return inFlight.current;
    if (!dirty.current) return;
    const ticket = requests.begin('config-save');
    try {
      const payload = latest.current.buildPayload(latest.current.form);
      running.current = true; setStatus(s => ({ ...s, state: 'saving', error: null }));
      inFlight.current = requests.invoke(method, payload, { guard: value => {
        if (!value || value.companyId !== companyId || (payload.employeeId && value.employeeId !== payload.employeeId) || (payload.id && value.id !== payload.id)) throw new Error('Configuration response does not match this editor');
        return value;
      } });
      const result = await inFlight.current;
      if (!requests.current(ticket)) return;
      if (conflict.current) return { error: new Error(conflictMessage) };
      if (observedSource.current) observedSource.current = { ...observedSource.current, form: latest.current.form };
      dirty.current = false; setStatus({ state: 'saved', savedAt: Date.now(), error: null }); latest.current.onSaved?.(result);
    } catch (err) { requests.failure(ticket, err); if (requests.current(ticket)) setStatus(s => ({ ...s, state: 'error', error: errorText(err) })); return { error: err }; }
    finally { running.current = false; if (requests.current(ticket)) setStatus(s => ({ ...s })); }
  }, [requests, method, companyId]);
  const saveRef = useRef(save); saveRef.current = save;
  useEffect(() => autosave ? registerCompanySwitchFlusher(async () => {
    const result = await saveRef.current();
    if (result?.error) throw result.error;
  }) : undefined, [autosave]);
  useEffect(() => () => { if (autosave && dirty.current && !running.current) void saveRef.current(); }, [autosave]);
  useEffect(() => { if (!autosave || !dirty.current || status.state !== 'dirty') return undefined; const timer = setTimeout(save, 500); return () => clearTimeout(timer); }, [form, status.state, save, autosave]);
  const change = (key, value) => { if (running.current) return; dirty.current = true; setForm(f => ({ ...f, [key]: value })); setStatus(s => ({ ...s, state: 'dirty', error: null })); };
  const useRefreshed = () => {
    if (running.current) return;
    conflict.current = false; dirty.current = false; setForm(refreshed.form);
    setStatus(s => ({ ...s, state: 'saved', error: null }));
  };
  return { form, status: conflict.current ? { ...status, state: 'error', error: conflictMessage } : status, save, change, conflict: conflict.current, useRefreshed, busy: running.current };
}

function EmployeePolicyEditor({ companyId, employeeId, policy }) {
  const initial = { applyTax: policy ? (policy.applyTax ? 'yes' : 'no') : '', applyNssf: policy ? (policy.applyNssf ? 'yes' : 'no') : '', taxResident: policy ? (policy.taxResident ? 'yes' : 'no') : '', spouseCount: String(policy?.spouseCount ?? 0), dependentCount: String(policy?.dependentCount ?? 0), reason: policy?.reason || '' };
  const editor = usePayConfigEditor(companyId, `${employeeId}:policy`, initial, 'setEmployeePolicy', form => employeePolicyPayload(companyId, employeeId, form), undefined, true, { source: policy, form: initial });
  const { form, status, save, change } = editor;
  return <section className="card hr-card"><div className="section-head"><h2 className="section-title">Employee tax and NSSF policy</h2><div className="section-head__actions"><SaveStatus {...status} onSave={save} /></div></div>
    {!policy ? <p className="hr-note">Policy is not set. Choose each treatment explicitly; missing choices are not exemptions.</p> : null}
    <PayrollError message={status.error} />
    {editor.conflict ? <Button onClick={editor.useRefreshed} disabled={editor.busy}>Discard draft and use refreshed policy</Button> : null}
    <fieldset className="form-grid payroll-fields" disabled={editor.busy}>
      {[['applyTax', 'Apply salary tax'], ['applyNssf', 'Apply NSSF'], ['taxResident', 'Tax resident']].map(([key, label]) => <Field label={label} required key={key}>{({ id }) => <Select id={id} value={form[key]} onChange={e => change(key, e.target.value)}><option value="">Choose explicitly</option><option value="yes">Yes</option><option value="no">No</option></Select>}</Field>)}
      <Field label="Spouse count">{({ id }) => <Select id={id} value={form.spouseCount} onChange={e => change('spouseCount', e.target.value)}><option value="0">0</option><option value="1">1</option></Select>}</Field>
      <Field label="Dependent count">{({ id }) => <Input id={id} inputMode="numeric" value={form.dependentCount} onChange={e => change('dependentCount', e.target.value)} />}</Field>
      <Field label="Policy / exemption reason" required={form.applyTax === 'no' || form.applyNssf === 'no'} hint="Disabling salary tax or NSSF requires a reason.">{({ id }) => <Textarea id={id} value={form.reason} onChange={e => change('reason', e.target.value)} />}</Field>
    </fieldset>
    <p className="muted">Saves update configuration only. Recalculate and review draft runs; approved inputs remain frozen.</p>
  </section>;
}

function useAppendConfig(companyId, contextKey, method, buildPayload, onSaved) {
  const requests = usePayrollRequests(companyId, contextKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(null);
  const running = useRef(false);
  async function save(form) {
    if (running.current) return;
    const ticket = requests.begin('append');
    try {
      const payload = pending.current || buildPayload(form);
      running.current = true; pending.current = payload; setBusy(true);
      const result = await requests.invoke(method, payload, { guard: value => {
        if (!value || value.companyId !== companyId || !value.id || (payload.employeeId && value.employeeId !== payload.employeeId)) throw new Error('Pay configuration response does not match this employee');
        return value;
      } });
      pending.current = null;
      if (requests.current(ticket)) onSaved(result);
    } catch (err) {
      if (isDefiniteRejection(err, method)) pending.current = null;
      requests.failure(ticket, err); if (requests.current(ticket)) setError(errorText(err));
    } finally { running.current = false; if (requests.current(ticket)) setBusy(false); }
  }
  return { busy, error, save, unresolved: !!pending.current };
}

function PayRateModal({ companyId, employeeId, rates, onClose, onSaved }) {
  const [form, setForm] = useState({ effectiveFrom: todayKey(), basis: 'month', currency: 'USD', amount: '', reason: '' });
  const append = useAppendConfig(companyId, `${employeeId}:rate`, 'setPayRate', value => {
    const payload = payRatePayload(companyId, employeeId, value);
    if (rates.some(x => x.effectiveFrom === payload.effectiveFrom)) throw new Error('A pay rate already exists for this date; use a new effective date');
    return payload;
  }, onSaved);
  const change = (key, value) => setForm(f => ({ ...f, [key]: value }));
  return <Modal open title="Add dated pay rate" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={append.busy} onClick={() => append.save(form)}>{append.busy ? 'Saving…' : append.unresolved ? 'Retry original rate' : 'Add pay rate'}</Button></>}>
    <PayrollError message={append.error} /><p className="hr-note">A new dated rate is appended. It never rewrites a previous rate or approved payroll.</p>
    <fieldset className="form-grid payroll-fields" disabled={append.busy || append.unresolved}>
      <Field label="Effective from" required hint="Must cover the dates of the payroll period.">{({ id }) => <Input id={id} type="date" value={form.effectiveFrom} onChange={e => change('effectiveFrom', e.target.value)} />}</Field>
      <Field label="Pay basis">{({ id }) => <Select id={id} value={form.basis} onChange={e => change('basis', e.target.value)}><option value="month">Monthly</option><option value="day">Daily</option><option value="hour">Hourly</option></Select>}</Field>
      <Field label="Currency">{({ id }) => <Select id={id} value={form.currency} onChange={e => change('currency', e.target.value)}><option>USD</option><option>KHR</option></Select>}</Field>
      <Field label="Amount" required>{({ id }) => <Input id={id} inputMode="decimal" value={form.amount} onChange={e => change('amount', e.target.value)} />}</Field>
      <Field label="Reason" required span="full">{({ id }) => <Textarea id={id} value={form.reason} onChange={e => change('reason', e.target.value)} />}</Field>
    </fieldset>
  </Modal>;
}

function ComponentsTable({ components, onEdit }) {
  const pager = usePayrollPager(components.length, 'components');
  return <><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Component</th><th>Kind</th><th>Calculation</th><th>State</th><th className="is-actions">Action</th></tr></thead><tbody>{components.slice(pager.pageStart, pager.pageEnd).map(component => <tr key={component.id}><td>{component.nameEn}<div className="muted">{component.code}</div></td><td>{component.kind}</td><td>{component.calc}</td><td><Badge tone={component.active ? 'emerald' : 'slate'}>{component.active ? 'Active' : 'Inactive'}</Badge></td><td className="is-actions"><Button size="sm" onClick={() => onEdit(component)}>Edit…</Button></td></tr>)}</tbody></table></div><PayrollPagination total={components.length} pager={pager} /></>;
}

function ComponentModal({ companyId, component, onClose, onSaved }) {
  const editor = usePayConfigEditor(companyId, `component:${component?.id || 'new'}`, () => component ? { ...component, nameKm: component.nameKm || '' } : { code: '', nameEn: '', nameKm: '', kind: 'earning', calc: 'fixed', taxable: undefined, nssfContributory: undefined, isFringeBenefit: undefined, active: false }, 'saveComponent', form => componentPayload(companyId, form), onSaved, Boolean(component));
  const append = useAppendConfig(companyId, 'new-component', 'saveComponent', form => componentPayload(companyId, form), result => { onSaved(result); onClose(); });
  const { form, status, save, change } = editor;
  const busy = component ? status.state === 'saving' : append.busy;
  // New drafts wait for their explicit creation button; persisted edits autosave.
  const update = change;
  return <Modal open wide title={component ? 'Edit pay component' : 'New inactive pay component'} onClose={onClose}
    footer={<><Button onClick={onClose}>Close</Button>{component ? <SaveStatus {...status} onSave={save} /> : <Button variant="primary" disabled={busy} onClick={() => append.save(form)}>{busy ? 'Creating…' : append.unresolved ? 'Retry original component' : 'Create inactive component'}</Button>}</>}>
    <PayrollError message={component ? status.error : append.error} />
    <p className="hr-note">Optional compensation is a configuration choice. It does not establish whether a legal benefit may be disabled.</p>
    <fieldset className="form-grid payroll-fields" disabled={busy || (!component && append.unresolved)}>
      {!component ? <Field label="Extra pay type" span="full" hint="Optional and initially inactive; choose statutory treatment below.">{({ id }) => <Select id={id} value={EXTRA_TYPES.some(([code]) => code === form.code) ? form.code : ''} onChange={e => {
        const type = EXTRA_TYPES.find(([code]) => code === e.target.value);
        if (type) { update('code', type[0]); update('nameEn', type[1]); }
      }}><option value="">Custom component</option>{EXTRA_TYPES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</Select>}</Field> : null}
      <Field label="Code" required>{({ id }) => <Input id={id} value={form.code} onChange={e => update('code', e.target.value)} />}</Field>
      <Field label="English name" required>{({ id }) => <Input id={id} value={form.nameEn} onChange={e => update('nameEn', e.target.value)} />}</Field>
      <Field label="Khmer name">{({ id }) => <Input id={id} value={form.nameKm} onChange={e => update('nameKm', e.target.value)} />}</Field>
      <Field label="Kind">{({ id }) => <Select id={id} value={form.kind} onChange={e => update('kind', e.target.value)}><option value="earning">Earning</option><option value="deduction">Deduction</option><option value="employer_cost">Employer cost</option></Select>}</Field>
      <Field label="Calculation">{({ id }) => <Select id={id} value={form.calc} onChange={e => update('calc', e.target.value)}><option value="fixed">Fixed</option><option value="per_day">Per payable day</option><option value="per_hour">Per hour</option><option value="percent" disabled>Percentage — needs a defined base</option></Select>}</Field>
      {component ? <Field label="Active">{({ id }) => <Select id={id} value={form.active ? 'yes' : 'no'} onChange={e => update('active', e.target.value === 'yes')}><option value="no">Inactive</option><option value="yes">Active</option></Select>}</Field> : null}
      {[['taxable', 'Taxable'], ['nssfContributory', 'NSSF contributory'], ['isFringeBenefit', 'Fringe benefit']].map(([key, label]) => <Field label={label} required key={key}>{({ id }) => <Select id={id} value={form[key] === undefined ? '' : form[key] ? 'yes' : 'no'} onChange={e => update(key, e.target.value === '' ? undefined : e.target.value === 'yes')}><option value="">Choose explicitly</option><option value="yes">Yes</option><option value="no">No</option></Select>}</Field>)}
    </fieldset>
  </Modal>;
}

function AssignmentsTable({ assignments, components }) {
  const pager = usePayrollPager(assignments.length, 'assignments');
  return <><h3 className="section-title hr-subhead">Employee assignments</h3><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Component</th><th>Effective dates</th><th>Currency</th><th className="is-num">Assigned amount</th></tr></thead><tbody>{assignments.slice(pager.pageStart, pager.pageEnd).map(a => <tr key={a.id}><td>{components.find(c => c.id === a.componentId)?.nameEn || a.componentId}</td><td>{dateLabel(a.effectiveFrom)} – {a.effectiveTo ? dateLabel(a.effectiveTo) : 'No end date'}</td><td>{a.currency}</td><td className="is-num">{moneyLabel(a.amountMinor, a.currency)}</td></tr>)}</tbody></table></div><PayrollPagination total={assignments.length} pager={pager} /></>;
}

function AssignmentModal({ companyId, employeeId, components, onClose, onSaved }) {
  const [form, setForm] = useState({ componentId: '', amount: '', currency: 'USD', effectiveFrom: todayKey(), effectiveTo: '' });
  const append = useAppendConfig(companyId, `${employeeId}:assignment`, 'setEmployeeComponent', value => assignmentPayload(companyId, employeeId, value, components.find(x => x.id === value.componentId)), onSaved);
  const change = (key, value) => setForm(f => ({ ...f, [key]: value }));
  return <Modal open title="Assign pay component" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={append.busy} onClick={() => append.save(form)}>{append.busy ? 'Saving…' : append.unresolved ? 'Retry original assignment' : 'Add assignment'}</Button></>}>
    <PayrollError message={append.error} /><p className="hr-note">Assignments are dated history. Overlapping assignments and unsupported currency conversions are rejected.</p>
    <fieldset className="form-grid payroll-fields" disabled={append.busy || append.unresolved}>
      <Field label="Component" required span="full">{({ id }) => <Select id={id} value={form.componentId} onChange={e => change('componentId', e.target.value)}><option value="">Choose an active component</option>{components.filter(x => x.active && x.calc !== 'percent').map(x => <option key={x.id} value={x.id}>{x.nameEn} · {x.calc}</option>)}</Select>}</Field>
      <Field label="Currency">{({ id }) => <Select id={id} value={form.currency} onChange={e => change('currency', e.target.value)}><option>USD</option><option>KHR</option></Select>}</Field>
      <Field label="Amount" required hint="Per unit for daily/hourly components.">{({ id }) => <Input id={id} inputMode="decimal" value={form.amount} onChange={e => change('amount', e.target.value)} />}</Field>
      <Field label="Effective from" required>{({ id }) => <Input id={id} type="date" value={form.effectiveFrom} onChange={e => change('effectiveFrom', e.target.value)} />}</Field>
      <Field label="Effective to" hint="Optional; no overlapping assignments.">{({ id }) => <Input id={id} type="date" value={form.effectiveTo} onChange={e => change('effectiveTo', e.target.value)} />}</Field>
    </fieldset>
  </Modal>;
}
