/**
 * Settings → People (HR1, hr.manage; docs/PEOPLE_AND_FUEL_PLAN.md §7b, §10):
 * the rules attendance is worked out with, for the ACTIVE company.
 *
 *   Rules          overtime rates and rounding, lateness counting, the
 *                  attendance start date (no day before it is "absent"), the
 *                  first month leave is earned, clocking-in limits, kiosk PIN
 *                  limits — saved automatically (§6), Save button, reset to
 *                  the defaults after a confirm
 *   Schedules      named hours / break / work days / grace / night window;
 *                  the default; assign to staff from a date (history kept)
 *   Holidays       per year — 2026 prefilled from Sub-Decree No. 167, the
 *                  fixed-date 2027 ones flagged "check against the 2027
 *                  sub-decree"; archived, never deleted
 *   Leave types    the Labour Law defaults, editable; archived, never deleted
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAutosave, useHrTick } from './hrHooks.js';
import { AssignScheduleModal } from '../Staff/StaffProfile.jsx';
import {
  ACCRUALS, HR_SETTING_GROUPS, WEEKDAYS, defaultSettingsPending, emptyScheduleForm, errText, fmtWorkDate, hrSettingValue,
  holidayNeedsCheck, leaveTypeName, parseHrSetting, ppDateKey, scheduleInput, scheduleLine, settingKey, settingsPatch,
  validateHolidayForm, validateScheduleForm,
} from './hrModel.js';

export function PeopleSettingsPanel() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useHrTick(['settings', 'schedule', 'holiday', 'leaveType', 'staff']);
  const [settings, setSettings] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [schedules, setSchedules] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [staff, setStaff] = useState([]);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [assigning, setAssigning] = useState(false);
  const [editingType, setEditingType] = useState(null);
  const settingsRef = useRef(null);
  settingsRef.current = settings;

  const autosave = useAutosave(async (pending) => {
    const next = await window.api.hr.updateSettings(settingsPatch(pending, settingsRef.current));
    setSettings(next);
    setDrafts((d) => {
      const out = { ...d };
      for (const k of Object.keys(pending)) delete out[k];
      return out;
    });
  }, { label: 'the People settings' });

  // Another company's rules must never show (or be edited) here.
  const companyRef = useRef(activeCompanyId);
  useEffect(() => {
    if (companyRef.current === activeCompanyId) return;
    companyRef.current = activeCompanyId;
    autosave.reset();
    setSettings(null); setSchedules([]); setLeaveTypes([]); setStaff([]); setDrafts({}); setFieldErrors({});
  }, [activeCompanyId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let alive = true;
    Promise.all([
      window.api.hr.getSettings(),
      window.api.hr.listSchedules({ includeArchived: true }),
      window.api.leave.listTypes({ includeArchived: true }),
      window.api.staff.list({ status: 'active' }),
    ]).then(([s, sch, lt, st]) => {
      if (!alive) return;
      if (!autosave.hasPending()) { setSettings(s); setDrafts({}); }
      setSchedules(sch || []); setLeaveTypes(lt || []); setStaff(st || []); setError(null);
    }).catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [activeCompanyId, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = useCallback((field, text) => {
    const key = settingKey(field);
    setDrafts((d) => ({ ...d, [key]: text }));
    const r = parseHrSetting(field, text);
    setFieldErrors((e) => ({ ...e, [key]: r.error || null }));
    if (!r.error) autosave.queue({ [key]: r.value });
  }, [autosave]);
  const setPlain = (key, value) => {
    setSettings((s) => ({ ...s, [key]: value }));
    autosave.queue({ [key]: value });
  };

  async function resetDefaults() {
    const ok = await confirm({
      title: 'Reset the People rules?',
      message: 'Overtime rates, rounding, lateness, clocking-in and kiosk PIN limits go back to their defaults for this company. Schedules, holidays, leave types and the start dates stay as they are.',
      confirmLabel: 'Reset to defaults',
      danger: true,
    });
    if (!ok) return;
    autosave.queue(defaultSettingsPending());
    setDrafts({});
    setFieldErrors({});
    autosave.flush();
  }
  async function runJobs() {
    setRunning(true);
    try {
      const res = await window.api.hr.runJobs();
      const a = res?.accruals || {};
      addToast(`Leave: ${a.accrued || 0} earned, ${a.granted || 0} granted, ${a.expired || 0} expired. Photos moved: ${res?.photos?.retired || 0}.`, 'success');
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setRunning(false); }
  }

  if (!activeCompanyId) {
    return <div className="settings-page"><h2 className="section-title">People</h2><p className="muted">Choose a company first — each company has its own staff rules.</p></div>;
  }

  return (
    <div className="settings-page hr-settings">
      <div className="section-head">
        <h2 className="section-title">People</h2>
        <span className="section-hint">How attendance, overtime and leave are worked out for the active company.</span>
        <div className="section-head__actions">
          <SaveStatus state={autosave.status.state} savedAt={autosave.status.savedAt} error={autosave.status.error} onSave={autosave.flush} />
        </div>
      </div>
      {error ? <p className="field__error">Couldn't load the People settings: {error}</p> : null}

      {!settings ? <p className="muted">Loading…</p> : (
        <>
          <div className="fuel-subsection">
            <h3 className="section-title fuel-subhead">Attendance</h3>
            <div className="setting-row">
              <div className="setting-row__label">
                <div className="setting-row__title">Attendance starts on</div>
                <div className="setting-row__hint">No day before this is ever counted as absent (the paper era).</div>
              </div>
              <div className="setting-row__control">
                <Input type="date" aria-label="Attendance starts on" value={settings.attendanceStartDate || ''} onChange={(e) => e.target.value && setPlain('attendanceStartDate', e.target.value)} />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-row__label">
                <div className="setting-row__title">Leave is earned from</div>
                <div className="setting-row__hint">The first month annual leave is added for. Earlier service: Adjust balance on the person.</div>
              </div>
              <div className="setting-row__control">
                <Input type="month" aria-label="Leave is earned from" value={settings.accrualFromMonth || ''} onChange={(e) => e.target.value && setPlain('accrualFromMonth', e.target.value)} />
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-row__label">
                <div className="setting-row__title">Default schedule</div>
                <div className="setting-row__hint">For anyone without a schedule of their own.</div>
              </div>
              <div className="setting-row__control">
                <Select aria-label="Default schedule" value={settings.defaultScheduleId || ''} onChange={(e) => setPlain('defaultScheduleId', e.target.value || null)}>
                  {!settings.defaultScheduleId ? <option value="">None</option> : null}
                  {schedules.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-row__label">
                <div className="setting-row__title">Count lateness from</div>
                <div className="setting-row__hint">After the grace period: 5 min grace, in at 07:08 → 3 min late. From the start: 8 min late.</div>
              </div>
              <div className="setting-row__control">
                <Select aria-label="Count lateness from" value={settings.lateCountsFrom || 'grace'} onChange={(e) => setPlain('lateCountsFrom', e.target.value)}>
                  <option value="grace">The end of the grace period</option>
                  <option value="start">The scheduled start</option>
                </Select>
              </div>
            </div>
            <div className="setting-row">
              <div className="setting-row__label">
                <div className="setting-row__title">Count arriving early as overtime</div>
                <div className="setting-row__hint">Off: only time after the scheduled end counts.</div>
              </div>
              <div className="setting-row__control">
                <label className="fuel-check"><input type="checkbox" checked={!!settings.countEarlyArrival} onChange={(e) => setPlain('countEarlyArrival', e.target.checked)} /><span>{settings.countEarlyArrival ? 'On' : 'Off'}</span></label>
              </div>
            </div>
          </div>

          {HR_SETTING_GROUPS.map((g) => (
            <div key={g.title} className="fuel-subsection">
              <div className="section-head">
                <h3 className="section-title fuel-subhead">{g.title}</h3>
                {g.hint ? <span className="section-hint">{g.hint}</span> : null}
              </div>
              {g.fields.map((f) => {
                const key = settingKey(f);
                const stored = hrSettingValue(settings, f);
                const value = drafts[key] ?? (stored ?? '');
                return (
                  <div key={key} className="setting-row">
                    <div className="setting-row__label">
                      <div className="setting-row__title">{f.label}</div>
                      <div className="setting-row__hint">
                        {fieldErrors[key] ? <span className="field__error">{fieldErrors[key]}</span> : `Default ${f.def} ${f.unit}${stored === f.def ? ' (in use)' : ''}`}
                      </div>
                    </div>
                    <div className="setting-row__control">
                      <div className="fuel-inline fuel-setting-control">
                        <Input aria-label={f.label} className="fuel-setting-input" inputMode="numeric" value={String(value)} invalid={!!fieldErrors[key]}
                          onChange={(e) => change(f, e.target.value)} onBlur={() => { if (!fieldErrors[key]) autosave.flush(); }} />
                        <span className="muted">{f.unit}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          <div className="hr-actions-row">
            <Button variant="ghost" onClick={resetDefaults}>Reset the rules to the defaults…</Button>
            <Button variant="ghost" onClick={runJobs} disabled={running}>{running ? 'Running…' : 'Add earned leave now'}</Button>
          </div>
        </>
      )}

      <div className="fuel-subsection">
        <div className="section-head">
          <h3 className="section-title fuel-subhead">Work schedules</h3>
          <div className="section-head__actions">
            <Button size="sm" onClick={() => setAssigning(true)}>Assign to staff…</Button>
            <Button size="sm" variant="primary" onClick={() => setEditingSchedule('new')}>+ New schedule</Button>
          </div>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Schedule</th><th>Hours</th><th className="is-num">Grace</th><th>Night window</th><th /><th className="is-actions" /></tr></thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className={s.archived ? 'is-muted' : ''}>
                  <td><strong>{s.name}</strong></td>
                  <td>{scheduleLine(s)}</td>
                  <td className="is-num">{s.graceMin} min</td>
                  <td>{s.nightStart}–{s.nightEnd}</td>
                  <td>
                    {settings?.defaultScheduleId === s.id ? <Badge tone="emerald">Default</Badge> : null}
                    {s.archived ? <Badge tone="slate">Hidden</Badge> : null}
                  </td>
                  <td className="is-actions">
                    <Button size="sm" variant="ghost" onClick={() => setEditingSchedule(s)}>Edit…</Button>
                    {settings?.defaultScheduleId !== s.id ? (
                      <Button size="sm" variant="ghost" onClick={async () => {
                        try { await window.api.hr.updateSchedule(s.id, { archived: !s.archived }); addToast(s.archived ? `${s.name} is offered again.` : `${s.name} is hidden.`, 'success'); }
                        catch (err) { addToast(errText(err), 'error'); }
                      }}>{s.archived ? 'Show again' : 'Hide'}</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="field__hint">Editing a schedule's hours changes how every day on it is worked out, past days included. For a change from a date, make a new schedule and assign it from that date.</p>
      </div>

      <HolidaysSection />

      <div className="fuel-subsection">
        <div className="section-head">
          <h3 className="section-title fuel-subhead">Kinds of leave</h3>
          <span className="section-hint">Labour Law defaults — confirm with your accountant.</span>
          <div className="section-head__actions"><Button size="sm" variant="primary" onClick={() => setEditingType('new')}>+ New kind of leave</Button></div>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Leave</th><th>Paid</th><th>Earned</th><th className="is-num">Carry over</th><th>Rules</th><th className="is-actions" /></tr></thead>
            <tbody>
              {leaveTypes.map((t) => (
                <tr key={t.id} className={t.archived ? 'is-muted' : ''}>
                  <td><strong>{leaveTypeName(t)}</strong>{t.nameEn && t.nameKm ? <span className="muted" lang="km"> · {t.nameKm}</span> : null} <code className="muted">{t.code}</code></td>
                  <td>{t.paid ? 'Paid' : 'Unpaid'}</td>
                  <td>{t.accrual === 'none' ? (t.tracksBalance ? 'Not earned' : 'Not counted') : `${t.accrualDays} d ${t.accrual === 'monthly' ? 'a month' : 'a year'}`}</td>
                  <td className="is-num">{t.tracksBalance ? (t.carryOverMax ?? '—') : '—'}</td>
                  <td className="muted">
                    {[t.maxDaysPerRequest ? `at most ${t.maxDaysPerRequest} d per request` : null, t.countCalendarDays ? 'calendar days' : null, t.needsDocument ? 'document needed' : null].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="is-actions">
                    <Button size="sm" variant="ghost" onClick={() => setEditingType(t)}>Edit…</Button>
                    <Button size="sm" variant="ghost" onClick={async () => {
                      try { await window.api.leave.updateType(t.id, { archived: !t.archived }); addToast(t.archived ? `${leaveTypeName(t)} is offered again.` : `${leaveTypeName(t)} is hidden.`, 'success'); }
                      catch (err) { addToast(errText(err), 'error'); }
                    }}>{t.archived ? 'Show again' : 'Hide'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ScheduleModal open={editingSchedule !== null} schedule={editingSchedule === 'new' ? null : editingSchedule} onClose={() => setEditingSchedule(null)} />
      <AssignScheduleModal open={assigning} employees={staff} schedules={schedules} onClose={() => setAssigning(false)} />
      <LeaveTypeModal open={editingType !== null} type={editingType === 'new' ? null : editingType} onClose={() => setEditingType(null)} />
    </div>
  );
}

/* ─── schedules ───────────────────────────────────────────────────────── */

