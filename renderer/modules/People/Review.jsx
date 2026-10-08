/**
 * People → Review (HR1, docs/PEOPLE_AND_FUEL_PLAN.md §7b, §10).
 *
 * Phone selfies, supervisor marks, entries that waited offline ("held" — not
 * counted until accepted) and day shifts closed after midnight (`late_close`),
 * each with the clock-in photo beside the person's staff photo (hr.manage —
 * hr.view sees the list without photos). Accept, or Reject with a reason
 * (that voids the entry). Above the list: open alerts — a PIN that locked, a
 * kiosk that paused — with Acknowledge and, for a lock, Unlock PIN.
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Pagination, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { LoadError, ReasonModal, StaffAvatar } from '../Fuel/FuelShared.jsx';
import { fmtShort } from '../Fuel/fuelModel.js';
import { primeAttendanceThumbs, useHrCaps, useHrLookups, useHrTick, usePager } from './hrHooks.js';
import { AttendancePhotoModal, AttendancePhotoThumb, HrPermissionNote, PersonCell, clampServerPage } from './HrShared.jsx';
import { alertKindLabel, errText, eventBadges, fmtHmOn, fmtWorkDate, personName, sourceLabel } from './hrModel.js';

const STATUS_VIEWS = [
  { value: 'pending', label: 'Waiting' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];
// Default: held + flagged entries first, then newest (verification 2026-10-08 —
// oldest-first left a fresh held entry on page 2).
const ORDERS = [
  { value: 'attention', label: 'Needs a look first' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];
const SOURCE_FILTERS = [
  { value: '', label: 'Every source' },
  { value: 'phone', label: 'Own phone' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'kiosk', label: 'Shop kiosk' },
];

export function Review() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canView, canManage } = useHrCaps();
  const lookups = useHrLookups();
  const tick = useHrTick(['attendance', 'alert', 'staff']);
  const [status, setStatus] = useState('pending');
  const [source, setSource] = useState('');
  const [order, setOrder] = useState('attention');
  const [data, setData] = useState({ items: [], total: 0, alerts: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [rejecting, setRejecting] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const pager = usePager([status, source, order, activeCompanyId]);

  useEffect(() => { setData({ items: [], total: 0, alerts: [] }); setError(null); }, [activeCompanyId]);
  useEffect(() => {
    if (!activeCompanyId || !canView) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.attendance.listReview({ status, source: source || undefined, order, limit: pager.pageSize, offset: pager.offset })
      .then((res) => {
        if (!alive) return;
        // One call for the whole page of thumbnails, before they render (hr.manage only).
        if (canManage) primeAttendanceThumbs(res?.items);
        setData({ items: res?.items || [], total: res?.total || 0, alerts: res?.alerts || [] });
        setError(null);
        clampServerPage(res?.total, pager.page, pager.pageSize, pager.setPage);
      })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, canView, canManage, status, source, order, pager.page, pager.pageSize, pager.offset, tick, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  const person = (id) => lookups.maps.staff.get(id) || null;
  const refresh = () => setRetry((n) => n + 1);

  async function accept(ev) {
    setBusyId(ev.id);
    try {
      await window.api.attendance.review(ev.id, 'accept');
      addToast(ev.held ? 'Accepted — it counts now.' : 'Accepted.', 'success');
      refresh();
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setBusyId(null); }
  }
  async function ack(alert) {
    setBusyId(alert.id);
    try { await window.api.attendance.ackAlert(alert.id); addToast('Marked as seen.', 'success'); refresh(); }
    catch (err) { addToast(errText(err), 'error'); }
    finally { setBusyId(null); }
  }
  async function unlock(alert) {
    setBusyId(alert.id);
    try {
      await window.api.hr.unlockPin(alert.employeeId);
      await window.api.attendance.ackAlert(alert.id);
      addToast(`${personName(person(alert.employeeId))}'s PIN is unlocked.`, 'success');
      refresh();
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setBusyId(null); }
  }

  if (!activeCompanyId) return <div className="page"><PageHeader title="Review" /><NoCompanyState purpose="review its clock-ins" /></div>;
  if (!canView) return <div className="page"><PageHeader title="Review" /><HrPermissionNote /></div>;

  const { items, total, alerts } = data;
  const { currentPage, maxPage, pageStart } = paginate(total, pager.page, pager.pageSize);

  return (
    <div className="page page--hr-review">
      <PageHeader
        title="Review"
        subtitle={canManage
          ? 'Phone and supervisor clock-ins, entries sent late, and shifts closed after midnight. Compare the photos, then accept or reject.'
          : 'Phone and supervisor clock-ins waiting for a manager. Photos are shown only to people who manage staff.'}
      />

      {status === 'pending' && alerts.length ? (
        <section className="hr-alerts" aria-label="Alerts">
          <h2 className="section-title">Alerts</h2>
          {alerts.map((a) => (
            <div key={a.id} className="hr-alert" role="status">
              <Badge tone={a.kind === 'pin_locked' ? 'rose' : 'amber'}>{alertKindLabel(a.kind)}</Badge>
              <div className="hr-alert__body">
                <div>{a.message}</div>
                <div className="muted">{fmtShort(a.at)}</div>
              </div>
              {canManage ? (
                <div className="hr-alert__actions">
                  {a.kind === 'pin_locked' && a.employeeId ? <Button size="sm" variant="primary" onClick={() => unlock(a)} disabled={busyId === a.id}>Unlock PIN</Button> : null}
                  <Button size="sm" onClick={() => ack(a)} disabled={busyId === a.id}>Mark as seen</Button>
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <div className="toolbar">
        <select className="input input--select" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
          {SOURCE_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select className="input input--select" aria-label="Order" value={order} onChange={(e) => setOrder(e.target.value)}>
          {ORDERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="toolbar__count">{total} {total === 1 ? 'entry' : 'entries'}</span>
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="Status">
          {STATUS_VIEWS.map((v) => <button key={v.value} type="button" className={`segment${status === v.value ? ' is-active' : ''}`} onClick={() => setStatus(v.value)}>{v.label}</button>)}
        </div>
      </div>

      {error ? <LoadError message={error} onRetry={refresh} /> : null}
      {loading && !items.length ? <p className="muted">Loading…</p> : !error && items.length === 0 ? (
        <EmptyState
          title={status === 'pending' ? 'Nothing to review' : 'No entries here'}
          body={status === 'pending' ? 'Phone and supervisor clock-ins appear here as they arrive.' : 'Try another status or source.'}
        />
      ) : (
        <div className="hr-review-list">
          {items.map((ev) => {
            const emp = person(ev.employeeId);
            return (
              <article key={ev.id} className={`hr-review${ev.held ? ' is-held' : ''}`}>
                <div className="hr-review__photos">
                  {canManage ? (
                    <>
                      <figure>
                        <AttendancePhotoThumb event={ev} size={120} onOpen={() => setViewing(ev)} />
                        <figcaption className="muted">{ev.kind === 'out' ? 'Clock-out' : 'Clock-in'} photo</figcaption>
                      </figure>
                      <figure>
                        <span className="hr-review__ref"><StaffAvatar employee={emp} size={120} /></span>
                        <figcaption className="muted">Staff photo</figcaption>
                      </figure>
                    </>
                  ) : (
                    <figure>
                      <span className="hr-review__ref"><StaffAvatar employee={emp} size={88} /></span>
                      <figcaption className="muted">Staff photo</figcaption>
                    </figure>
                  )}
                </div>
                <div className="hr-review__body">
                  <PersonCell employee={emp || { id: ev.employeeId, nameEn: 'Unknown person' }} size={0} sub={emp?.staffCode} />
                  <div className="hr-review__when">
                    <strong>{ev.kind === 'out' ? 'Clock-out' : 'Clock-in'} {fmtHmOn(ev.at, ev.workDate)}</strong>
                    <span className="muted"> · {fmtWorkDate(ev.workDate, { year: true })} · {sourceLabel(ev.source)}{ev.deviceLabel ? ` (${ev.deviceLabel})` : ''}</span>
                  </div>
                  <div className="hr-badges">{eventBadges(ev).map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}</div>
                  <p className="hr-review__why">{ev.explanation}</p>
                  {ev.note && ev.note !== ev.explanation ? <p className="muted">Note: {ev.note}</p> : null}
                  {ev.reviewNote ? <p className="muted">Review note: {ev.reviewNote}</p> : null}
                </div>
                {canManage && ev.reviewStatus === 'pending' ? (
                  <div className="hr-review__actions">
                    <Button variant="primary" onClick={() => accept(ev)} disabled={busyId === ev.id}>Accept</Button>
                    <Button variant="danger" onClick={() => setRejecting(ev)} disabled={busyId === ev.id}>Reject…</Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {total ? (
        <Pagination
          total={total}
          pageStart={pageStart}
          pageEnd={Math.min(pageStart + items.length, total)}
          currentPage={currentPage}
          maxPage={maxPage}
          pageSize={pager.pageSize}
          onPageChange={pager.setPage}
          onPageSizeChange={pager.setPageSize}
        />
      ) : null}

      <ReasonModal
        open={!!rejecting}
        title="Reject this entry?"
        message="It is voided and stops counting. Say why — the person's manager may ask."
        confirmLabel="Reject entry"
        danger
        onCancel={() => setRejecting(null)}
        onConfirm={async (reason) => {
          await window.api.attendance.review(rejecting.id, 'reject', reason);
          addToast('Rejected.', 'success');
          setRejecting(null);
          refresh();
        }}
      />
      <AttendancePhotoModal open={!!viewing} event={viewing} employee={viewing ? person(viewing.employeeId) : null} onClose={() => setViewing(null)} />
    </div>
  );
}
