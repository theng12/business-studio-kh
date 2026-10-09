import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { hasCap } from '../../lib/capabilities.js';
import { Button, Badge, EmptyState, Field, Input, Modal, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useHrTick } from './hrHooks.js';
import { PayrollStaffPay } from './PayrollStaffPay.jsx';
import { NewPayrollRunModal, PayrollActionModal, PayrollDecisionModal, PayrollError, PayrollLineNote, PayrollPagination, PayrollPending, usePayrollCaps, usePayrollPager, usePayrollRequests } from './PayrollModals.jsx';
import { canPayLine, dateLabel, errorText, guardRows, guardRun, lastEndedPeriod, moneyLabel, runActions, runNotice } from './payrollUiModel.js';

const nameOf = line => line.snapshot?.employee?.nameEn || line.nameEn || line.snapshot?.employee?.nameKm || line.nameKm || line.staffCode || line.employeeId;
const statusTone = status => ({ draft: 'amber', reviewed: 'amber', approved: 'emerald', paid: 'emerald', void: 'slate' }[status] || 'slate');

export function Payroll() {
  const companyId = useAppStore(s => s.activeCompanyId);
  const caps = usePayrollCaps();
  if (!companyId) return <div className="page"><PageHeader title="Payroll" /><NoCompanyState purpose="manage its payroll" /></div>;
  if (!hasCap(caps, 'payroll.manage')) return <div className="page"><PageHeader title="Payroll" /><EmptyState title="Payroll access required" body="Salary data is available only to accounts with payroll permission." /></div>;
  return <PayrollCompany key={`${companyId}|${JSON.stringify(caps)}`} companyId={companyId} caps={caps} />;
}

function PayrollCompany({ companyId, caps }) {
  const requests = usePayrollRequests(companyId, 'list');
  const tick = useHrTick(['loan', 'payroll']);
  const [month, setMonth] = useState(lastEndedPeriod);
  const [status, setStatus] = useState('');
  const [load, setLoad] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [newRun, setNewRun] = useState(false);
  const [runId, setRunId] = useState(null);
  const [staffOpen, setStaffOpen] = useState(false);
  const filterKey = `${requests.key}|${month}|${status}`;
  const data = load?.key === filterKey && load.companyId === companyId ? load : null;
  const pager = usePayrollPager(data?.runs?.length || 0, filterKey);
  const retry = () => setRefresh(n => n + 1);
  useEffect(() => {
    const ticket = requests.begin('list');
    Promise.all([
      requests.invoke('list', { companyId, ...(month ? { month } : {}), ...(status ? { status } : {}) }, { guard: value => guardRows(value, companyId) }),
      requests.invoke('getSettings', { companyId }),
      requests.invoke('listEmployees', { companyId }, { guard: value => guardRows(value, companyId) }),
      requests.invoke('listRateSets', { companyId }, { guard: value => guardRows(value, companyId) }),
    ]).then(([runs, settings, employees, rateSets]) => {
      if (requests.current(ticket)) setLoad({ key: filterKey, companyId, runs, settings, employees, rateSets });
    }).catch(err => { requests.failure(ticket, err); if (requests.current(ticket)) setLoad({ key: filterKey, companyId, runs: [], error: errorText(err) }); });
  }, [requests, companyId, month, status, filterKey, tick, refresh]);

  if (runId) return <PayrollRunWorkspace key={runId} companyId={companyId} runId={runId} caps={caps} onBack={() => { setRunId(null); retry(); }} />;
  if (staffOpen) return <div className="page"><PageHeader title="Staff pay" backTo={{ label: 'Payroll', onClick: () => setStaffOpen(false) }} /><PayrollStaffPay /></div>;
  return <div className="page">
    <PageHeader title="Payroll" subtitle="Review estimates, freeze approved inputs and record payments explicitly."
      actions={<><Button onClick={() => setStaffOpen(true)}>Staff pay…</Button><Button disabled={!data?.settings} variant="primary" onClick={() => setNewRun(true)}>+ New run…</Button></>} />
    <PayrollPending companyId={companyId} requests={requests} onResolved={(record, result) => { retry(); if (record.method === 'create') setRunId(result.id); }} />
    {data?.settings?.complianceWarning ? <p className="hr-note">{data.settings.complianceWarning}</p> : null}
    <div className="toolbar">
      <Field label="Month">{({ id }) => <Input id={id} type="month" className="hr-date-input" value={month} onChange={e => setMonth(e.target.value)} />}</Field>
      <Field label="Status">{({ id }) => <Select id={id} value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{['draft', 'reviewed', 'approved', 'paid', 'void'].map(s => <option key={s}>{s}</option>)}</Select>}</Field>
      <div className="toolbar__spacer" /><span className="toolbar__count">{data?.runs?.length || 0} runs</span><Button onClick={retry}>Refresh</Button>
    </div>
    <PayrollError message={data?.error} onRetry={retry} />
    {!data ? <p className="muted" role="status">Loading payroll…</p> : !data.error && !data.runs.length ? <EmptyState title="No payroll runs here" body="Choose another month or create a draft for this company." /> : data.runs.length ? <>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Period</th><th>Kind</th><th>Pay date</th><th>Status</th><th className="is-num">Revision</th><th className="is-actions">Action</th></tr></thead><tbody>
        {data.runs.slice(pager.pageStart, pager.pageEnd).map(run => <tr key={run.id}><td>{dateLabel(run.periodStart)} – {dateLabel(run.periodEnd)}</td><td>{run.kind}</td><td>{dateLabel(run.payDate)}</td><td><Badge tone={statusTone(run.status)}>{run.status}</Badge></td><td className="is-num">{run.revision}</td><td className="is-actions"><Button size="sm" onClick={() => setRunId(run.id)}>Open run</Button></td></tr>)}
      </tbody></table></div><PayrollPagination total={data.runs.length} pager={pager} />
    </> : null}
    {newRun && data?.settings ? <NewPayrollRunModal key={companyId} companyId={companyId} settings={data.settings} employees={data.employees} rateSets={data.rateSets} onClose={() => setNewRun(false)} onCreated={run => { setNewRun(false); setRunId(run.id); retry(); }} /> : null}
  </div>;
}