function ScheduleModal({ open, schedule, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState(emptyScheduleForm());
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(emptyScheduleForm(schedule)); setErrors({}); setBusy(false); } }, [open, schedule]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const toggleDay = (i) => set('workDays')(form.workDays.split('').map((c, j) => (j === i ? (c === '1' ? '0' : '1') : c)).join(''));
  async function save() {
    const errs = validateScheduleForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      if (schedule) await window.api.hr.updateSchedule(schedule.id, scheduleInput(form));
      else await window.api.hr.createSchedule(scheduleInput(form));
      addToast('Schedule saved.', 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title={schedule ? `Edit ${schedule.name}` : 'New schedule'}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save schedule'}</Button></>}
    >
      <div className="form-grid">
        <Field label="Name" required error={errors.name} span="full">
          {({ id }) => <Input id={id} autoFocus value={form.name} invalid={!!errors.name} placeholder="e.g. Night guard" onChange={(e) => set('name')(e.target.value)} />}
        </Field>
        <Field label="Starts" required error={errors.startTime}>
          {({ id }) => <Input id={id} type="time" value={form.startTime} invalid={!!errors.startTime} onChange={(e) => set('startTime')(e.target.value)} />}
        </Field>
        <Field label="Ends" required error={errors.endTime} hint="Earlier than the start = ends the next morning.">
          {({ id }) => <Input id={id} type="time" value={form.endTime} invalid={!!errors.endTime} onChange={(e) => set('endTime')(e.target.value)} />}
        </Field>
        <Field label="Break (min)" error={errors.breakMin} hint="Taken off a day of more than the break threshold.">
          {({ id }) => <Input id={id} inputMode="numeric" value={form.breakMin} invalid={!!errors.breakMin} onChange={(e) => set('breakMin')(e.target.value)} />}
        </Field>
        <Field label="Grace (min)" error={errors.graceMin} hint="Arriving within it is not late.">
          {({ id }) => <Input id={id} inputMode="numeric" value={form.graceMin} invalid={!!errors.graceMin} onChange={(e) => set('graceMin')(e.target.value)} />}
        </Field>
        <Field label="Night overtime from" error={errors.nightStart}>
          {({ id }) => <Input id={id} type="time" value={form.nightStart} invalid={!!errors.nightStart} onChange={(e) => set('nightStart')(e.target.value)} />}
        </Field>
        <Field label="Night overtime until" error={errors.nightEnd}>
          {({ id }) => <Input id={id} type="time" value={form.nightEnd} invalid={!!errors.nightEnd} onChange={(e) => set('nightEnd')(e.target.value)} />}
        </Field>
        <Field label="Work days" required span="full" error={errors.workDays} hint="Any other day is the weekly day off (overtime at the day-off rate).">
          {() => (
            <div className="hr-weekdays" role="group" aria-label="Work days">
              {WEEKDAYS.map((d, i) => (
                <label key={d} className={`hr-weekday${form.workDays[i] === '1' ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={form.workDays[i] === '1'} onChange={() => toggleDay(i)} />
                  <span>{d}</span>
                </label>
              ))}
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}

/* ─── holidays ────────────────────────────────────────────────────────── */

function HolidaysSection() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useHrTick(['holiday']);
  const thisYear = Number(ppDateKey().slice(0, 4));
  const years = useMemo(() => [thisYear - 1, thisYear, thisYear + 1], [thisYear]);
  const [year, setYear] = useState(String(thisYear));
  const [list, setList] = useState([]);
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let alive = true;
    window.api.hr.listHolidays({ year, includeArchived: showHidden })
      .then((h) => { if (alive) { setList(h || []); setError(null); } })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [activeCompanyId, year, showHidden, tick]);
  const toCheck = list.filter((h) => !h.archived && holidayNeedsCheck(h)).length;
  return (
    <div className="fuel-subsection">
      <div className="section-head">
        <h3 className="section-title fuel-subhead">Public holidays</h3>
        <span className="section-hint">A worked holiday is overtime at the holiday rate; nobody is absent on one.</span>
        <div className="section-head__actions">
          <Select aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          </Select>
          <label className="fuel-check hr-nowrap"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /><span>Show hidden</span></label>
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>+ New holiday</Button>
        </div>
      </div>
      {toCheck ? (
        <p className="hr-note" role="note">
          {toCheck} {toCheck === 1 ? 'date was' : 'dates were'} filled in ahead of the {year} sub-decree. Check them against it when it is published, and add Khmer New Year and the lunar holidays then.
        </p>
      ) : null}
      {error ? <p className="field__error">{error}</p> : null}
      {list.length === 0 ? <p className="muted">No holidays for {year} yet.</p> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Date</th><th>Holiday</th><th>Paid</th><th>Source</th><th className="is-actions" /></tr></thead>
            <tbody>
              {list.map((h) => (
                <tr key={h.id} className={h.archived ? 'is-muted' : ''}>
                  <td className="hr-nowrap">{fmtWorkDate(h.date)}</td>
                  <td><strong>{h.nameEn || h.nameKm}</strong>{h.nameEn && h.nameKm ? <div className="muted" lang="km">{h.nameKm}</div> : null}</td>
                  <td>{h.paid ? 'Paid' : 'Unpaid'}</td>
                  <td className="hr-cell-text">
                    {holidayNeedsCheck(h) ? <Badge tone="amber">Check against the {h.date.slice(0, 4)} sub-decree</Badge> : null}
                    {h.sourceNote ? <div className="muted">{h.sourceNote}</div> : null}
                    {h.archived ? <Badge tone="slate">Hidden</Badge> : null}
                  </td>
                  <td className="is-actions">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(h)}>Edit…</Button>
                    <Button size="sm" variant="ghost" onClick={async () => {
                      try { await window.api.hr.updateHoliday(h.id, { archived: !h.archived }); addToast(h.archived ? 'Holiday restored.' : 'Holiday hidden — that day is a normal day again.', 'success'); }
                      catch (err) { addToast(errText(err), 'error'); }
                    }}>{h.archived ? 'Show again' : 'Hide'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <HolidayModal open={editing !== null} holiday={editing === 'new' ? null : editing} year={year} onClose={() => setEditing(null)} />
    </div>
  );
}

function HolidayModal({ open, holiday, year, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const blank = () => ({ date: `${year}-01-01`, nameEn: '', nameKm: '', paid: true, sourceNote: '' });
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm(holiday ? { date: holiday.date, nameEn: holiday.nameEn || '', nameKm: holiday.nameKm || '', paid: !!holiday.paid, sourceNote: holiday.sourceNote || '' } : blank());
    setErrors({}); setBusy(false);
  }, [open, holiday]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  async function save() {
    const errs = validateHolidayForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input = { date: form.date, nameEn: form.nameEn.trim() || null, nameKm: form.nameKm.trim() || null, paid: form.paid, sourceNote: form.sourceNote.trim() || null };
    setBusy(true);
    try {
      if (holiday) await window.api.hr.updateHoliday(holiday.id, input);
      else await window.api.hr.createHoliday(input);
      addToast('Holiday saved.', 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={holiday ? 'Edit holiday' : 'New holiday'}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save holiday'}</Button></>}
    >
      <div className="form-grid">
        <Field label="Date" required error={errors.date}>
          {({ id }) => <Input id={id} type="date" value={form.date} invalid={!!errors.date} onChange={(e) => set('date')(e.target.value)} />}
        </Field>
        <label className="fuel-check"><input type="checkbox" checked={form.paid} onChange={(e) => set('paid')(e.target.checked)} /><span>Paid holiday</span></label>
        <Field label="Name (English)" error={errors.nameEn}>
          {({ id }) => <Input id={id} value={form.nameEn} invalid={!!errors.nameEn} onChange={(e) => set('nameEn')(e.target.value)} />}
        </Field>
        <Field label="Name (Khmer)">
          {({ id }) => <Input id={id} lang="km" value={form.nameKm} onChange={(e) => set('nameKm')(e.target.value)} />}
        </Field>
        <Field label="Source" span="full" hint="Where the date comes from, e.g. Sub-Decree No. 167 of 18 Sep 2025.">
          {({ id }) => <Input id={id} value={form.sourceNote} onChange={(e) => set('sourceNote')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/* ─── leave types ─────────────────────────────────────────────────────── */

function typeForm(t) {
  return {
    code: t?.code || '', nameEn: t?.nameEn || '', nameKm: t?.nameKm || '', paid: t ? !!t.paid : true,
    accrual: t?.accrual || 'none', accrualDays: String(t?.accrualDays ?? 0), tracksBalance: t ? !!t.tracksBalance : true,
    maxBalance: t?.maxBalance == null ? '' : String(t.maxBalance), carryOverMax: t?.carryOverMax == null ? '' : String(t.carryOverMax),
    maxDaysPerRequest: t?.maxDaysPerRequest == null ? '' : String(t.maxDaysPerRequest),
    countCalendarDays: !!t?.countCalendarDays, needsDocument: !!t?.needsDocument, note: t?.note || '',
  };
}

function LeaveTypeModal({ open, type, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState(typeForm(null));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(typeForm(type)); setErrors({}); setBusy(false); } }, [open, type]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const num = (v) => (String(v).trim() === '' ? null : Number(v));
  async function save() {
    const errs = {};
    if (!type && !/^[A-Za-z0-9_-]{2,30}$/.test(form.code.trim())) errs.code = '2–30 letters, digits, - or _';
    if (!form.nameEn.trim() && !form.nameKm.trim()) errs.nameEn = 'Give it a name';
    for (const k of ['accrualDays', 'maxBalance', 'carryOverMax', 'maxDaysPerRequest']) {
      const n = num(form[k]);
      if (n != null && (!Number.isFinite(n) || n < 0)) errs[k] = 'A number, 0 or more';
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input = {
      nameEn: form.nameEn.trim() || null, nameKm: form.nameKm.trim() || null, paid: form.paid, accrual: form.accrual,
      accrualDays: num(form.accrualDays) ?? 0, tracksBalance: form.tracksBalance, maxBalance: num(form.maxBalance),
      carryOverMax: num(form.carryOverMax), maxDaysPerRequest: num(form.maxDaysPerRequest),
      countCalendarDays: form.countCalendarDays, needsDocument: form.needsDocument, note: form.note.trim() || null,
    };
    setBusy(true);
    try {
      if (type) await window.api.leave.updateType(type.id, input);
      else await window.api.leave.createType({ code: form.code.trim(), ...input });
      addToast('Kind of leave saved.', 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title={type ? `Edit ${leaveTypeName(type)}` : 'New kind of leave'}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button></>}
    >
      <div className="form-grid">
        <Field label="Code" required={!type} error={errors.code} hint={type ? 'Fixed once created.' : 'Short, e.g. study. Used in the export.'}>
          {({ id }) => <Input id={id} value={form.code} disabled={!!type} invalid={!!errors.code} onChange={(e) => set('code')(e.target.value)} />}
        </Field>
        <label className="fuel-check"><input type="checkbox" checked={form.paid} onChange={(e) => set('paid')(e.target.checked)} /><span>Paid</span></label>
        <Field label="Name (English)" error={errors.nameEn}>
          {({ id }) => <Input id={id} value={form.nameEn} invalid={!!errors.nameEn} onChange={(e) => set('nameEn')(e.target.value)} />}
        </Field>
        <Field label="Name (Khmer)">
          {({ id }) => <Input id={id} lang="km" value={form.nameKm} onChange={(e) => set('nameKm')(e.target.value)} />}
        </Field>
        <label className="fuel-check"><input type="checkbox" checked={form.tracksBalance} onChange={(e) => set('tracksBalance')(e.target.checked)} /><span>Keep a balance (refuse requests beyond it)</span></label>
        <Field label="Earned">
          {({ id }) => (
            <Select id={id} value={form.accrual} onChange={(e) => set('accrual')(e.target.value)}>
              {ACCRUALS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Days earned each time" error={errors.accrualDays}>
          {({ id }) => <Input id={id} inputMode="decimal" value={form.accrualDays} disabled={form.accrual === 'none'} invalid={!!errors.accrualDays} onChange={(e) => set('accrualDays')(e.target.value)} />}
        </Field>
        <Field label="Most carried into next year" error={errors.carryOverMax} hint="Empty: no limit. 0: lapses on 31 Dec.">
          {({ id }) => <Input id={id} inputMode="decimal" value={form.carryOverMax} invalid={!!errors.carryOverMax} onChange={(e) => set('carryOverMax')(e.target.value)} />}
        </Field>
        <Field label="Largest balance" error={errors.maxBalance} hint="Empty: no limit.">
          {({ id }) => <Input id={id} inputMode="decimal" value={form.maxBalance} invalid={!!errors.maxBalance} onChange={(e) => set('maxBalance')(e.target.value)} />}
        </Field>
        <Field label="Most days in one request" error={errors.maxDaysPerRequest} hint="Empty: no limit.">
          {({ id }) => <Input id={id} inputMode="decimal" value={form.maxDaysPerRequest} invalid={!!errors.maxDaysPerRequest} onChange={(e) => set('maxDaysPerRequest')(e.target.value)} />}
        </Field>
        <label className="fuel-check"><input type="checkbox" checked={form.countCalendarDays} onChange={(e) => set('countCalendarDays')(e.target.checked)} /><span>Count calendar days (e.g. maternity), not work days</span></label>
        <label className="fuel-check"><input type="checkbox" checked={form.needsDocument} onChange={(e) => set('needsDocument')(e.target.checked)} /><span>Needs a document</span></label>
        <Field label="Note" span="full">
          {({ id }) => <Textarea id={id} rows={2} value={form.note} onChange={(e) => set('note')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
