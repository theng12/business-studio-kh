/**
 * People → Lateness (HR1, docs/PEOPLE_AND_FUEL_PLAN.md §7b, §10).
 *
 * Per month per person: the late and early-leave minutes the attendance
 * shows. A manager confirms a finished month for payroll (HR2 deducts only a
 * confirmed month, and never more than the attendance shows now) — at the
 * computed figure, or lower as a waiver with a note. A confirmation whose
 * days changed afterwards is flagged "Needs re-confirming".
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Field, Input, Modal, Pagination, Textarea, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useHrCaps, useHrLookups, useHrTick } from './hrHooks.js';
import { HrPermissionNote, MonthSelect, PersonCell, ToneBadge } from './HrShared.jsx';
import {
  LATENESS_STATE, errText, latenessState, monthEnded, monthLabel, personName, ppMonthKey, prevMonth, validateLatenessForm,
} from './hrModel.js';

const VIEWS = [{ value: 'late', label: 'Someone late' }, { value: 'all', label: 'Everyone' }];

export function Lateness() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canView, canManage } = useHrCaps();
  const lookups = useHrLookups();
  const tick = useHrTick(['attendance', 'lateness', 'correction', 'leave', 'holiday', 'schedule', 'settings']);
  const [month, setMonth] = useState(prevMonth(ppMonthKey()));
  const [view, setView] = useState('late');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [waiving, setWaiving] = useState(null);
  const [busy, setBusy] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => { setData(null); setError(null); }, [activeCompanyId]);
  useEffect(() => { setPage(0); }, [month, view, pageSize, activeCompanyId]);
  useEffect(() => {
    if (!activeCompanyId || !canView) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.attendance.monthSummary({ month })
      .then((summary) => { if (alive) { setData(summary); setError(null); } })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, canView, month, tick, retry]);

  const rows = useMemo(() => {
    const list = (data?.month === month ? data.rows : []).map((r) => ({ ...r, state: latenessState(r) }));
    return view === 'late' ? list.filter((r) => r.state !== 'none') : list;
  }, [data, month, view]);
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(rows.length, page, pageSize);
  const ended = monthEnded(month);
  const refresh = () => setRetry((n) => n + 1);

  async function confirmRow(r) {
    setBusy(r.employeeId);
    try {
      await window.api.attendance.confirmLateness({ employeeId: r.employeeId, month });
      addToast(`Confirmed ${personName(r)}'s ${monthLabel(month)}.`, 'success');
      refresh();
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setBusy(null); }
  }
  async function confirmAll() {
    const list = rows.filter((r) => r.state === 'open' || r.state === 'reapprove' || r.state === 'exceeds');
    if (!list.length) return;
    const ok = await confirm({
      title: `Confirm ${list.length} ${list.length === 1 ? 'person' : 'people'} for ${monthLabel(month)}?`,
      message: 'Each is confirmed at the minutes the attendance shows now — no waivers. Payroll can then deduct them.',
      confirmLabel: 'Confirm all',
    });
    if (!ok) return;
    setBusy('all');
    let done = 0;
    const failed = [];
    for (const r of list) {
      try { await window.api.attendance.confirmLateness({ employeeId: r.employeeId, month }); done += 1; }
      catch (err) { failed.push(`${personName(r)}: ${errText(err)}`); }
    }
    setBusy(null);
    refresh();
    if (failed.length) addToast(`Confirmed ${done}; ${failed.length} failed — ${failed[0]}`, 'error');
    else addToast(`Confirmed ${done}.`, 'success');
  }

  if (!activeCompanyId) return <div className="page"><PageHeader title="Lateness" /><NoCompanyState purpose="confirm its lateness" /></div>;
  if (!canView) return <div className="page"><PageHeader title="Lateness" /><HrPermissionNote /></div>;

  const waiting = rows.some((r) => r.state === 'open' || r.state === 'reapprove' || r.state === 'exceeds');
  return (
    <div className="page page--hr-lateness">
      <PageHeader
        title="Lateness"
        subtitle="Late and early-leave minutes per month. Payroll deducts a month only once it is confirmed here, and never more than the attendance shows."
        actions={canManage && ended ? <Button variant="primary" onClick={confirmAll} disabled={!waiting || busy === 'all'}>{busy === 'all' ? 'Confirming…' : 'Confirm all…'}</Button> : null}
      />
      <div className="toolbar">
        <MonthSelect value={month} onChange={setMonth} />
        <span className="toolbar__count">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>
        {!ended ? <span className="muted">This month is not over yet — it can be confirmed from the 1st of next month.</span> : null}
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="Who">
          {VIEWS.map((v) => <button key={v.value} type="button" className={`segment${view === v.value ? ' is-active' : ''}`} onClick={() => setView(v.value)}>{v.label}</button>)}
        </div>
      </div>
      {error ? <LoadError message={error} onRetry={refresh} /> : null}
      {loading && !rows.length ? <p className="muted">Loading…</p> : !error && rows.length === 0 ? (
        <EmptyState title={view === 'late' ? 'Nobody was late' : 'No staff this month'} body={view === 'late' ? `No late or early-leave minutes in ${monthLabel(month)}.` : 'Add staff on the Staff page.'} />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table data-table--sticky">
            <thead>
              <tr>
                <th>Person</th><th className="is-num">Late</th><th className="is-num">Left early</th>
                <th className="is-num">Confirmed late</th><th className="is-num">Confirmed early</th><th className="is-num">Payroll may deduct</th>
                <th>Status</th>{canManage ? <th className="is-actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.slice(pageStart, pageEnd).map((r) => {
                const t = r.totals || {};
                const l = r.lateness;
                return (
                  <tr key={r.employeeId}>
                    <td><PersonCell employee={lookups.maps.staff.get(r.employeeId) || { id: r.employeeId, nameEn: r.nameEn, nameKm: r.nameKm, staffCode: r.staffCode }} size={26} /></td>
                    <td className="is-num hr-nowrap">{t.lateMin ? `${t.lateMin} min · ${t.lateDays} d` : '—'}</td>
                    <td className="is-num hr-nowrap">{t.earlyLeaveMin ? `${t.earlyLeaveMin} min · ${t.earlyLeaveDays} d` : '—'}</td>
                    <td className="is-num hr-nowrap">{l ? `${l.confirmedLateMin} min` : '—'}</td>
                    <td className="is-num hr-nowrap">{l ? `${l.confirmedEarlyLeaveMin} min` : '—'}</td>
                    <td className="is-num hr-nowrap">{l ? `${(l.deductibleLateMin || 0) + (l.deductibleEarlyLeaveMin || 0)} min` : '—'}</td>
                    <td>
                      <ToneBadge meta={LATENESS_STATE[r.state]} />
                      {l?.needsReapprovalReason ? <div className="muted">{l.needsReapprovalReason}</div> : null}
                      {l?.note ? <div className="muted">Waived: {l.note}</div> : null}
                    </td>
                    {canManage ? (
                      <td className="is-actions">
                        <div className="hr-row-actions">
                          {ended && r.state !== 'none' && r.state !== 'confirmed' ? <Button size="sm" variant="primary" onClick={() => confirmRow(r)} disabled={busy === r.employeeId || busy === 'all'}>Confirm</Button> : null}
                          {ended && r.state !== 'none' ? <Button size="sm" variant="ghost" onClick={() => setWaiving(r)}>Waive some…</Button> : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length ? (
        <Pagination total={rows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
      ) : null}
      <WaiveModal open={!!waiving} row={waiving} month={month} onClose={() => setWaiving(null)} onDone={refresh} />
    </div>
  );
}

function WaiveModal({ open, row, month, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState({ lateMinutes: '', earlyLeaveMinutes: '', note: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const computed = { lateMin: row?.totals?.lateMin || 0, earlyLeaveMin: row?.totals?.earlyLeaveMin || 0 };
  useEffect(() => {
    if (!open || !row) return;
    const l = row.lateness;
    setForm({
      lateMinutes: String(l ? Math.min(l.confirmedLateMin, computed.lateMin) : computed.lateMin),
      earlyLeaveMinutes: String(l ? Math.min(l.confirmedEarlyLeaveMin, computed.earlyLeaveMin) : computed.earlyLeaveMin),
      note: l?.note || '',
    });
    setErrors({}); setBusy(false);
  }, [open, row]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    const errs = validateLatenessForm(form, computed);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await window.api.attendance.confirmLateness({
        employeeId: row.employeeId, month, lateMinutes: Number(form.lateMinutes), earlyLeaveMinutes: Number(form.earlyLeaveMinutes), note: form.note.trim() || undefined,
      });
      addToast('Confirmed.', 'success');
      onDone?.();
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setErrors((x) => ({ ...x, [k]: undefined })); };
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`Confirm ${personName(row)} for ${monthLabel(month)}`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</Button></>}
    >
      <p className="fuel-modal-text">Lower a figure to waive minutes (never higher than the attendance shows). A waiver needs a note.</p>
      <div className="form-grid">
        <Field label="Late minutes to deduct" error={errors.lateMinutes} hint={`The attendance shows ${computed.lateMin} min`}>
          {({ id }) => <Input id={id} inputMode="numeric" value={form.lateMinutes} invalid={!!errors.lateMinutes} onChange={set('lateMinutes')} />}
        </Field>
        <Field label="Early-leave minutes to deduct" error={errors.earlyLeaveMinutes} hint={`The attendance shows ${computed.earlyLeaveMin} min`}>
          {({ id }) => <Input id={id} inputMode="numeric" value={form.earlyLeaveMinutes} invalid={!!errors.earlyLeaveMinutes} onChange={set('earlyLeaveMinutes')} />}
        </Field>
        <Field label="Note" span="full" error={errors.note}>
          {({ id }) => <Textarea id={id} rows={2} value={form.note} invalid={!!errors.note} onChange={set('note')} placeholder="e.g. Flat tyre on the 12th, agreed" />}
        </Field>
      </div>
    </Modal>
  );
}
