/**
 * People → Overtime (HR1, docs/PEOPLE_AND_FUEL_PLAN.md §7b, §10).
 *
 * Per person per day: the overtime the attendance shows, by category (normal
 * 150 %, night / day off / holiday 200 % by default), and what has been
 * approved. Payroll (HR2) pays approved minutes only — and never more than
 * the attendance shows NOW. Approve (all computed), Adjust… (lower, with a
 * note), Revoke… (reason). An approval whose day changed afterwards is
 * flagged "Needs re-approval"; one larger than the attendance now shows is
 * flagged too — both stay listed under "Waiting".
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, EmptyState, Field, Input, Modal, Pagination, Select, Textarea, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { LoadError, ReasonModal } from '../Fuel/FuelShared.jsx';
import { useHrCaps, useHrLookups, useHrTick } from './hrHooks.js';
import { DayDetailModal, HrPermissionNote, MonthSelect, PersonCell, ToneBadge } from './HrShared.jsx';
import {
  OT_CATEGORIES, OT_STATE, errText, fmtHours, fmtMinutes, fmtWorkDate, otTotal, overtimeAdjustForm, overtimeFieldLocked, overtimeNeedsLook, overtimeRows, personName,
  ppMonthKey, ratesLine, validateOvertimeAdjust,
} from './hrModel.js';

const VIEWS = [{ value: 'waiting', label: 'Waiting' }, { value: 'all', label: 'All' }];

export function Overtime() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canView, canManage } = useHrCaps();
  const lookups = useHrLookups();
  const tick = useHrTick(['attendance', 'overtime', 'correction', 'leave', 'holiday', 'schedule', 'settings']);
  const [month, setMonth] = useState(ppMonthKey());
  const [view, setView] = useState('waiting');
  const [who, setWho] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [adjusting, setAdjusting] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [dayOf, setDayOf] = useState(null);
  const [busy, setBusy] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => { setData(null); setError(null); }, [activeCompanyId]);
  useEffect(() => { setPage(0); }, [month, view, who, pageSize, activeCompanyId]);
  useEffect(() => {
    if (!activeCompanyId || !canView) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    Promise.all([
      window.api.attendance.monthSummary({ month, withDays: true }),
      window.api.attendance.listOvertime({ month }),
    ]).then(([summary, approvals]) => {
      if (!alive) return;
      setData({ month, summary, approvals: approvals || [] });
      setError(null);
    }).catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, canView, month, tick, retry]);

  const all = useMemo(() => (data?.month === month ? overtimeRows(data.summary, data.approvals) : []), [data, month]);
  const filtered = useMemo(() => {
    let list = view === 'waiting' ? overtimeNeedsLook(all) : all;
    if (who) list = list.filter((r) => r.employeeId === who);
    return list;
  }, [all, view, who]);
  const people = useMemo(() => {
    const seen = new Map();
    for (const r of all) if (!seen.has(r.employeeId)) seen.set(r.employeeId, r.name);
    return [...seen.entries()];
  }, [all]);
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(filtered.length, page, pageSize);
  const refresh = () => setRetry((n) => n + 1);

  async function approve(row) {
    setBusy(row.key);
    try {
      await window.api.attendance.approveOvertime({ employeeId: row.employeeId, workDate: row.date, minutes: row.computed });
      addToast(`Approved ${fmtMinutes(otTotal(row.computed))} for ${row.name}.`, 'success');
      refresh();
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setBusy(null); }
  }
  async function approveAllShown() {
    const list = filtered.filter((r) => ['pending', 'reapprove', 'exceeds'].includes(r.state) && otTotal(r.computed) > 0);
    if (!list.length) return;
    const ok = await confirm({
      title: `Approve ${list.length} day${list.length === 1 ? '' : 's'} of overtime?`,
      message: 'Each day is approved at the minutes the attendance shows now. You can adjust or revoke any of them afterwards.',
      confirmLabel: 'Approve all shown',
    });
    if (!ok) return;
    setBusy('all');
    let done = 0;
    const failed = [];
    for (const r of list) {
      try { await window.api.attendance.approveOvertime({ employeeId: r.employeeId, workDate: r.date, minutes: r.computed }); done += 1; }
      catch (err) { failed.push(`${r.name} ${r.date}: ${errText(err)}`); }
    }
    setBusy(null);
    refresh();
    if (failed.length) addToast(`Approved ${done}; ${failed.length} failed — ${failed[0]}`, 'error');
    else addToast(`Approved ${done} day${done === 1 ? '' : 's'}.`, 'success');
  }

  if (!activeCompanyId) return <div className="page"><PageHeader title="Overtime" /><NoCompanyState purpose="approve its overtime" /></div>;
  if (!canView) return <div className="page"><PageHeader title="Overtime" /><HrPermissionNote /></div>;

  const rates = data?.summary?.settings?.otRates;
  return (
    <div className="page page--hr-overtime">
      <PageHeader
        title="Overtime"
        subtitle={`Hours:minutes per day. Payroll pays approved overtime only, never more than the attendance shows. ${ratesLine(rates)}`}
        actions={canManage ? <Button variant="primary" onClick={approveAllShown} disabled={busy === 'all' || !filtered.some((r) => ['pending', 'reapprove', 'exceeds'].includes(r.state) && otTotal(r.computed) > 0)}>{busy === 'all' ? 'Approving…' : 'Approve all shown…'}</Button> : null}
      />
      <div className="toolbar">
        <MonthSelect value={month} onChange={setMonth} />
        <Select aria-label="Person" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Everyone</option>
          {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
        <span className="toolbar__count">{filtered.length} {filtered.length === 1 ? 'day' : 'days'}</span>
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="Which days">
          {VIEWS.map((v) => <button key={v.value} type="button" className={`segment${view === v.value ? ' is-active' : ''}`} onClick={() => setView(v.value)}>{v.label}</button>)}
        </div>
      </div>
      {error ? <LoadError message={error} onRetry={refresh} /> : null}
      {loading && !filtered.length ? <p className="muted">Loading…</p> : !error && filtered.length === 0 ? (
        <EmptyState title={view === 'waiting' ? 'Nothing waiting' : 'No overtime this month'} body={view === 'waiting' ? 'Every day with overtime this month is approved.' : 'Overtime shows here once someone works past their schedule.'} />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table data-table--sticky">
            <thead>
              <tr>
                <th>Person</th><th>Day</th>
                {OT_CATEGORIES.map((c) => <th key={c.key} className="is-num" title={c.hint}>{c.label}</th>)}
                <th className="is-num">Approved</th><th>Status</th>{canManage ? <th className="is-actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(pageStart, pageEnd).map((r) => (
                <tr key={r.key}>
                  <td><PersonCell employee={lookups.maps.staff.get(r.employeeId) || { id: r.employeeId, nameEn: r.name }} size={26} /></td>
                  <td className="hr-nowrap"><button type="button" className="link-button" onClick={() => setDayOf(r)}>{fmtWorkDate(r.date)}</button></td>
                  {OT_CATEGORIES.map((c) => (
                    <td key={c.key} className="is-num">
                      {r.computed[c.key] ? fmtHours(r.computed[c.key]) : '—'}
                      {r.approved && r.approved[c.key] !== r.computed[c.key] ? <div className="muted">approved {fmtHours(r.approved[c.key] || 0)}</div> : null}
                    </td>
                  ))}
                  <td className="is-num">{r.approved ? fmtHours(otTotal(r.approved)) : '—'}</td>
                  <td title={r.approval?.note ? `Note: ${r.approval.note}` : undefined}>
                    <ToneBadge meta={OT_STATE[r.state]} />
                    {r.approval?.needsReapprovalReason ? <div className="muted">{r.approval.needsReapprovalReason}</div> : null}
                  </td>
                  {canManage ? (
                    <td className="is-actions">
                      <div className="hr-row-actions">
                        {/* Approved in part was a choice: no one-click "approve all" on it. */}
                        {['pending', 'reapprove', 'exceeds'].includes(r.state) && otTotal(r.computed) > 0 ? <Button size="sm" variant="primary" onClick={() => approve(r)} disabled={busy === r.key || busy === 'all'}>{r.approval ? 'Re-approve' : 'Approve'}</Button> : null}
                        {otTotal(r.computed) > 0 ? <Button size="sm" variant="ghost" onClick={() => setAdjusting(r)}>Adjust…</Button> : null}
                        {r.approval ? <Button size="sm" variant="ghost" onClick={() => setRevoking(r)}>Revoke…</Button> : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length ? (
        <Pagination total={filtered.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
      ) : null}

      <AdjustOvertimeModal open={!!adjusting} row={adjusting} onClose={() => setAdjusting(null)} onDone={refresh} />
      <ReasonModal
        open={!!revoking}
        title={`Revoke ${revoking ? personName({ nameEn: revoking.name }) : ''}'s approval?`}
        message="The day goes back to waiting. Payroll will not pay it until it is approved again."
        confirmLabel="Revoke approval"
        danger
        onCancel={() => setRevoking(null)}
        onConfirm={async (reason) => {
          await window.api.attendance.revokeOvertime(revoking.approval.id, reason);
          addToast('Approval revoked.', 'success');
          setRevoking(null);
          refresh();
        }}
      />
      <DayDetailModal open={!!dayOf} employee={dayOf ? (lookups.maps.staff.get(dayOf.employeeId) || { id: dayOf.employeeId, nameEn: dayOf.name }) : null} date={dayOf?.date} canManage={canManage} onClose={() => setDayOf(null)} />
    </div>
  );
}