function PayrollRunWorkspace({ companyId, runId, caps, onBack }) {
  const requests = usePayrollRequests(companyId, runId);
  const tick = useHrTick(['loan', 'payroll']);
  const [load, setLoad] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [action, setAction] = useState(null);
  const [employeeId, setEmployeeId] = useState(null);
  const [decision, setDecision] = useState(null);
  const [exportBusy, setExportBusy] = useState(false);
  const addToast = useAppStore(s => s.addToast);
  const data = load?.key === requests.key && load.companyId === companyId && load.runId === runId ? load : null;
  const run = data?.run;
  const selectedLine = run?.lines.find(x => x.employeeId === employeeId);
  const retry = () => setRefresh(n => n + 1);
  useEffect(() => {
    const ticket = requests.begin('run');
    Promise.all([requests.invoke('get', { companyId, id: runId }, { guard: value => guardRun(value, companyId, runId) }), requests.invoke('getSettings', { companyId })])
      .then(([result, settings]) => { if (requests.current(ticket)) setLoad(prev => prev?.run?.revision > result.revision ? prev : { key: requests.key, companyId, runId, run: result, settings }); })
      .catch(err => { requests.failure(ticket, err); if (requests.current(ticket)) setLoad({ key: requests.key, companyId, runId, error: errorText(err) }); });
  }, [requests, companyId, runId, tick, refresh]);
  function changed(result) {
    if (useAppStore.getState().activeCompanyId !== companyId) return;
    // Invalidate reads begun before the mutation, including equal-revision
    // approval/payment changes. Payment balances come back from get, never UI math.
    requests.begin('run');
    if (result.lines && result.id === runId) setLoad(prev => prev?.run?.revision > result.revision ? prev : { ...prev, key: requests.key, companyId, runId, run: result });
    else setLoad(prev => ({ ...prev, key: requests.key, companyId, runId, run: null }));
    setAction(null); setDecision(null); retry();
  }
  async function exportDocument(method, id) {
    if (exportBusy) return;
    const ticket = requests.begin('export'); setExportBusy(true);
    try {
      const path = await requests.invoke(method, { companyId, id });
      if (requests.current(ticket) && path) addToast(`Exported to ${path}`, 'success');
    } catch (err) { requests.failure(ticket, err); }
    finally { if (requests.current(ticket)) setExportBusy(false); }
  }
  if (!run) return <div className="page"><PageHeader title="Payroll run" backTo={{ label: 'Payroll', onClick: onBack }} /><PayrollError message={data?.error} onRetry={retry} />{!data?.error ? <p role="status" className="muted">Loading run…</p> : null}</div>;
  return <div className="page">
    <PayrollPending companyId={companyId} requests={requests} onResolved={(record, result) => { if (['pay', 'reversePayment'].includes(record.method)) changed(result); else retry(); }} />
    <PayrollRunView run={run} companyId={companyId} runId={runId} caps={caps} settings={data.settings} onBack={onBack}
      onAction={next => setAction({ ...next, revision: run.revision })} onLine={line => setEmployeeId(line.employeeId)} onWorkbook={() => exportDocument('saveWorkbook', runId)} onRunPdf={() => exportDocument('saveRunPdf', runId)} exportBusy={exportBusy} />
    {action ? <PayrollActionModal key={`${action.method}:${action.line?.id || action.payment?.id || runId}`} companyId={companyId} run={run} action={action} settings={data.settings} onClose={() => setAction(null)} onChanged={changed} /> : null}
    {selectedLine && !decision ? <Modal open wide title={`${nameOf(selectedLine)} · payslip`} onClose={() => setEmployeeId(null)} footer={<Button onClick={() => setEmployeeId(null)}>Close</Button>}>
      <PayrollLineDetails companyId={companyId} run={run} line={selectedLine} caps={caps} settings={data.settings} onAction={next => { setEmployeeId(null); setAction({ ...next, revision: run.revision }); }}
        onDecision={next => setDecision(next)} onPayslip={() => exportDocument('savePayslipPdf', selectedLine.id)} exportBusy={exportBusy} onChanged={changed} />
    </Modal> : null}
    {decision && selectedLine ? <PayrollDecisionModal key={`${companyId}:${runId}:${selectedLine.employeeId}:${decision.kind}:${decision.date || decision.plan?.loanId}`} companyId={companyId} run={run} line={selectedLine} {...decision} onClose={() => setDecision(null)} onChanged={changed} /> : null}
  </div>;
}

