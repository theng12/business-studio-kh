/**
 * People → Leave (HR1, docs/PEOPLE_AND_FUEL_PLAN.md §3.2, §10).
 *
 *   Requests   the inbox (kiosk, phone, manager): approve — asking before a
 *              balance goes below zero — reject with a note, cancel with a
 *              reason (approved days go back as an adjustment); request on
 *              someone's behalf
 *   Balances   per person per kind of leave (the sum of the ledger); a row
 *              opens that person's ledger, with Adjust… for opening balances
 *
 * Nothing is deleted: a request is rejected or cancelled, a ledger row is
 * balanced by another row.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Modal, Pagination, Select, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { fmtShort } from '../Fuel/fuelModel.js';
import { useHrCaps, useHrLookups, useHrTick, usePager } from './hrHooks.js';
import { HrPermissionNote, PersonCell, ToneBadge, clampServerPage } from './HrShared.jsx';
import { AdjustBalanceModal, LeaveRequestModal, LedgerTable, useLeaveDecisions } from './LeaveModals.jsx';
import { LEAVE_STATUS, VIA_LABELS, errText, fmtDateRange, fmtDays, leaveTypeName, personName } from './hrModel.js';

const VIEWS = [{ value: 'requests', label: 'Requests' }, { value: 'balances', label: 'Balances' }];
const STATUS_VIEWS = [
  { value: 'pending', label: 'Waiting' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: '', label: 'All' },
];

export function Leave() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const { canView, canManage } = useHrCaps();
  const lookups = useHrLookups();
  const [view, setView] = useState('requests');
  const [requesting, setRequesting] = useState(false);

  if (!activeCompanyId) return <div className="page"><PageHeader title="Leave" /><NoCompanyState purpose="manage its leave" /></div>;
  if (!canView) return <div className="page"><PageHeader title="Leave" /><HrPermissionNote /></div>;

  return (
    <div className="page page--hr-leave">
      <PageHeader
        title="Leave"
        subtitle="Requests from the kiosk, phones and managers, and what everyone has left."
        actions={canManage ? <Button variant="primary" onClick={() => setRequesting(true)}>+ Request leave…</Button> : null}
      />
      {view === 'requests'
        ? <Requests lookups={lookups} canManage={canManage} view={view} setView={setView} />
        : <Balances lookups={lookups} canManage={canManage} view={view} setView={setView} />}
      <LeaveRequestModal open={requesting} staff={lookups.staff} types={lookups.leaveTypes} onClose={() => setRequesting(false)} />
    </div>
  );
}

function ViewSwitch({ view, setView }) {
  return (
    <div className="segments" role="tablist" aria-label="View">
      {VIEWS.map((v) => <button key={v.value} type="button" className={`segment${view === v.value ? ' is-active' : ''}`} onClick={() => setView(v.value)}>{v.label}</button>)}
    </div>
  );
}

function Requests({ lookups, canManage, view, setView }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const tick = useHrTick(['leave']);
  const [status, setStatus] = useState('pending');
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const pager = usePager([status, activeCompanyId]);
  const refresh = () => setRetry((n) => n + 1);
  const decisions = useLeaveDecisions(refresh);

  useEffect(() => { setData({ items: [], total: 0 }); setError(null); }, [activeCompanyId]);
  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let alive = true;
    setLoading(true);
    window.api.leave.listRequests({ status: status || undefined, limit: pager.pageSize, offset: pager.offset })
      .then((res) => {
        if (!alive) return;
        setData({ items: res?.items || [], total: res?.total || 0 });
        setError(null);
        clampServerPage(res?.total, pager.page, pager.pageSize, pager.setPage);
      })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, status, pager.page, pager.pageSize, pager.offset, tick, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  const { items, total } = data;
  const { currentPage, maxPage, pageStart } = paginate(total, pager.page, pager.pageSize);
  const person = (id) => lookups.maps.staff.get(id) || { id, nameEn: 'Unknown person' };
  return (
    <>
      <div className="toolbar">
        <div className="segments" role="tablist" aria-label="Status">
          {STATUS_VIEWS.map((v) => <button key={v.value || 'all'} type="button" className={`segment${status === v.value ? ' is-active' : ''}`} onClick={() => setStatus(v.value)}>{v.label}</button>)}
        </div>
        <span className="toolbar__count">{total} {total === 1 ? 'request' : 'requests'}</span>
        <div className="toolbar__spacer" />
        <ViewSwitch view={view} setView={setView} />
      </div>
      {error ? <LoadError message={error} onRetry={refresh} /> : null}
      {loading && !items.length ? <p className="muted">Loading…</p> : !error && items.length === 0 ? (
        <EmptyState title={status === 'pending' ? 'No requests waiting' : 'No requests here'} body={status === 'pending' ? 'Requests from the kiosk and phones appear here.' : 'Try another status.'} />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Person</th><th>Leave</th><th>When</th><th className="is-num">Days</th><th>Reason</th><th>Asked</th><th>Status</th>{canManage ? <th className="is-actions" /> : null}</tr></thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td><PersonCell employee={person(r.employeeId)} size={28} /></td>
                  <td>{leaveTypeName(lookups.maps.leaveTypes.get(r.leaveTypeId))}</td>
                  <td>{fmtDateRange(r.fromDate, r.toDate)}{r.halfDay ? <div className="muted">{r.halfDay === 'am' ? 'Morning' : 'Afternoon'} only</div> : null}</td>
                  <td className="is-num">{fmtDays(r.days)}</td>
                  <td className="hr-cell-text">{r.reason || <span className="muted">—</span>}</td>
                  <td>{VIA_LABELS[r.requestedVia] || r.requestedVia || '—'}<div className="muted">{fmtShort(r.createdAt)}</div></td>
                  <td>
                    <ToneBadge meta={LEAVE_STATUS[r.status]} />
                    {r.decisionNote ? <div className="muted">{r.decisionNote}</div> : null}
                    {r.cancelReason ? <div className="muted">{r.cancelReason}</div> : null}
                  </td>
                  {canManage ? (
                    <td className="is-actions">
                      <div className="hr-row-actions">
                        {r.status === 'pending' ? <Button size="sm" variant="primary" onClick={() => decisions.approve(r)} disabled={decisions.busyId === r.id}>Approve</Button> : null}
                        {r.status === 'pending' ? <Button size="sm" variant="ghost" onClick={() => decisions.reject(r)}>Reject…</Button> : null}
                        {r.status === 'pending' || r.status === 'approved' ? <Button size="sm" variant="ghost" onClick={() => decisions.cancel(r)}>Cancel…</Button> : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total ? (
        <Pagination total={total} pageStart={pageStart} pageEnd={Math.min(pageStart + items.length, total)} currentPage={currentPage} maxPage={maxPage}
          pageSize={pager.pageSize} onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize} />
      ) : null}
      {decisions.dialogs}
    </>
  );
}

function Balances({ lookups, canManage, view, setView }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const tick = useHrTick(['leave', 'leaveType']);
  const [status, setStatus] = useState('active');
  const [balances, setBalances] = useState({}); // employeeId → Balance[]
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [opened, setOpened] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const people = useMemo(() => lookups.staff.filter((e) => (status === 'all' ? true : e.status !== 'left')), [lookups.staff, status]);
  const types = lookups.leaveTypes.filter((t) => t.tracksBalance && !t.archived);
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(people.length, page, pageSize);
  const shown = people.slice(pageStart, pageEnd);
  const shownKey = shown.map((e) => e.id).join(',');

  useEffect(() => { setBalances({}); setOpened(null); }, [activeCompanyId]);
  useEffect(() => { setPage(0); }, [status, pageSize]);
  useEffect(() => {
    if (!activeCompanyId || !shownKey) return undefined;
    let alive = true;
    const ids = shownKey.split(',');
    Promise.all(ids.map((id) => window.api.leave.balances(id).then((b) => [id, b])))
      .then((pairs) => { if (alive) { setBalances(Object.fromEntries(pairs)); setError(null); } })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [activeCompanyId, shownKey, tick, retry]);

  return (
    <>
      <div className="toolbar">
        <Select aria-label="Who" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Working and suspended</option>
          <option value="all">Everyone, incl. left</option>
        </Select>
        <span className="toolbar__count">{people.length} {people.length === 1 ? 'person' : 'people'}</span>
        <div className="toolbar__spacer" />
        <ViewSwitch view={view} setView={setView} />
      </div>
      {error ? <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} /> : null}
      {!lookups.loaded ? <p className="muted">Loading…</p> : people.length === 0 ? (
        <EmptyState title="No staff yet" body="Add staff on the Staff page." />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table data-table--sticky">
            <thead>
              <tr><th>Person</th>{types.map((t) => <th key={t.id} className="is-num">{leaveTypeName(t)}</th>)}<th className="is-num">Waiting</th></tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const list = balances[e.id] || null;
                const by = new Map((list || []).map((b) => [b.leaveTypeId, b]));
                const pending = (list || []).reduce((s, b) => s + (b.pendingDays || 0), 0);
                return (
                  <tr key={e.id} className="is-clickable" onClick={() => setOpened(e)}>
                    <td><PersonCell employee={e} size={28} sub={e.staffCode} /></td>
                    {types.map((t) => {
                      const b = by.get(t.id);
                      return <td key={t.id} className={`is-num${b && b.balance < 0 ? ' hr-negative' : ''}`}>{list ? fmtDays(b?.balance) : '…'}</td>;
                    })}
                    <td className="is-num">{list ? (pending ? fmtDays(pending) : '—') : '…'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {people.length ? (
        <Pagination total={people.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
      ) : null}
      <LedgerModal open={!!opened} employee={opened} lookups={lookups} canManage={canManage} onClose={() => setOpened(null)} />
    </>
  );
}

/** One person's balances and ledger, with Adjust… */
export function LedgerModal({ open, employee, lookups, canManage, onClose }) {
  const tick = useHrTick(['leave', 'leaveType']);
  const [balances, setBalances] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [typeId, setTypeId] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (open) setTypeId(''); }, [open, employee?.id]);
  useEffect(() => {
    if (!open || !employee?.id) return undefined;
    let alive = true;
    Promise.all([window.api.leave.balances(employee.id), window.api.leave.ledger(employee.id, typeId || undefined)])
      .then(([b, l]) => { if (alive) { setBalances(b || []); setLedger(l || []); setError(null); } })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [open, employee?.id, typeId, tick]);
  return (
    <>
      <Modal
        open={open && !adjusting}
        onClose={onClose}
        size="lg"
        title={`${personName(employee)} — leave`}
        footer={canManage ? <Button onClick={() => setAdjusting(true)}>Adjust balance…</Button> : null}
      >
        {error ? <p className="field__error">{error}</p> : null}
        <BalanceTable balances={balances} />
        <div className="section-head hr-subhead">
          <h3 className="section-title">Ledger</h3>
          <div className="section-head__actions">
            <Select aria-label="Kind of leave" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Every kind</option>
              {lookups.leaveTypes.filter((t) => t.tracksBalance).map((t) => <option key={t.id} value={t.id}>{leaveTypeName(t)}</option>)}
            </Select>
          </div>
        </div>
        <LedgerTable rows={ledger} types={lookups.maps.leaveTypes} />
      </Modal>
      <AdjustBalanceModal open={open && adjusting} employee={employee} types={lookups.leaveTypes} onClose={() => setAdjusting(false)} />
    </>
  );
}

export function BalanceTable({ balances }) {
  if (!balances?.length) return <p className="muted">No kinds of leave yet — add them in Settings → People.</p>;
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr><th>Kind of leave</th><th className="is-num">Balance</th><th className="is-num">Taken this year</th><th className="is-num">Waiting</th></tr></thead>
        <tbody>
          {balances.map((b) => (
            <tr key={b.leaveTypeId}>
              <td>{b.nameEn || b.nameKm || b.code}{b.paid ? '' : <span className="muted"> (unpaid)</span>}</td>
              <td className={`is-num${b.balance < 0 ? ' hr-negative' : ''}`}>{b.tracksBalance ? `${fmtDays(b.balance)} d` : <span className="muted">Not counted</span>}</td>
              <td className="is-num">{fmtDays(b.takenThisYear)}</td>
              <td className="is-num">{b.pendingDays ? fmtDays(b.pendingDays) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
