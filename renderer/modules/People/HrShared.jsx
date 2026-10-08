/**
 * HR1 — small pieces shared by the People screens: a person cell (photo +
 * both names), status chips, clock-in photo thumbnails and viewer (read
 * through the permission-checked `attendance:getPhoto`, hr.manage only), the
 * month picker, the "needs permission" note, and the two dialogs several
 * screens open: a day's detail (events, photos, void, add a manual entry)
 * and a manual entry for anyone.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { StaffAvatar, ReasonModal } from '../Fuel/FuelShared.jsx';
import { recentMonths } from '../Fuel/fuelModel.js';
import { useAttendancePhotoUrl, useHrTick } from './hrHooks.js';
import {
  EMPTY_DAY_LOAD, OT_CATEGORIES, dayStatusOf, errText, eventBadges, fmtHmOn, fmtMinutes, fmtWorkDate, hmToMs, isHm, loadedFor, otTotal,
  personName, ppDateKey, sortDayEvents, sourceLabel,
} from './hrModel.js';

/* ─── people and chips ────────────────────────────────────────────────── */

export function PersonCell({ employee, size = 32, sub }) {
  if (!employee) return <span className="muted">Unknown person</span>;
  return (
    <span className="hr-person">
      {size ? <StaffAvatar employee={employee} size={size} /> : null}
      <span className="hr-person__names">
        <strong>{personName(employee)}</strong>
        {employee.nameEn && employee.nameKm ? (
          <span className="hr-person__km"><span lang="km">{employee.nameKm}</span>{sub ? ` · ${sub}` : ''}</span>
        ) : sub ? <span className="muted hr-person__sub">{sub}</span> : null}
      </span>
    </span>
  );
}

