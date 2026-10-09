import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Input, Pagination, Select, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { hasCap } from '../../lib/capabilities.js';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useHrTick, usePager } from './hrHooks.js';
import { LoansModals } from './LoansModals.jsx';
import { endOfMonth, filterLoans, formatMinor, loanDialogIsCurrent, makeOperation, pendingAfterFailure, previousMonth, requestIsCurrent, totalsByCurrency } from './loansModel.js';

const STATUSES = [
  { value: 'all', label: 'All loans' }, { value: 'draft', label: 'Draft' }, { value: 'active', label: 'Active' },
  { value: 'paid', label: 'Paid' }, { value: 'written_off', label: 'Written off' }, { value: 'void', label: 'Voided' },
];
const PAGE_SIZE = 50;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthBefore = () => previousMonth(today());
const loanKey = (companyId, id) => `${companyId || ''}|${id || ''}`;
const emptyList = { companyId: null, loans: [], employees: [], policy: null };

export function Loans() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useUserCaps();
  const canManage = hasCap(caps, 'loans.manage');
  const canManageRef = useRef(canManage);
  canManageRef.current = canManage;
  const isAdmin = hasCap(caps, '*');
  const tick = useHrTick(['loan', 'payroll']);
  const [list, setList] = useState(emptyList);
  const [load, setLoad] = useState({ companyId: null, loading: false, error: null });
  const [reload, setReload] = useState(0);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const projectionRequest = useRef(0);
  const contextGeneration = useRef(0);
  const [status, setStatus] = useState('active');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [projectionMonth, setProjectionMonth] = useState(monthBefore);
  const [projection, setProjection] = useState(null);
  const [projectionState, setProjectionState] = useState({ key: null, loading: false, error: null });
  const [dialog, setDialog] = useState(null);
  const [pendingByCompany, setPendingByCompany] = useState({});
  const pendingRef = useRef({});
  const pager = usePager([activeCompanyId, status, search]);
  const listKey = activeCompanyId;
  const currentList = list.companyId === listKey ? list : emptyList;
  const listLoading = load.companyId === activeCompanyId ? load.loading : !!activeCompanyId;
  const staffById = useMemo(() => new Map(currentList.employees.map((employee) => [employee.id, employee])), [currentList.employees]);
  const filtered = useMemo(() => filterLoans(currentList.loans, { status, search }, staffById), [currentList.loans, status, search, staffById]);
  const { pageStart, pageEnd, currentPage, maxPage } = paginate(filtered.length, pager.page, pager.pageSize);
  const shown = filtered.slice(pageStart, pageEnd);
  const totals = useMemo(() => totalsByCurrency(filtered), [filtered]);
  const selectedCompanyId = selected?.companyId;
  const selectedLoanId = selected?.id;
  const selectedKey = selectedCompanyId === activeCompanyId ? loanKey(selectedCompanyId, selectedLoanId) : null;
  const currentDetail = detail?.key === selectedKey ? detail.loan : null;
  const detailLoading = !!selectedKey && detail?.key !== selectedKey;
  const pending = activeCompanyId ? pendingByCompany[activeCompanyId] : null;
  const retryLoad = () => setReload((value) => value + 1);

  useEffect(() => {
    const requestId = ++listRequest.current;
    if (!activeCompanyId || !canManage) {
      setLoad({ companyId: activeCompanyId, loading: false, error: null });
      return () => { listRequest.current += 1; };
    }
    setLoad({ companyId: activeCompanyId, loading: true, error: null });
    Promise.all([
      window.api.loans.list({ companyId: activeCompanyId }),
      window.api.loans.listEmployees({ companyId: activeCompanyId }),
      window.api.loans.getPolicy({ companyId: activeCompanyId }),
    ]).then(([loans, employees, policy]) => {
      if (!requestIsCurrent({ requestId, currentRequestId: listRequest.current, companyId: activeCompanyId, activeCompanyId: useAppStore.getState().activeCompanyId }) || !canManageRef.current) return;
      setList({ companyId: activeCompanyId, loans: loans || [], employees: employees || [], policy: policy || null });
      setLoad({ companyId: activeCompanyId, loading: false, error: null });
    }).catch((error) => {
      if (!requestIsCurrent({ requestId, currentRequestId: listRequest.current, companyId: activeCompanyId, activeCompanyId: useAppStore.getState().activeCompanyId }) || !canManageRef.current) return;
      setLoad({ companyId: activeCompanyId, loading: false, error: error?.message || String(error) });
    });
    return () => { listRequest.current += 1; };
  }, [activeCompanyId, canManage, tick, reload]);

  useEffect(() => {
    if (!selectedKey) return undefined;
    const requestId = ++detailRequest.current;
    setDetail((old) => old?.key === selectedKey ? { ...old, loading: true, error: null } : old);
    window.api.loans.get({ id: selectedLoanId, companyId: selectedCompanyId }).then((loan) => {
      if (!requestIsCurrent({ requestId, currentRequestId: detailRequest.current, companyId: selectedCompanyId, activeCompanyId: useAppStore.getState().activeCompanyId }) || !canManageRef.current) return;
      setDetail({ key: selectedKey, loan, loading: false, error: null });
    }).catch((error) => {
      if (!requestIsCurrent({ requestId, currentRequestId: detailRequest.current, companyId: selectedCompanyId, activeCompanyId: useAppStore.getState().activeCompanyId }) || !canManageRef.current) return;
      setDetail((old) => ({ key: selectedKey, loan: old?.key === selectedKey ? old.loan : null, loading: false, error: error?.message || String(error) }));
    });
    return () => { detailRequest.current += 1; };
  }, [selectedKey, selectedCompanyId, selectedLoanId, tick, reload]);

  useEffect(() => {
    contextGeneration.current += 1;
    projectionRequest.current += 1;
    setList(emptyList);
    setLoad({ companyId: activeCompanyId, loading: false, error: null });
    setSelected(null);
    setDetail(null);
    setDialog(null);
  }, [activeCompanyId, canManage]);

  useEffect(() => {
    setProjection(null);
    setProjectionState({ key: null, loading: false, error: null });
    setProjectionMonth(monthBefore());
    setDialog(null);
  }, [activeCompanyId]);

  async function retryPending(companyId) {
    if (useAppStore.getState().activeCompanyId !== companyId || !canManageRef.current) return false;
    const command = pendingRef.current[companyId];
    if (!command) return false;
    return execute(command);
  }

  async function execute(command) {
    const generation = contextGeneration.current;
    try {
      const result = await window.api.loans[command.method](command.args);
      const next = { ...pendingRef.current };
      delete next[command.companyId];
      pendingRef.current = next;
      setPendingByCompany(next);
      const stillCurrent = generation === contextGeneration.current
        && useAppStore.getState().activeCompanyId === command.companyId && canManageRef.current;
      if (stillCurrent) {
        addToast(command.method === 'approve' ? 'Loan approved.' : 'Loan action saved.', 'success');
        if (command.method === 'create' && result?.id) setSelected({ companyId: command.companyId, id: result.id });
        setReload((value) => value + 1);
      }
      return stillCurrent;
    } catch (error) {
      if (pendingAfterFailure(command, error) === null && pendingRef.current[command.companyId] === command) {
        const next = { ...pendingRef.current };
        delete next[command.companyId];
        pendingRef.current = next;
        setPendingByCompany(next);
      }
      if (generation === contextGeneration.current && useAppStore.getState().activeCompanyId === command.companyId && canManageRef.current) addToast(error?.message || String(error), 'error');
      return false;
    }
  }

  async function submitAction(type, payload, companyId = activeCompanyId) {
    if (!companyId || useAppStore.getState().activeCompanyId !== companyId || !canManageRef.current) return false;
    const existing = pendingRef.current[companyId];
    if (existing) {
      if (existing.method !== type || JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
        addToast('Retry or resolve the pending financial action before starting another one for this company.', 'error');
        return false;
      }
      return execute(existing);
    }
    const operationId = type === 'approve' ? null : globalThis.crypto?.randomUUID?.();
    if (type !== 'approve' && !operationId) {
      addToast('This device could not create a safe operation ID. Please reload and try again.', 'error');
      return false;
    }
    const command = makeOperation(type, companyId, operationId, payload);
    const next = { ...pendingRef.current, [companyId]: command };
    pendingRef.current = next;
    setPendingByCompany(next);
    return execute(command);
  }

  async function loadProjection() {
    if (!currentDetail || !activeCompanyId) return;
    const requestId = ++projectionRequest.current;
    const key = selectedKey;
    const through = endOfMonth(projectionMonth);
    setProjectionState({ key, loading: true, error: null });
    try {
      const result = await window.api.loans.project({ id: currentDetail.id, through, companyId: activeCompanyId });
      if (!requestIsCurrent({ requestId, currentRequestId: projectionRequest.current, companyId: activeCompanyId, activeCompanyId: useAppStore.getState().activeCompanyId }) || key !== selectedKey || !canManageRef.current) return;
      setProjection({ key, through, result });
      setProjectionState({ key, loading: false, error: null });
    } catch (error) {
      if (!requestIsCurrent({ requestId, currentRequestId: projectionRequest.current, companyId: activeCompanyId, activeCompanyId: useAppStore.getState().activeCompanyId }) || key !== selectedKey || !canManageRef.current) return;
      setProjectionState({ key, loading: false, error: error?.message || String(error) });
    }
  }

  if (!activeCompanyId) return <div className="page"><PageHeader title="Loans" /><NoCompanyState purpose="manage its staff loans" /></div>;
  if (!canManage) return <div className="page"><PageHeader title="Loans" /><p className="muted">This needs the “Manage loans” permission. Ask an admin to add it to your role.</p></div>;

  const mayApprove = isAdmin || currentList.policy?.loanApprovalPolicy === 'designated_managers';
  const openDialog = (action) => setDialog({ ...action, companyId: activeCompanyId });
  const person = (employeeId) => staffById.get(employeeId) || { nameEn: 'Staff member' };
  const amount = (value, currency) => formatMinor(Math.abs(value || 0), currency);
  const entryAmount = (value, currency) => `${value < 0 ? '−' : ''}${amount(value, currency)}`;
  const detailBusy = detail?.key === selectedKey && detail.loading;
  const loadError = load.companyId === activeCompanyId ? load.error : null;
  const projectionCurrent = projection?.key === selectedKey ? projection : null;
  const projectionBusy = projectionState.key === selectedKey && projectionState.loading;
  const projectionError = projectionState.key === selectedKey ? projectionState.error : null;

  return (
    <div className="page page--hr-loans">
      <PageHeader title="Loans" subtitle="Company-scoped staff loans, balances and financial history." actions={<Button variant="primary" onClick={() => openDialog({ type: 'create' })} disabled={!!pending || !currentList.companyId}>+ New loan</Button>} />
      {pending ? <div className="card">
        <p><strong>A financial action is waiting for a confirmed result.</strong> Keep the same request key and payload when retrying; do not submit it as a new action.</p>
        <Button size="sm" variant="primary" onClick={async () => { if (await retryPending(activeCompanyId)) setDialog(null); }}>Retry the same request</Button>
      </div> : null}
      {loadError ? <LoadError message={loadError} onRetry={retryLoad} /> : null}
      <div className="toolbar">
        <Select aria-label="Loan status" value={status} onChange={(event) => setStatus(event.target.value)}>
          {STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </Select>
        <Input aria-label="Search loans" placeholder="Search staff or loan number" value={search} onChange={(event) => setSearch(event.target.value)} />
        <span className="toolbar__count">{filtered.length} {filtered.length === 1 ? 'loan' : 'loans'}</span>
        <div className="toolbar__spacer" />
        <span className="muted">USD outstanding: {formatMinor(totals.USD.totalMinor, 'USD')}</span>
        <span className="muted">KHR outstanding: {formatMinor(totals.KHR.totalMinor, 'KHR')}</span>
      </div>
      {listLoading && !currentList.loans.length ? <p className="muted">Loading loans…</p> : null}
      {!loadError && !filtered.length && !listLoading ? <EmptyState title={search || status !== 'all' ? 'No matching loans' : 'No loans yet'} body={search || status !== 'all' ? 'Change the search or status filter.' : 'Create a draft loan to record agreed terms for a staff member.'} action={!search && status === 'all' ? <Button variant="primary" onClick={() => openDialog({ type: 'create' })} disabled={!!pending || !currentList.companyId}>+ New loan</Button> : null} /> : null}
      {filtered.length ? <>
        <div className="data-table-wrap">
          <table className="data-table data-table--sticky">
            <thead><tr><th>Staff member</th><th>Loan</th><th>Status</th><th>Terms</th><th className="is-num">Principal</th><th className="is-num">Interest</th><th className="is-num">Total balance</th></tr></thead>
            <tbody>{shown.map((loan) => (
              <tr key={loan.id} className={`is-clickable${selectedKey === loanKey(activeCompanyId, loan.id) ? ' is-selected' : ''}`} onClick={() => setSelected({ companyId: activeCompanyId, id: loan.id })}>
                <td>{person(loan.employeeId).nameEn || person(loan.employeeId).nameKm || person(loan.employeeId).staffCode || 'Staff member'}{person(loan.employeeId).staffCode ? <div className="muted">{person(loan.employeeId).staffCode}</div> : null}</td>
                <td><button type="button" className="link-button" aria-label={`Open loan ${loan.loanNo || loan.id}`} onClick={() => setSelected({ companyId: activeCompanyId, id: loan.id })}>{loan.loanNo || loan.id}</button></td>
                <td><Badge tone={loan.status === 'active' ? 'emerald' : loan.status === 'draft' ? 'amber' : 'slate'}>{loan.status.replace('_', ' ')}</Badge></td>
                <td>{loan.interestMethod === 'none' ? 'No interest' : 'Declining interest'}{loan.installmentMinor ? <div className="muted">{formatMinor(loan.installmentMinor, loan.currency)} / month</div> : null}</td>
                <td className="is-num">{formatMinor(loan.principalMinor || 0, loan.currency)}</td>
                <td className="is-num">{formatMinor(loan.interestMinor || 0, loan.currency)}</td>
                <td className="is-num">{formatMinor((loan.principalMinor || 0) + (loan.interestMinor || 0), loan.currency)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <Pagination total={filtered.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pager.pageSize} onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize} />
      </> : null}

      {selectedKey ? <section className="card">
        {detailLoading || detailBusy ? <p className="muted">Loading loan history…</p> : currentDetail ? <>
          <div className="section-head">
            <div><h2 className="section-title">{person(currentDetail.employeeId).nameEn || person(currentDetail.employeeId).nameKm || 'Loan'} · {currentDetail.loanNo}</h2><p className="section-hint">{currentDetail.currency} · Disbursed {currentDetail.disbursedOn} · {currentDetail.interestPolicy === 'capitalize' ? 'Unpaid interest capitalized' : 'Interest kept separate'}</p></div>
            <div className="section-head__actions hr-row-actions">
              {currentDetail.status === 'draft' && mayApprove ? <Button size="sm" variant="primary" disabled={!!pending} onClick={() => openDialog({ type: 'approve', loan: currentDetail })}>Approve loan</Button> : null}
              {currentDetail.status === 'draft' && canManage ? <Button size="sm" variant="danger" disabled={!!pending} onClick={() => openDialog({ type: 'voidDraft', loan: currentDetail })}>Cancel draft…</Button> : null}
              {currentDetail.status === 'active' ? <>
                {currentDetail.interestMethod === 'declining' && (isAdmin || currentList.policy?.rateChangePolicy === 'designated_managers') ? <Button size="sm" disabled={!!pending} onClick={() => openDialog({ type: 'changeRate', loan: currentDetail })}>Change rate…</Button> : null}
                {currentDetail.interestMethod === 'declining' ? <Button size="sm" disabled={!!pending} onClick={() => openDialog({ type: 'accrue', loan: currentDetail })}>Post month-end interest…</Button> : null}
                <Button size="sm" disabled={!!pending} onClick={() => openDialog({ type: 'repay', loan: currentDetail })}>Record repayment…</Button>
                {(isAdmin || currentList.policy?.postponementPolicy === 'designated_managers') ? <Button size="sm" disabled={!!pending} onClick={() => openDialog({ type: 'postpone', loan: currentDetail })}>Postpone instalment…</Button> : null}
                {isAdmin ? <Button size="sm" variant="danger" disabled={!!pending} onClick={() => openDialog({ type: 'writeOff', loan: currentDetail })}>Write off…</Button> : null}
              </> : null}
            </div>
          </div>
          {detail?.key === selectedKey && detail.error ? <LoadError message={detail.error} onRetry={retryLoad} /> : null}
          <div className="toolbar">
            <span>Principal: <strong>{formatMinor(currentDetail.principalMinor, currentDetail.currency)}</strong></span>
            <span>Interest: <strong>{formatMinor(currentDetail.interestMinor, currentDetail.currency)}</strong></span>
            <span>Total: <strong>{formatMinor(currentDetail.principalMinor + currentDetail.interestMinor, currentDetail.currency)}</strong></span>
            <div className="toolbar__spacer" />
            <Input aria-label="Projection through month" type="month" value={projectionMonth} onChange={(event) => setProjectionMonth(event.target.value)} />
            <Button size="sm" onClick={loadProjection} disabled={projectionBusy || currentDetail.status === 'draft'}>{projectionBusy ? 'Projecting…' : 'Preview projection'}</Button>
          </div>
          {projectionError ? <LoadError message={projectionError} onRetry={loadProjection} /> : null}
          {projectionCurrent ? <div className="card"><strong>Forecast through {projectionCurrent.through}</strong><Badge tone="amber">Forecast · not posted</Badge><p className="muted">{projectionCurrent.result.note || 'Forecast only. These entries do not post interest or repayments.'}</p>
            {projectionCurrent.result.entries?.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Date</th><th>Forecast item</th><th className="is-num">Principal</th><th className="is-num">Interest</th></tr></thead><tbody>{projectionCurrent.result.entries.map((entry, index) => <tr key={`${entry.entryDate}-${entry.kind}-${index}`}><td>{entry.entryDate}</td><td>{entry.kind === 'interest' ? 'Interest' : entry.kind === 'repayment' ? 'Assumed instalment' : entry.kind}</td><td className="is-num">{entryAmount(entry.principalPart || 0, currentDetail.currency)}</td><td className="is-num">{entryAmount(entry.interestPart || 0, currentDetail.currency)}</td></tr>)}</tbody></table></div> : <p className="muted">No projected entries in this period.</p>}
            <p>Projected balance: {formatMinor(projectionCurrent.result.principalMinor, currentDetail.currency)} principal + {formatMinor(projectionCurrent.result.interestMinor, currentDetail.currency)} interest.</p>
          </div> : null}
          <div className="section-head"><h3 className="section-title">Ledger</h3><span className="muted">{currentDetail.entries?.length || 0} entries</span></div>
          {currentDetail.entries?.length ? <Ledger loan={currentDetail} canAdmin={isAdmin} disabled={!!pending} onReverse={(entry) => openDialog({ type: 'reverseEntry', loan: currentDetail, entry })} /> : <p className="muted">No posted entries. Approval records the disbursement.</p>}
          {currentDetail.rates?.length ? <><h3 className="section-title">Rate history</h3><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Effective from</th><th className="is-num">Monthly rate</th><th>Reason</th></tr></thead><tbody>{currentDetail.rates.map((rate) => <tr key={rate.id}><td>{rate.effectiveFrom}</td><td className="is-num">{rate.ratePercent}%</td><td>{rate.reason || 'Agreed starting rate'}</td></tr>)}</tbody></table></div></> : null}
          {currentDetail.postponements?.length ? <><h3 className="section-title">Postponements</h3><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Month</th><th>Reason</th></tr></thead><tbody>{currentDetail.postponements.map((item) => <tr key={item.month}><td>{item.month}</td><td>{item.reason}</td></tr>)}</tbody></table></div></> : null}
        </> : detail?.key === selectedKey && detail.error ? <LoadError message={detail.error} onRetry={retryLoad} /> : <p className="muted">Loan details are not available.</p>}
      </section> : null}

      <LoansModals
        dialog={loanDialogIsCurrent(dialog, activeCompanyId) ? dialog : null}
        companyId={activeCompanyId}
        employees={currentList.employees}
        policy={currentList.policy}
        pending={pending}
        onClose={() => setDialog(null)}
        onSubmit={submitAction}
        onRetry={() => retryPending(activeCompanyId)}
        onDone={() => setDialog(null)}
      />
    </div>
  );
}

function Ledger({ loan, canAdmin, disabled, onReverse }) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  useEffect(() => { setPage(0); }, [loan.id, loan.entries?.length]);
  const { pageStart, pageEnd, currentPage, maxPage } = paginate(loan.entries?.length || 0, page, pageSize);
  const rows = (loan.entries || []).slice(pageStart, pageEnd).reverse();
  return <>
    <div className="data-table-wrap"><table className="data-table data-table--sticky"><thead><tr><th>Date</th><th>Entry</th><th>Source</th><th>Note</th><th className="is-num">Principal change</th><th className="is-num">Interest change</th>{canAdmin ? <th className="is-actions" /> : null}</tr></thead><tbody>{rows.map((entry) => <tr key={entry.id}>
      <td>{entry.entryDate}</td><td>{entry.kind.replace('_', ' ')}</td><td>{entry.source || '—'}</td><td className="hr-cell-text">{entry.note || entry.period || '—'}</td>
      <td className="is-num">{entry.principalPart < 0 ? '−' : ''}{formatMinor(Math.abs(entry.principalPart || 0), loan.currency)}</td>
      <td className="is-num">{entry.interestPart < 0 ? '−' : ''}{formatMinor(Math.abs(entry.interestPart || 0), loan.currency)}</td>
      {canAdmin ? <td className="is-actions">{entry.kind !== 'reversal' && !entry.reversedAt && ['active', 'paid', 'written_off'].includes(loan.status)
        ? entry.paymentId ? <span className="muted">Reverse in payroll</span> : <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onReverse(entry)}>Reverse…</Button>
        : null}</td> : null}
    </tr>)}</tbody></table></div>
    {loan.entries.length > 0 ? <Pagination total={loan.entries.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} /> : null}
  </>;
}
