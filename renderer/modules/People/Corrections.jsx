/**
 * People → Corrections (HR1, docs/PEOPLE_AND_FUEL_PLAN.md §10).
 *
 * "I forgot to clock out" from the kiosk or a phone arrives as a REQUEST,
 * never an event. A manager approves it — optionally adjusting the times;
 * each time becomes a `correction` entry that supersedes that day's first in
 * / last out (the originals are kept) — or rejects it with a note.
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Pagination, Textarea, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { LoadError, ReasonModal } from '../Fuel/FuelShared.jsx';
import { fmtShort } from '../Fuel/fuelModel.js';
import { useHrCaps, useHrLookups, useHrTick, usePager } from './hrHooks.js';
import { DayDetailModal, HrPermissionNote, PersonCell, ToneBadge, clampServerPage } from './HrShared.jsx';
import { CORRECTION_STATUS, VIA_LABELS, correctionDecision, correctionForm, errText, fmtHmOn, fmtWorkDate, personName, validateCorrectionForm } from './hrModel.js';

const STATUS_VIEWS = [
  { value: 'pending', label: 'Waiting' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: '', label: 'All' },
];

export function Corrections() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canView, canManage } = useHrCaps();
  const lookups = useHrLookups();
  const tick = useHrTick(['correction', 'attendance']);
  const [status, setStatus] = useState('pending');
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [approving, setApproving] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [dayOf, setDayOf] = useState(null);
  const pager = usePager([status, activeCompanyId]);

  useEffect(() => { setData({ items: [], total: 0 }); setError(null); }, [activeCompanyId]);
  useEffect(() => {
    if (!activeCompanyId || !canView) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.attendance.listCorrections({ status: status || undefined, limit: pager.pageSize, offset: pager.offset })
      .then((res) => {
        if (!alive) return;
        setData({ items: res?.items || [], total: res?.total || 0 });
        setError(null);
        clampServerPage(res?.total, pager.page, pager.pageSize, pager.setPage);
      })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, canView, status, pager.page, pager.pageSize, pager.offset, tick, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!activeCompanyId) return <div className="page"><PageHeader title="Corrections" /><NoCompanyState purpose="see its correction requests" /></div>;
  if (!canView) return <div className="page"><PageHeader title="Corrections" /><HrPermissionNote /></div>;

  const person = (id) => lookups.maps.staff.get(id) || { id, nameEn: 'Unknown person' };
  const { items, total } = data;
  const { currentPage, maxPage, pageStart } = paginate(total, pager.page, pager.pageSize);

  return (
    <div className="page page--hr-corrections">
      <PageHeader title="Corrections" subtitle="Requests to fix a day's times — from the kiosk, a phone or a manager. Approving adds correction entries; the originals are kept." />
      <div className="toolbar">
        <span className="toolbar__count">{total} {total === 1 ? 'request' : 'requests'}</span>
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="Status">
          {STATUS_VIEWS.map((v) => <button key={v.value || 'all'} type="button" className={`segment${status === v.value ? ' is-active' : ''}`} onClick={() => setStatus(v.value)}>{v.label}</button>)}
        </div>
      </div>
      {error ? <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} /> : null}
      {loading && !items.length ? <p className="muted">Loading…</p> : !error && items.length === 0 ? (
        <EmptyState title={status === 'pending' ? 'No requests waiting' : 'No requests here'} body={status === 'pending' ? '"I forgot to clock out" requests from the kiosk and phones appear here.' : 'Try another status.'} />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Person</th><th>Day</th><th>Asked for</th><th>Reason</th><th>From</th><th>Status</th>{canManage ? <th className="is-actions" /> : null}</tr></thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td><PersonCell employee={person(c.employeeId)} size={28} /></td>
                  <td className="hr-nowrap"><button type="button" className="link-button" onClick={() => setDayOf(c)}>{fmtWorkDate(c.workDate, { year: true })}</button></td>
                  <td>
                    {c.proposedInAt ? <div>In {fmtHmOn(c.proposedInAt, c.workDate)}</div> : null}
                    {c.proposedOutAt ? <div>Out {fmtHmOn(c.proposedOutAt, c.workDate)}</div> : null}
                  </td>
                  <td className="hr-cell-text">{c.reason}</td>
                  <td>{VIA_LABELS[c.requestedVia] || c.requestedVia}<div className="muted">{fmtShort(c.createdAt)}</div></td>
                  <td>
                    <ToneBadge meta={CORRECTION_STATUS[c.status]} />
                    {c.decisionNote ? <div className="muted">{c.decisionNote}</div> : null}
                  </td>
                  {canManage ? (
                    <td className="is-actions">
                      <div className="hr-row-actions">
                        {c.status === 'pending' ? (
                          <>
                            <Button size="sm" variant="primary" onClick={() => setApproving(c)}>Approve…</Button>
                            <Button size="sm" variant="danger" onClick={() => setRejecting(c)}>Reject…</Button>
                          </>
                        ) : null}
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

      <ApproveCorrectionModal open={!!approving} correction={approving} employee={approving ? person(approving.employeeId) : null} onClose={() => setApproving(null)} />
      <ReasonModal
        open={!!rejecting}
        title="Reject this request?"
        message="Nothing changes in the attendance. Say why."
        label="Note"
        confirmLabel="Reject request"
        danger
        onCancel={() => setRejecting(null)}
        onConfirm={async (note) => {
          await window.api.attendance.decideCorrection({ id: rejecting.id, decision: 'reject', note });
          addToast('Request rejected.', 'success');
          setRejecting(null);
        }}
      />
      <DayDetailModal open={!!dayOf} employee={dayOf ? person(dayOf.employeeId) : null} date={dayOf?.workDate} canManage={canManage} onClose={() => setDayOf(null)} />
    </div>
  );
}

function ApproveCorrectionModal({ open, correction, employee, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState(correctionForm(null));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(correctionForm(correction)); setErrors({}); setBusy(false); } }, [open, correction]);
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setErrors((x) => ({ ...x, [k]: undefined })); };
  async function approve() {
    const errs = validateCorrectionForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await window.api.attendance.decideCorrection({ id: correction.id, decision: 'approve', ...correctionDecision(correction, form) });
      addToast('Approved — the day is corrected.', 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`Approve ${personName(employee)}'s correction`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={approve} disabled={busy}>{busy ? 'Saving…' : 'Approve'}</Button></>}
    >
      <p className="fuel-modal-text">
        {fmtWorkDate(correction?.workDate, { year: true })}. Change a time if the request is not quite right. A clock-out earlier than the clock-in is placed on the next morning (a night shift).
      </p>
      {correction?.reason ? <p className="muted">Their reason: {correction.reason}</p> : null}
      <div className="form-grid">
        <Field label="Clock-in" error={errors.inTime} hint={correction?.proposedInAt ? 'As asked for. Empty it to approve without a clock-in.' : 'Not asked for — empty keeps the day\'s clock-in.'}>
          {({ id }) => <Input id={id} type="time" value={form.inTime} invalid={!!errors.inTime} onChange={set('inTime')} />}
        </Field>
        <Field label="Clock-out" error={errors.outTime} hint={correction?.proposedOutAt ? 'As asked for. Empty it to approve without a clock-out.' : 'Not asked for — empty keeps the day\'s clock-out.'}>
          {({ id }) => <Input id={id} type="time" value={form.outTime} invalid={!!errors.outTime} onChange={set('outTime')} />}
        </Field>
        <Field label="Note" span="full">
          {({ id }) => <Textarea id={id} rows={2} value={form.note} onChange={set('note')} />}
        </Field>
      </div>
      {correction?.status !== 'pending' ? <Badge tone="slate">Already {correction?.status}</Badge> : null}
    </Modal>
  );
}