function AdjustOvertimeModal({ open, row, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !row) return;
    setForm(overtimeAdjustForm(row));
    setErrors({}); setBusy(false);
  }, [open, row]);
  async function save() {
    const { errors: errs, minutes } = validateOvertimeAdjust(form, row.computed);
    const lower = OT_CATEGORIES.some((c) => (minutes[c.key] ?? 0) < (row.computed[c.key] || 0));
    if (lower && !String(form.note || '').trim()) errs.note = 'Say why less is approved';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await window.api.attendance.approveOvertime({ employeeId: row.employeeId, workDate: row.date, minutes, note: form.note.trim() || undefined });
      addToast('Overtime approved.', 'success');
      onDone?.();
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`Adjust overtime — ${row?.name || ''}, ${row ? fmtWorkDate(row.date) : ''}`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Approve these minutes'}</Button></>}
    >
      <p className="fuel-modal-text">Approve less than the attendance shows (never more). 0 approves none of that kind.</p>
      <div className="form-grid">
        {OT_CATEGORIES.map((c) => (
          <Field key={c.key} label={`${c.label} (min)`} error={errors[c.key]} hint={`The attendance shows ${row?.computed?.[c.key] || 0} min`}>
            {({ id }) => <Input id={id} inputMode="numeric" value={form[c.key] ?? ''} invalid={!!errors[c.key]} disabled={overtimeFieldLocked(form, row?.computed, c.key)} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />}
          </Field>
        ))}
        <Field label="Note" span="full" error={errors.note}>
          {({ id }) => <Textarea id={id} rows={2} value={form.note || ''} invalid={!!errors.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />}
        </Field>
      </div>
    </Modal>
  );
}