/** Pure view: explicit render keys also guard the pre-effect paint on context changes. */
export function PayrollRunView({ run, companyId, runId, caps, settings, onBack, onAction, onLine, onWorkbook, onRunPdf, exportBusy }) {
  const lines = run?.companyId === companyId && run.id === runId && hasCap(caps, 'payroll.manage') ? run.lines || [] : [];
  const pager = usePayrollPager(lines.length, `${companyId}:${runId}`);
  if (run?.companyId !== companyId || run.id !== runId || !hasCap(caps, 'payroll.manage')) return null;
  const actions = runActions(run, settings, caps);
  const blockers = lines.flatMap(line => line.blockers.map(block => ({ ...block, line })));
  const primary = actions.approve ? 'approve' : actions.review && run.status === 'draft' ? 'review' : actions.calculate ? 'calculate' : null;
  const nextPayment = actions.pay ? lines.find(line => canPayLine(line, run.payments)) : null;
  const labels = { calculate: 'Calculate', review: 'Review', approve: 'Approve' };
  return <>
    <PageHeader title="Payroll run" subtitle={`${dateLabel(run.periodStart)} – ${dateLabel(run.periodEnd)} · ${run.kind || 'regular'} · revision ${run.revision}`}
      backTo={onBack ? { label: 'Payroll', onClick: onBack } : null}
      actions={<><Button disabled={exportBusy || !lines.length} onClick={onRunPdf}>Save run PDF…</Button><Button disabled={exportBusy || !lines.length} onClick={onWorkbook}>Export workbook…</Button>
        {actions.calculate && primary !== 'calculate' ? <Button onClick={() => onAction({ method: 'calculate' })}>Recalculate</Button> : null}
        {primary ? <Button variant="primary" onClick={() => onAction({ method: primary })}>{labels[primary]}</Button> : null}
        {nextPayment ? <Button variant="primary" onClick={() => onAction({ method: 'pay', line: nextPayment })}>Record payment…</Button> : null}
      </>} />
    <p className="hr-note"><Badge tone={statusTone(run.status)}>{run.status}</Badge> {runNotice(run)}</p>
    <div className="hr-totals"><span>Pay date: {dateLabel(run.payDate)}</span><span>{lines.length} staff</span><span>{blockers.length} blockers</span>
      <span>Approval: {settings?.approvalPolicy === 'designated_managers' ? 'Designated payroll managers' : 'Admin'}</span></div>
    {blockers.length ? <section className="hr-note" aria-label="Approval blockers"><strong>Resolve before review</strong><ul>{blockers.slice(0, 5).map((block, i) => <li key={i}>{nameOf(block.line)}: {block.date ? `${dateLabel(block.date)} · ` : ''}{block.message}</li>)}</ul>
      {blockers.length > 5 ? <details><summary>{blockers.length - 5} more blockers</summary><ul>{blockers.slice(5).map((block, i) => <li key={i}>{nameOf(block.line)}: {block.date ? `${dateLabel(block.date)} · ` : ''}{block.message}</li>)}</ul></details> : null}</section> : null}
    {!lines.length ? <EmptyState title="Draft created" body="Calculate to build estimates and see any missing rates, policies or attendance decisions." /> : <>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Staff</th><th>Currency</th><th className="is-num">Gross</th><th className="is-num">Net</th><th className="is-num">Paid</th><th className="is-num">Remaining</th><th>Review</th><th className="is-actions">Action</th></tr></thead><tbody>
        {lines.slice(pager.pageStart, pager.pageEnd).map(line => <tr key={line.id}><td>{nameOf(line)}<div className="muted">{line.snapshot?.employee?.staffCode || line.staffCode}</div></td><td>{line.currency}</td>
          <td className="is-num">{moneyLabel(line.grossMinor, line.currency)}</td><td className="is-num">{moneyLabel(line.netMinor, line.currency)}</td><td className="is-num">{moneyLabel(line.paidMinor, line.currency)}</td><td className="is-num">{moneyLabel(line.remainingMinor, line.currency)}</td>
          <td>{line.blockers.length ? `${line.blockers.length} blockers` : 'Ready'}</td><td className="is-actions"><div className="hr-row-actions"><Button size="sm" onClick={() => onLine(line)}>Details…</Button>{actions.pay && canPayLine(line, run.payments) ? <Button size="sm" onClick={() => onAction({ method: 'pay', line })}>Record payment…</Button> : null}</div></td></tr>)}
      </tbody></table></div><PayrollPagination total={lines.length} pager={pager} />
    </>}
    <details className="hr-subhead"><summary>{actions.editable ? 'Calculation inputs and company policy' : 'Frozen inputs and company policy'}</summary>
      <dl className="fuel-dl"><dt>Statutory set</dt><dd>{run.statutoryRateSetId || 'Unavailable'}</dd><dt>Policy confirmation</dt><dd>{(lines[0]?.snapshot?.settings || settings)?.policyConfirmed ? 'Confirmed with professional evidence' : 'Required before approval'}</dd></dl>
      <p className="muted">Edit company divisor, recovery limits and professional evidence in Settings → Payroll before approval, then recalculate. Run FX, statutory selection and run overrides are fixed at creation; void a draft and create a replacement to change them. Overrides do not bypass confirmation gates.</p>
      <pre className="hr-read__value">{JSON.stringify(run.input || {}, null, 2)}</pre>
    </details>
    <details className="hr-subhead"><summary>Reviews and payments · {run.payments?.length || 0} payment events</summary>
      <PayrollPaymentTable run={run} canReverse={actions.reverse} onAction={onAction} />
      {run.reviews?.map((review, i) => <p key={i}>Reviewed revision {review.revision} · {review.reviewedByUserId || 'Local admin'} · {dateLabel(review.createdAt)}</p>)}
    </details>
    {actions.void ? <div className="hr-actions-row"><Button variant="danger" size="sm" onClick={() => onAction({ method: 'voidRun' })}>Void run…</Button></div> : null}
  </>;
}