export function DayStatusBadge({ status }) {
  const s = dayStatusOf(status);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function ToneBadge({ meta }) {
  if (!meta) return null;
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** The "this needs a permission" text in one place. */
export function HrPermissionNote({ manage = false }) {
  return (
    <p className="muted">
      This needs the “{manage ? 'Manage staff & attendance' : 'View staff & attendance'}” permission. Ask an admin to add it to your role.
    </p>
  );
}

/** Month dropdown: the last 24 months, newest first. */
export function MonthSelect({ value, onChange, label = 'Month', count = 24 }) {
  const months = useMemo(() => recentMonths(count), [count]);
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
    </Select>
  );
}

/* ─── clock-in photos ─────────────────────────────────────────────────── */

export function AttendancePhotoThumb({ event, size = 56, onOpen, enabled = true }) {
  const { url, intact, error, loading } = useAttendancePhotoUrl(event, { enabled });
  if (!event?.hasPhoto) {
    return <span className="hr-photo-empty" style={{ width: size, height: size }}>{event?.photoRetired ? 'Moved to Recently deleted' : 'No photo'}</span>;
  }
  const label = `${event.kind === 'out' ? 'Clock-out' : 'Clock-in'} photo`;
  return (
    <button
      type="button"
      className={`fuel-thumb${intact ? '' : ' is-tampered'}`}
      style={{ width: size, height: size }}
      onClick={onOpen}
      title={intact ? label : `${label} — this file has changed since it was taken`}
      aria-label={`Open ${label.toLowerCase()}`}
    >
      {url ? <img src={url} alt={label} draggable={false} /> : <span className="fuel-thumb__empty">{loading ? '…' : error ? '!' : ''}</span>}
    </button>
  );
}

/** A clock-in photo, large, beside the person's own staff photo to compare faces. */
export function AttendancePhotoModal({ open, event, employee, onClose }) {
  const { url, intact, error, loading } = useAttendancePhotoUrl(open ? event : null, { thumb: false });
  return (
    <Modal open={open} onClose={onClose} size="xl" title={`${personName(employee)} — ${event?.kind === 'out' ? 'clock-out' : 'clock-in'} ${fmtHmOn(event?.at, event?.workDate)}`}>
      <div className="hr-compare">
        <figure className="hr-compare__item">
          <div className="hr-compare__frame">
            {url ? <img src={url} alt="Clock-in photo" /> : <span className="muted">{loading ? 'Loading photo…' : error ? `Could not load: ${error}` : 'No photo'}</span>}
          </div>
          <figcaption className="muted">
            Taken {fmtWorkDate(event?.workDate)} {fmtHmOn(event?.at, event?.workDate)} · {sourceLabel(event?.source)}
            {!intact ? <> <Badge tone="rose">File changed since it was taken</Badge></> : null}
          </figcaption>
        </figure>
        <figure className="hr-compare__item">
          <div className="hr-compare__frame hr-compare__frame--ref"><StaffAvatar employee={employee} size={240} /></div>
          <figcaption className="muted">Staff photo on file</figcaption>
        </figure>
      </div>
    </Modal>
  );
}

/* ─── a day for one person ────────────────────────────────────────────── */

/**
 * Everything about one person's day: the computed figures, every event
 * (voided and replaced ones struck through, with their reasons), photos for
 * hr.manage, Void… (reason), and Add manual entry (reason required).
 * `day` is the calcDay result when the caller has it; otherwise it is loaded.
 */
export function DayDetailModal({ open, employee, date, day: dayProp = null, canManage, onClose }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useHrTick(['attendance', 'correction', 'leave', 'holiday', 'schedule', 'staff']);
  // Review fix M1: what was loaded is kept WITH the person + day it belongs to,
  // and shown only while it matches the dialog's current person + day — the
  // previous person's entries (and their Void… buttons) never show for the next.
  const employeeId = employee?.id || employee?.employeeId;
  const key = open && employeeId && date && activeCompanyId ? `${activeCompanyId}|${employeeId}|${date}` : null;
  const [loaded, setLoaded] = useState(EMPTY_DAY_LOAD);
  const [voiding, setVoiding] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [form, setForm] = useState({ kind: 'in', time: '', nextDay: false, reason: '' });
  const [formErrors, setFormErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setForm({ kind: 'in', time: '', nextDay: false, reason: '' }); setFormErrors({}); setVoiding(null); setViewing(null);
  }, [key]);
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    Promise.all([
      window.api.attendance.listEvents({ employeeId, from: date, to: date, includeVoided: true, limit: 200 }),
      window.api.attendance.monthSummary({ month: date.slice(0, 7), employeeId }),
    ]).then(([evs, summary]) => {
      if (!alive) return;
      const found = summary?.rows?.[0]?.days?.find((d) => d.date === date) || null;
      setLoaded({ key, events: evs?.items || [], day: found, error: null });
    }).catch((err) => { if (alive) setLoaded({ key, events: [], day: null, error: errText(err) }); });
    return () => { alive = false; };
  }, [key, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = loadedFor(loaded, key, EMPTY_DAY_LOAD);
  const events = current.events;
  const error = current.error;
  const day = current.day || (dayProp && dayProp.date === date ? dayProp : null);
  const loading = !!key && loaded.key !== key;

  async function addManual() {
    const errs = {};
    if (!isHm(form.time)) errs.time = 'Type a time like 07:30';
    if (!form.reason.trim()) errs.reason = 'A reason is required';
    setFormErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await window.api.attendance.addManual({
        employeeId, kind: form.kind, at: hmToMs(date, form.time, { nextDay: form.nextDay }), workDate: date, reason: form.reason.trim(),
      });
      addToast('Entry added.', 'success');
      setForm({ kind: form.kind === 'in' ? 'out' : 'in', time: '', nextDay: false, reason: '' });
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setBusy(false); }
  }

  const s = day ? dayStatusOf(day.status) : null;
  const sorted = sortDayEvents(events);
  return (
    <>
      <Modal open={open && !voiding && !viewing} onClose={onClose} size="lg" busy={busy} title={`${personName(employee)} — ${fmtWorkDate(date, { year: true })}`}>
        {day ? (
          <div className="hr-day-summary">
            <Badge tone={s.tone}>{s.label}</Badge>
            {day.holiday ? <span className="muted">{day.holiday.nameEn || day.holiday.nameKm || 'Public holiday'}</span> : null}
            {day.leave ? <span className="muted">Leave{day.leave.half ? ` (${day.leave.half === 'am' ? 'morning' : 'afternoon'})` : ''}</span> : null}
            <span>In <strong>{fmtHmOn(day.firstIn, date)}</strong></span>
            <span>Out <strong>{fmtHmOn(day.lastOut, date)}</strong></span>
            <span>Worked <strong>{fmtMinutes(day.workedMin)}</strong></span>
            {day.lateMin > 0 ? <span>Late <strong>{fmtMinutes(day.lateMin)}</strong></span> : null}
            {day.earlyLeaveMin > 0 ? <span>Left early <strong>{fmtMinutes(day.earlyLeaveMin)}</strong></span> : null}
            {otTotal(day.overtime) > 0 ? (
              <span>Overtime <strong>{OT_CATEGORIES.filter((c) => day.overtime[c.key]).map((c) => `${c.label.toLowerCase()} ${fmtMinutes(day.overtime[c.key])}`).join(', ')}</strong></span>
            ) : null}
            {day.missingOut ? <Badge tone="amber">No clock-out</Badge> : null}
          </div>
        ) : null}
        {error ? <p className="field__error">Couldn't load this day: {error}</p> : null}
        <h3 className="section-title hr-subhead">Clock entries</h3>
        {loading ? <p className="muted">Loading…</p> : sorted.length === 0 ? <p className="muted">No clock entries for this day.</p> : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Time</th><th>Entry</th><th>From</th><th>State</th>{canManage ? <th>Photo</th> : null}{canManage ? <th className="is-actions" /> : null}</tr></thead>
              <tbody>
                {sorted.map((ev) => {
                  const gone = ev.voided || ev.supersededById;
                  return (
                    <tr key={ev.id} className={gone ? 'is-muted hr-struck' : ''}>
                      <td><strong>{fmtHmOn(ev.at, date)}</strong></td>
                      <td>{ev.kind === 'out' ? 'Clock-out' : 'Clock-in'}</td>
                      <td>
                        {sourceLabel(ev.source)}{ev.deviceLabel ? <span className="muted"> · {ev.deviceLabel}</span> : null}
                        {ev.note ? <div className="muted">{ev.note}</div> : null}
                        {ev.voidReason ? <div className="muted">Voided: {ev.voidReason}</div> : null}
                      </td>
                      <td><div className="hr-badges">{eventBadges(ev).map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}</div></td>
                      {canManage ? <td><AttendancePhotoThumb event={ev} size={44} onOpen={() => setViewing(ev)} /></td> : null}
                      {canManage ? (
                        <td className="is-actions">
                          {!ev.voided ? <Button size="sm" variant="ghost" onClick={() => setVoiding(ev)}>Void…</Button> : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {canManage ? (
          <div className="hr-manual">
            <h3 className="section-title hr-subhead">Add a manual entry</h3>
            <div className="form-grid">
              <Field label="Entry">
                {({ id }) => (
                  <Select id={id} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
                    <option value="in">Clock-in</option>
                    <option value="out">Clock-out</option>
                  </Select>
                )}
              </Field>
              <Field label="Time (Phnom Penh)" required error={formErrors.time}>
                {({ id }) => (
                  <div className="fuel-inline">
                    <Input id={id} type="time" value={form.time} invalid={!!formErrors.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} />
                    <label className="fuel-check"><input type="checkbox" checked={form.nextDay} onChange={(e) => setForm((f) => ({ ...f, nextDay: e.target.checked }))} /><span>Next morning</span></label>
                  </div>
                )}
              </Field>
              <Field label="Reason" required span="full" error={formErrors.reason} hint="Kept with the entry and in History.">
                {({ id }) => <Input id={id} value={form.reason} invalid={!!formErrors.reason} placeholder="e.g. Forgot to clock in; seen at 07:05" onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />}
              </Field>
            </div>
            <div className="hr-actions-row"><Button variant="primary" onClick={addManual} disabled={busy}>{busy ? 'Saving…' : 'Add entry'}</Button></div>
          </div>
        ) : null}
      </Modal>
      <ReasonModal
        open={!!voiding}
        title="Void this entry?"
        message="It stops counting. It is kept, struck through, with your reason."
        confirmLabel="Void entry"
        danger
        onCancel={() => setVoiding(null)}
        onConfirm={async (reason) => {
          await window.api.attendance.voidEvent(voiding.id, reason);
          addToast('Entry voided.', 'success');
          setVoiding(null);
        }}
      />
      <AttendancePhotoModal open={!!viewing} event={viewing} employee={employee} onClose={() => setViewing(null)} />
    </>
  );
}

/* ─── a manual entry for anyone ───────────────────────────────────────── */

export function ManualEntryModal({ open, staff, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState({ employeeId: '', date: ppDateKey(), kind: 'in', time: '', nextDay: false, reason: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm({ employeeId: '', date: ppDateKey(), kind: 'in', time: '', nextDay: false, reason: '' }); setErrors({}); setBusy(false); } }, [open]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  async function save() {
    const errs = {};
    if (!form.employeeId) errs.employeeId = 'Choose the person';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) errs.date = 'Choose the work day';
    if (!isHm(form.time)) errs.time = 'Type a time like 07:30';
    if (!form.reason.trim()) errs.reason = 'A reason is required';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await window.api.attendance.addManual({
        employeeId: form.employeeId, kind: form.kind, at: hmToMs(form.date, form.time, { nextDay: form.nextDay }), workDate: form.date, reason: form.reason.trim(),
      });
      addToast('Entry added.', 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  const people = (staff || []).filter((e) => e.status !== 'left');
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title="Add a manual entry"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Add entry'}</Button></>}
    >
      <p className="fuel-modal-text">For a paper record or a forgotten clock-in. It counts at once and is kept with your reason.</p>
      <div className="form-grid">
        <Field label="Person" required error={errors.employeeId}>
          {({ id }) => (
            <Select id={id} value={form.employeeId} invalid={!!errors.employeeId} onChange={(e) => set('employeeId')(e.target.value)}>
              <option value="">Choose…</option>
              {people.map((e) => <option key={e.id} value={e.id}>{personName(e)} · {e.staffCode}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Work day" required error={errors.date}>
          {({ id }) => <Input id={id} type="date" value={form.date} invalid={!!errors.date} onChange={(e) => set('date')(e.target.value)} />}
        </Field>
        <Field label="Entry">
          {({ id }) => (
            <Select id={id} value={form.kind} onChange={(e) => set('kind')(e.target.value)}>
              <option value="in">Clock-in</option>
              <option value="out">Clock-out</option>
            </Select>
          )}
        </Field>
        <Field label="Time (Phnom Penh)" required error={errors.time}>
          {({ id }) => (
            <div className="fuel-inline">
              <Input id={id} type="time" value={form.time} invalid={!!errors.time} onChange={(e) => set('time')(e.target.value)} />
              <label className="fuel-check"><input type="checkbox" checked={form.nextDay} onChange={(e) => set('nextDay')(e.target.checked)} /><span>Next morning</span></label>
            </div>
          )}
        </Field>
        <Field label="Reason" required span="full" error={errors.reason}>
          {({ id }) => <Textarea id={id} rows={2} value={form.reason} invalid={!!errors.reason} onChange={(e) => set('reason')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/** Server-paged footer helper: clamp the page when the total shrinks (§10). */
export function clampServerPage(total, page, pageSize, setPage) {
  const maxPage = Math.max(0, Math.ceil((total || 0) / pageSize) - 1);
  if (page > maxPage) setPage(maxPage);
}