function PayrollPaymentTable({ run, canReverse, onAction }) {
  const payments = run.payments || [];
  const pager = usePayrollPager(payments.length, run.id);
  if (!payments.length) return <p className="muted">No payments recorded.</p>;
  return <><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Date</th><th>Staff</th><th className="is-num">Amount</th><th>Method / reference</th><th>Event</th><th className="is-actions">Action</th></tr></thead><tbody>
    {payments.slice(pager.pageStart, pager.pageEnd).map(payment => {
      const line = run.lines.find(x => x.id === payment.lineId);
      const reversed = payments.some(x => x.reversesPaymentId === payment.id);
      return <tr key={payment.id}><td>{dateLabel(payment.paidAt)}</td><td>{line ? nameOf(line) : 'Historical payslip'}</td><td className="is-num">{moneyLabel(payment.amountMinor, line?.currency)}</td><td>{payment.method} · {payment.reference || '—'}</td><td>{payment.reversesPaymentId ? 'Reversal' : reversed ? 'Reversed' : 'Payment'}{payment.reason ? <div className="hr-cell-text muted">{payment.reason}</div> : null}</td><td className="is-actions">{canReverse && !payment.reversesPaymentId && !reversed ? <Button size="sm" variant="danger" onClick={() => onAction({ method: 'reversePayment', payment })}>Reverse…</Button> : null}</td></tr>;
    })}
  </tbody></table></div><PayrollPagination total={payments.length} pager={pager} /></>;
}

function PayrollLineDetails({ companyId, run, line, caps, settings, onAction, onDecision, onPayslip, exportBusy, onChanged }) {
  if (run.companyId !== companyId || line.companyId !== companyId || line.runId !== run.id || !run.lines.some(x => x.id === line.id) || !hasCap(caps, 'payroll.manage')) return null;
  const editable = runActions(run, settings, caps).editable;
  const snapshot = line.snapshot || {};
  const policies = [['Employee policy', snapshot.employeePolicy, false], ['Run override', snapshot.runStatutoryOverride, true], ['Line override', snapshot.lineStatutoryOverride, true], ['Effective policy', snapshot.effectivePolicy ?? snapshot.policy, false]];
  const flagLabel = (policy, key, inherit) => typeof policy?.[key] === 'boolean' ? policy[key] ? 'Apply' : 'Do not apply' : policy === undefined ? 'Not captured' : inherit ? 'Inherit' : 'Not set';
  const amounts = [['baseMinor', 'Base pay'], ['overtimeMinor', 'Overtime'], ['grossMinor', 'Gross'], ['nssfEmployeeMinor', 'Employee NSSF'], ['nssfEmployerMinor', 'Employer NSSF'], ['salaryTaxMinor', 'Salary tax'], ['otherDeductionsMinor', 'Other deductions'], ['loanDeductionMinor', 'Loan withholding'], ['remainingLoanDeductionMinor', 'Withholding to post'], ['advanceMinor', 'Advance paid'], ['netMinor', 'Net'], ['paidMinor', 'Paid'], ['remainingMinor', 'Remaining cash']];
  return <div className="hr-sections">
    <p className="hr-note">{runNotice(run)}</p><div className="hr-actions-row"><Button disabled={exportBusy} onClick={onPayslip}>Save payslip PDF…</Button>{runActions(run, settings, caps).pay && canPayLine(line, run.payments) ? <Button onClick={() => onAction({ method: 'pay', line })}>Record payment…</Button> : null}</div>
    <div className="hr-read-grid">{amounts.map(([key, label]) => <div key={key}><div className="hr-read__label">{label}</div><div className="hr-read__value">{moneyLabel(line[key], line.currency)}</div></div>)}</div>
    <details><summary>Advanced · statutory treatment</summary>
      <p className="muted">Saved calculation inputs: employee policy, then run override, then line override, per flag. Confirmation gates still apply.</p>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Source</th><th>Salary tax</th><th>NSSF</th><th>Saved reason</th></tr></thead><tbody>{policies.map(([label, policy, inherit]) => <tr key={label}><th scope="row">{label}</th><td>{flagLabel(policy, 'applyTax', inherit)}</td><td>{flagLabel(policy, 'applyNssf', inherit)}</td><td className="hr-cell-text">{policy?.reason || '—'}</td></tr>)}</tbody></table></div>
      {editable ? <Button size="sm" onClick={() => onDecision({ kind: 'statutory' })}>Edit statutory treatment…</Button> : null}
    </details>
    <PayrollLeaveBalances snapshot={snapshot} lineId={line.id} />
    {line.blockers.length ? <section><h3 className="section-title">Blockers</h3><ul>{line.blockers.map((block, i) => <li key={i}>{block.date ? `${dateLabel(block.date)} · ` : ''}{block.message}{editable && block.code === 'whole_day_decision' ? <Button size="sm" onClick={() => onDecision({ kind: 'day', date: block.date })}>Decide whole day…</Button> : null}</li>)}</ul></section> : null}
    <details><summary>Whole-day decisions · {line.decisions?.dayDecisions?.length || 0}</summary>
      {(line.decisions?.dayDecisions || []).map(day => <p key={day.date}>{dateLabel(day.date)} · {day.payable ? 'Payable' : 'Unpaid'} · {day.reason} {editable ? <Button size="sm" onClick={() => onDecision({ kind: 'day', date: day.date })}>Edit decision…</Button> : null}</p>)}
    </details>
    <details open={line.snapshot?.loanPlans?.some(x => x.shortfallMinor > 0)}><summary>Frozen loan repayment plans · {line.snapshot?.loanPlans?.length || 0}</summary>
      {(line.snapshot?.loanPlans || []).map(plan => <div key={plan.loanId} className="hr-note"><strong>{plan.loanId}</strong><p>Loan repayment: {moneyLabel(plan.amountMinor, plan.currency)} · Salary withholding: {moneyLabel(plan.salaryAmountMinor, line.currency)}</p>
        {plan.shortfallMinor > 0 ? <p>Shortfall: {moneyLabel(plan.shortfallMinor, plan.currency)}. Reason required.</p> : null}<p>{plan.reason || (plan.postponed ? 'Postponed' : 'Scheduled repayment')}</p>
        {plan.loanRateKhrPerUsd ? <p>FX: {plan.loanRateKhrPerUsd} KHR per USD · {plan.loanRateSource}</p> : null}
        {editable && !plan.postponed ? <Button size="sm" onClick={() => onDecision({ kind: 'loan', plan })}>Decide repayment…</Button> : null}
      </div>)}
    </details>
    {editable ? <PayrollLineNote key={line.employeeId} companyId={companyId} run={run} line={line} onChanged={onChanged} /> : line.decisions?.note ? <p>Review note: {line.decisions.note}</p> : null}
    <details><summary>{editable ? 'Estimated input snapshot and item breakdown' : 'Frozen input snapshot and item breakdown'}</summary>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Item</th><th>Kind</th><th className="is-num">Salary currency</th><th className="is-num">KHR statutory amount</th></tr></thead><tbody>{(line.items || []).map((item, i) => <tr key={i}><td>{item.label}</td><td>{item.kind}</td><td className="is-num">{moneyLabel(item.amountMinor, line.currency)}</td><td className="is-num">{moneyLabel(item.amountKhr, 'KHR')}</td></tr>)}</tbody></table></div>
      <pre className="hr-read__value">{JSON.stringify(line.snapshot, null, 2)}</pre>
    </details>
  </div>;
}

function PayrollLeaveBalances({ snapshot, lineId }) {
  const balances = snapshot.leaveBalances;
  const pager = usePayrollPager(balances?.length || 0, lineId);
  return <details><summary>Leave balances{snapshot.leaveBalanceAsOf ? ` · as of ${dateLabel(snapshot.leaveBalanceAsOf)}` : ''}</summary>
    {!balances ? <p className="muted">Leave balances were not captured for this payslip.</p> : !balances.length ? <p className="muted">No tracked leave types were captured for this payslip.</p> : <>
      <p className="muted">Saved balances at the period end, shown separately by leave type.</p>
      <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Leave type</th><th>Code</th><th className="is-num">Days</th></tr></thead><tbody>{balances.slice(pager.pageStart, pager.pageEnd).map(balance => <tr key={balance.leaveTypeId}><td>{balance.nameEn || balance.nameKm || balance.code}</td><td>{balance.code}</td><td className="is-num">{balance.days}</td></tr>)}</tbody></table></div>
      <PayrollPagination total={balances.length} pager={pager} />
    </>}
  </details>;
}
