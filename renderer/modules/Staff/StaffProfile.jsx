/**
 * HR1 staff profile (docs/PEOPLE_AND_FUEL_PLAN.md §5.1, §10), opened from the
 * Staff list by anyone with hr.view. Sections:
 *
 *   Details        basics (Edit basics…), employment (position, type, dates,
 *                  supervisor), private details (hr.manage only — the backend
 *                  leaves them out for everyone else, so they are not shown at
 *                  all rather than shown empty), schedule history, suspensions
 *   Documents      hr.manage: ID card, contract, … — view, add, void (never deleted)
 *   Attendance     the person's month, day by day; a day opens its detail
 *   Leave          balances, requests, ledger; request leave / adjust (hr.manage)
 *   Account & PIN  hr.manage: the linked app account, kiosk PIN set / reset /
 *                  clear / unlock (incl. a manager-only lock)
 *
 * The details save themselves (§6: debounced 500 ms, SaveStatus + Save).
 * Suspend (dated, reason) / End suspension and Mark as left / Back at work sit
 * in the header.
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Pagination, Select, Textarea, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { ReasonModal, StaffAvatar } from '../Fuel/FuelShared.jsx';
import { fmtShort } from '../Fuel/fuelModel.js';
import { useAutosave, useDocumentUrl, useHrCaps, useHrLookups, useHrTick, usePager, useStaffTick } from '../People/hrHooks.js';
import { DayDetailModal, DayStatusBadge, MonthSelect, ToneBadge, clampServerPage } from '../People/HrShared.jsx';
import { AdjustBalanceModal, LeaveRequestModal, LedgerTable, useLeaveDecisions } from '../People/LeaveModals.jsx';
import { BalanceTable } from '../People/Leave.jsx';
import {
  DOC_KINDS, EMPLOYMENT_TYPES, GENDERS, LEAVE_STATUS, OT_CATEGORIES, docKindLabel, errText, fmtDateRange, fmtDays, fmtHmOn, fmtHours,
  fmtMinutes, fmtWorkDate, leaveTypeName, otTotal, personName, pinProblem, pinStatus, ppDateKey, ppMonthKey, profileForm,
  profilePatch, scheduleLine, scheduleOn, staffStatus, validateProfileForm, validateSuspendForm, visibleFields,
} from '../People/hrModel.js';
import { MarkLeftModal, StaffEditorModal } from './index.jsx';

const SECTIONS = [
  { value: 'details', label: 'Details' },
  { value: 'documents', label: 'Documents', manage: true },
  { value: 'attendance', label: 'Attendance' },
  { value: 'leave', label: 'Leave' },
  { value: 'account', label: 'Account & PIN', manage: true },
];

export function StaffProfile({ id, onBack }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canManage, fuelManage } = useHrCaps();
  const lookups = useHrLookups();
  const staffTick = useStaffTick();
  const tick = useHrTick(['staff', 'document', 'schedule', 'position']);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [section, setSection] = useState('details');
  const [editingBasics, setEditingBasics] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [ending, setEnding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [draft, setDraft] = useState({});
  const [draftErrors, setDraftErrors] = useState({});

  const autosave = useAutosave(async (patch) => {
    const next = await window.api.hr.updateProfile(id, patch);
    setProfile((p) => (p ? { ...p, ...next } : p));
  }, { label: 'the details' });

  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let alive = true;
    window.api.hr.getProfile(id)
      .then((p) => {
        if (!alive) return;
        setProfile(p);
        setError(null);
        // Never overwrite a value still being typed or waiting to save.
        if (!autosave.hasPending()) setDraft(profileForm(p));
      })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [id, activeCompanyId, staffTick, tick, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => setRetry((n) => n + 1);
  const fields = visibleFields(profile);
  const visibleSections = SECTIONS.filter((s) => !s.manage || canManage);

  function change(key, value) {
    const next = { ...draft, [key]: value };
    setDraft(next);
    const errs = validateProfileForm(next);
    setDraftErrors(errs);
    if (errs[key]) return;
    const patch = profilePatch(profileForm(profile), { [key]: value });
    if (Object.keys(patch).length) autosave.queue(patch);
  }

  async function backAtWork() {
    try { await window.api.staff.reactivate(id); addToast('Back at work.', 'success'); reload(); }
    catch (err) { addToast(errText(err), 'error'); }
  }

  if (error && !profile) {
    return (
      <div className="page">
        <PageHeader title="Staff member" backTo={{ label: 'Staff', onClick: onBack }} />
        <EmptyState title="Couldn't open this person" body={error} action={<Button onClick={reload}>Try again</Button>} />
      </div>
    );
  }
  if (!profile) {
    return <div className="page"><PageHeader title="Staff member" backTo={{ label: 'Staff', onClick: onBack }} /><p className="muted">Loading…</p></div>;
  }

  const st = staffStatus(profile);
  const positionName = profile.position?.nameEn || profile.position?.nameKm || profile.positionText || null;
  return (
    <div className="page page--staff-profile">
      <PageHeader
        title={personName(profile)}
        subtitle={[profile.nameEn && profile.nameKm ? profile.nameKm : null, profile.staffCode, positionName].filter(Boolean).join(' · ')}
        backTo={{ label: 'Staff', onClick: () => { autosave.flush(); onBack(); } }}
        actions={(
          <>
            {canManage ? <SaveStatus state={autosave.status.state} savedAt={autosave.status.savedAt} error={autosave.status.error} onSave={autosave.flush} /> : null}
            {canManage || fuelManage ? <Button onClick={() => setEditingBasics(true)}>Edit basics…</Button> : null}
            {canManage && profile.status === 'active' ? <Button onClick={() => setSuspending(true)}>Suspend…</Button> : null}
            {canManage && profile.status === 'suspended' ? <Button onClick={() => setEnding(true)}>End suspension…</Button> : null}
            {(canManage || fuelManage) && profile.status !== 'left' ? <Button variant="danger" onClick={() => setLeaving(true)}>Mark as left…</Button> : null}
            {(canManage || fuelManage) && profile.status === 'left' ? <Button onClick={backAtWork}>Back at work</Button> : null}
          </>
        )}
      />

      <div className="hr-profile-head">
        <StaffAvatar employee={profile} size={72} />
        <div className="hr-profile-head__text">
          <div className="hr-badges">
            <Badge tone={st.tone}>{st.label}</Badge>
            {profile.isDriver ? <Badge tone="blue">Driver</Badge> : null}
            {profile.isFuelAttendant ? <Badge tone="blue">Pump attendant</Badge> : null}
            {'hasPin' in profile ? <ToneBadge meta={pinStatus(profile)} /> : null}
            {profile.userId ? <Badge tone="slate">App account linked</Badge> : null}
          </div>
          {profile.status === 'suspended' && fields.statusReason && profile.statusReason ? <p className="muted">Suspended: {profile.statusReason}</p> : null}
          {profile.status === 'left' ? <p className="muted">Left on {profile.leftOn}{profile.leftReason ? ` — ${profile.leftReason}` : ''}.</p> : null}
        </div>
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="Section">
          {visibleSections.map((s) => <button key={s.value} type="button" className={`segment${section === s.value ? ' is-active' : ''}`} onClick={() => setSection(s.value)}>{s.label}</button>)}
        </div>
      </div>

      {section === 'details' ? (
        <DetailsSection profile={profile} draft={draft} errors={draftErrors} fields={fields} lookups={lookups} canManage={canManage} onChange={change} />
      ) : null}
      {section === 'documents' && canManage ? <DocumentsSection profile={profile} /> : null}
      {section === 'attendance' ? <AttendanceSection profile={profile} canManage={canManage} /> : null}
      {section === 'leave' ? <LeaveSection profile={profile} lookups={lookups} canManage={canManage} /> : null}
      {section === 'account' && canManage ? <AccountSection profile={profile} onChanged={reload} /> : null}

      <StaffEditorModal open={editingBasics} employee={profile} onSaved={() => {}} onClose={() => { setEditingBasics(false); reload(); }} />
      <SuspendModal open={suspending} employee={profile} onClose={() => { setSuspending(false); reload(); }} />
      <EndSuspensionModal open={ending} employee={profile} onClose={() => { setEnding(false); reload(); }} />
      <MarkLeftModal open={leaving} employee={profile} onCancel={() => setLeaving(false)} onDone={() => { setLeaving(false); reload(); }} />
    </div>
  );
}

/* ─── Details ─────────────────────────────────────────────────────────── */

function ReadValue({ label, children }) {
  return (
    <div className="hr-read">
      <div className="hr-read__label">{label}</div>
      <div className="hr-read__value">{children || <span className="muted">—</span>}</div>
    </div>
  );
}

function DetailsSection({ profile, draft, errors, fields, lookups, canManage, onChange }) {
  const [assigning, setAssigning] = useState(false);
  const positions = lookups.positions.filter((p) => !p.archived || p.id === draft.positionId);
  const supervisors = lookups.staff.filter((e) => e.id !== profile.id && (e.status !== 'left' || e.id === draft.supervisorEmployeeId));
  const today = ppDateKey();
  const current = scheduleOn(profile.schedules, today);
  const defaultSchedule = lookups.settings?.defaultScheduleId ? lookups.maps.schedules.get(lookups.settings.defaultScheduleId) : null;
  const field = (key, label, input) => (
    <Field label={label} error={errors[key]}>
      {({ id }) => input(id)}
    </Field>
  );
  const text = (key, label, props = {}) => field(key, label, (id) => (
    canManage
      ? <Input id={id} value={draft[key] ?? ''} invalid={!!errors[key]} onChange={(e) => onChange(key, e.target.value)} {...props} />
      : <Input id={id} value={draft[key] ?? ''} readOnly disabled {...props} />
  ));
  const date = (key, label) => text(key, label, { type: 'date' });

  return (
    <div className="hr-sections">
      <section className="card hr-card">
        <h2 className="section-title">Basics</h2>
        <div className="hr-read-grid">
          <ReadValue label="Name (English)">{profile.nameEn}</ReadValue>
          <ReadValue label="Name (Khmer)"><span lang="km">{profile.nameKm}</span></ReadValue>
          <ReadValue label="Staff code"><code>{profile.staffCode}</code></ReadValue>
          <ReadValue label="Phone">{profile.phone}</ReadValue>
          <ReadValue label="Position (as written)">{profile.positionText}</ReadValue>
          {fields.notes ? <ReadValue label="Notes">{profile.notes}</ReadValue> : null}
        </div>
      </section>

      <section className="card hr-card">
        <h2 className="section-title">Employment</h2>
        <div className="form-grid">
          {field('positionId', 'Position', (id) => (
            <Select id={id} value={draft.positionId || ''} disabled={!canManage} onChange={(e) => onChange('positionId', e.target.value)}>
              <option value="">Not set</option>
              {positions.map((p) => <option key={p.id} value={p.id}>{p.nameEn || p.nameKm}{p.department ? ` · ${p.department}` : ''}{p.archived ? ' (hidden)' : ''}</option>)}
            </Select>
          ))}
          {field('employmentType', 'Paid', (id) => (
            <Select id={id} value={draft.employmentType || ''} disabled={!canManage} onChange={(e) => onChange('employmentType', e.target.value)}>
              <option value="">Not set</option>
              {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          ))}
          {date('hireDate', 'Started')}
          {date('endDate', 'Contract ends')}
          {field('supervisorEmployeeId', 'Supervisor', (id) => (
            <Select id={id} value={draft.supervisorEmployeeId || ''} disabled={!canManage} onChange={(e) => onChange('supervisorEmployeeId', e.target.value)}>
              <option value="">None</option>
              {supervisors.map((e) => <option key={e.id} value={e.id}>{personName(e)} · {e.staffCode}</option>)}
            </Select>
          ))}
          {field('gender', 'Gender', (id) => (
            <Select id={id} value={draft.gender || ''} disabled={!canManage} onChange={(e) => onChange('gender', e.target.value)}>
              <option value="">Not set</option>
              {GENDERS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </Select>
          ))}
        </div>
        <p className="field__hint">The supervisor can mark this person in and out from their phone; every mark is reviewed.</p>
      </section>

      {fields.private ? (
        <section className="card hr-card">
          <div className="section-head">
            <h2 className="section-title">Private details</h2>
            <span className="section-hint">Seen only by people who manage staff. History records only that they changed.</span>
          </div>
          <div className="form-grid">
            {date('dob', 'Date of birth')}
            {text('nationalIdNo', 'National ID number')}
            {text('nssfNo', 'NSSF number')}
            {text('bankName', 'Bank')}
            {text('bankAccountName', 'Account name')}
            {text('bankAccountNo', 'Account number')}
            <Field label="Address" span="full">
              {({ id }) => <Textarea id={id} rows={2} value={draft.address ?? ''} readOnly={!canManage} disabled={!canManage} onChange={(e) => onChange('address', e.target.value)} />}
            </Field>
          </div>
        </section>
      ) : null}

      <section className="card hr-card">
        <div className="section-head">
          <h2 className="section-title">Work schedule</h2>
          <span className="section-hint">{current ? `Now: ${current.scheduleName}` : `Now: ${defaultSchedule ? `${defaultSchedule.name} (the company default)` : 'the company default'}`}</span>
          {canManage ? <div className="section-head__actions"><Button size="sm" onClick={() => setAssigning(true)}>Change schedule…</Button></div> : null}
        </div>
        {profile.schedules?.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>From</th><th>Schedule</th><th>Hours</th></tr></thead>
              <tbody>
                {[...profile.schedules].reverse().map((h) => (
                  <tr key={h.id || `${h.scheduleId}-${h.effectiveFrom}`} className={current && current.effectiveFrom === h.effectiveFrom ? 'is-selected' : ''}>
                    <td>{h.effectiveFrom}</td>
                    <td>{h.scheduleName}</td>
                    <td className="muted">{scheduleLine(lookups.maps.schedules.get(h.scheduleId))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No schedule of their own — the company default applies{defaultSchedule ? ` (${scheduleLine(defaultSchedule)})` : ''}.</p>}
      </section>

      {profile.suspensions?.length ? (
        <section className="card hr-card">
          <h2 className="section-title">Suspensions</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>From</th><th>To</th>{profile.suspensions.some((s) => 'reason' in s) ? <th>Reason</th> : null}</tr></thead>
              <tbody>
                {profile.suspensions.map((s, i) => (
                  <tr key={s.id || i}>
                    <td>{s.fromDate}</td>
                    <td>{s.toDate || <Badge tone="rose">Open</Badge>}</td>
                    {'reason' in s ? <td className="hr-cell-text">{s.reason}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <AssignScheduleModal open={assigning} employee={profile} schedules={lookups.schedules} onClose={() => setAssigning(false)} />
    </div>
  );
}

export function AssignScheduleModal({ open, employee, employees = null, schedules, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [scheduleId, setScheduleId] = useState('');
  const [from, setFrom] = useState(ppDateKey());
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const many = Array.isArray(employees);
  useEffect(() => { if (open) { setScheduleId(''); setFrom(ppDateKey()); setPicked([]); setBusy(false); setError(null); } }, [open]);
  const live = (schedules || []).filter((s) => !s.archived);
  async function save() {
    const ids = many ? picked : [employee?.id];
    if (!scheduleId) { setError('Choose a schedule'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { setError('Choose the first day'); return; }
    if (!ids.length || !ids[0]) { setError('Choose at least one person'); return; }
    setBusy(true);
    let done = 0;
    const failed = [];
    for (const id of ids) {
      try { await window.api.hr.assignSchedule(id, scheduleId, from); done += 1; }
      catch (err) { failed.push(errText(err)); }
    }
    setBusy(false);
    if (failed.length) { setError(`${done} done; ${failed.length} failed — ${failed[0]}`); return; }
    addToast(many ? `Schedule set for ${done} ${done === 1 ? 'person' : 'people'} from ${from}.` : `Schedule set from ${from}.`, 'success');
    onClose();
  }
  const people = many ? employees.filter((e) => e.status !== 'left') : [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size={many ? 'lg' : undefined}
      title={many ? 'Assign a schedule' : `Change ${personName(employee)}'s schedule`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Set schedule'}</Button></>}
    >
      <p className="fuel-modal-text">From the day you choose. Earlier days keep the schedule they had, so past attendance does not change. The same day again replaces it.</p>
      <div className="form-grid">
        <Field label="Schedule" required error={error}>
          {({ id }) => (
            <Select id={id} value={scheduleId} onChange={(e) => { setScheduleId(e.target.value); setError(null); }}>
              <option value="">Choose…</option>
              {live.map((s) => <option key={s.id} value={s.id}>{s.name} · {scheduleLine(s)}</option>)}
            </Select>
          )}
        </Field>
        <Field label="From" required>
          {({ id }) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
      </div>
      {many ? (
        <div className="hr-pick-list">
          <div className="hr-pick-list__head">
            <span className="muted">{picked.length} of {people.length} chosen</span>
            <Button size="sm" variant="ghost" onClick={() => setPicked(picked.length === people.length ? [] : people.map((e) => e.id))}>{picked.length === people.length ? 'Choose none' : 'Choose everyone'}</Button>
          </div>
          {people.map((e) => (
            <label key={e.id} className="fuel-check hr-pick">
              <input type="checkbox" checked={picked.includes(e.id)} onChange={(ev) => setPicked((p) => (ev.target.checked ? [...p, e.id] : p.filter((x) => x !== e.id)))} />
              <span>{personName(e)} <span className="muted">· {e.staffCode}</span></span>
            </label>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}

function SuspendModal({ open, employee, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState({ fromDate: ppDateKey(), toDate: '', reason: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm({ fromDate: ppDateKey(), toDate: '', reason: '' }); setErrors({}); setBusy(false); } }, [open]);
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setErrors((x) => ({ ...x, [k]: undefined })); };
  async function save() {
    const errs = validateSuspendForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await window.api.hr.setStatus({ id: employee.id, status: 'suspended', reason: form.reason.trim(), fromDate: form.fromDate, toDate: form.toDate || undefined });
      addToast(`${personName(employee)} is suspended.`, 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      closeOnBackdrop={false}
      title={`Suspend ${personName(employee)}?`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Suspend'}</Button></>}
    >
      <p className="fuel-modal-text">They cannot clock in while suspended. Suspended days are never counted as absent or late. Their records stay.</p>
      <div className="form-grid">
        <Field label="From" required error={errors.fromDate}>
          {({ id }) => <Input id={id} type="date" value={form.fromDate} invalid={!!errors.fromDate} onChange={set('fromDate')} />}
        </Field>
        <Field label="Until" error={errors.toDate} hint="Empty until you end it.">
          {({ id }) => <Input id={id} type="date" value={form.toDate} invalid={!!errors.toDate} onChange={set('toDate')} />}
        </Field>
        <Field label="Reason" required span="full" error={errors.reason}>
          {({ id }) => <Textarea id={id} rows={2} value={form.reason} invalid={!!errors.reason} onChange={set('reason')} />}
        </Field>
      </div>
    </Modal>
  );
}

function EndSuspensionModal({ open, employee, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [lastDay, setLastDay] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setLastDay(''); setBusy(false); } }, [open]);
  async function save() {
    setBusy(true);
    try {
      await window.api.hr.setStatus({ id: employee.id, status: 'active', toDate: lastDay || undefined });
      addToast(`${personName(employee)} is back at work.`, 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`End ${personName(employee)}'s suspension?`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Back at work'}</Button></>}
    >
      <p className="fuel-modal-text">They can clock in again at once.</p>
      <Field label="Last day suspended" hint="Empty: yesterday — they work from today.">
        {({ id }) => <Input id={id} type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} />}
      </Field>
    </Modal>
  );
}

/* ─── Documents ───────────────────────────────────────────────────────── */

function DocumentsSection({ profile }) {
  const addToast = useAppStore((s) => s.addToast);
  const tick = useHrTick(['document']);
  const [docs, setDocs] = useState([]);
  const [showVoided, setShowVoided] = useState(false);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    window.api.hr.listDocuments(profile.id, showVoided)
      .then((d) => { if (alive) { setDocs(d || []); setError(null); } })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [profile.id, showVoided, tick, retry]);
  return (
    <section className="card hr-card">
      <div className="section-head">
        <h2 className="section-title">Documents</h2>
        <span className="section-hint">ID cards, contracts, certificates. Each opening is recorded in History.</span>
        <div className="section-head__actions">
          <label className="fuel-check"><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} /><span>Show voided</span></label>
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>+ Add document…</Button>
        </div>
      </div>
      {error ? <p className="field__error">{error}</p> : null}
      {docs.length === 0 ? <p className="muted">No documents yet.</p> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Kind</th><th>Title</th><th>Added</th><th className="is-num">Size</th><th /><th className="is-actions" /></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className={d.voided ? 'is-muted hr-struck' : ''}>
                  <td>{docKindLabel(d.kind)}</td>
                  <td>{d.title || <span className="muted">—</span>}</td>
                  <td>{fmtShort(d.uploadedAt)}</td>
                  <td className="is-num">{d.bytes ? `${Math.max(1, Math.round(d.bytes / 1024))} KB` : '—'}</td>
                  <td>{d.voided ? <Badge tone="rose">Voided{d.voidReason ? `: ${d.voidReason}` : ''}</Badge> : <Badge tone="slate">{d.mime === 'application/pdf' ? 'PDF' : 'Image'}</Badge>}</td>
                  <td className="is-actions">
                    <div className="hr-row-actions">
                      <Button size="sm" variant="ghost" onClick={() => setViewing(d)}>Open</Button>
                      {!d.voided ? <Button size="sm" variant="ghost" onClick={() => setVoiding(d)}>Void…</Button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddDocumentModal open={adding} employee={profile} onClose={() => { setAdding(false); setRetry((n) => n + 1); }} />
      <DocumentViewer open={!!viewing} doc={viewing} onClose={() => setViewing(null)} />
      <ReasonModal
        open={!!voiding}
        title="Void this document?"
        message="It is hidden from the list and kept on disk (never deleted). Say why."
        confirmLabel="Void document"
        danger
        onCancel={() => setVoiding(null)}
        onConfirm={async (reason) => {
          await window.api.hr.voidDocument(voiding.id, reason);
          addToast('Document voided.', 'success');
          setVoiding(null);
          setRetry((n) => n + 1);
        }}
      />
    </section>
  );
}

function AddDocumentModal({ open, employee, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [kind, setKind] = useState('id_card');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setKind('id_card'); setTitle(''); setFile(null); setError(null); setBusy(false); } }, [open]);
  async function save() {
    if (!file) { setError('Choose a file'); return; }
    if (file.size > 15 * 1024 * 1024) { setError('That file is over 15 MB'); return; }
    if (!/^image\//.test(file.type) && file.type !== 'application/pdf') { setError('Choose a photo, a scan or a PDF'); return; }
    setBusy(true);
    try {
      await window.api.hr.addDocument({ employeeId: employee.id, kind, title: title.trim() || undefined, bytes: await file.arrayBuffer() });
      addToast('Document added.', 'success');
      onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`Add a document for ${personName(employee)}`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Uploading…' : 'Add document'}</Button></>}
    >
      <p className="fuel-modal-text">A PDF is kept as it is; a photo or scan is stored as a JPEG. 15 MB at most. Kept with the person, never in the product folders.</p>
      <div className="form-grid">
        <Field label="Kind">
          {({ id }) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
              {DOC_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Title" hint="Optional, e.g. Contract 2026.">
          {({ id }) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="File" required span="full" error={error}>
          {({ id }) => <input id={id} type="file" accept="image/*,application/pdf" onChange={(e) => { setFile(e.target.files?.[0] || null); setError(null); }} />}
        </Field>
      </div>
    </Modal>
  );
}

function DocumentViewer({ open, doc, onClose }) {
  const { url, intact, error, loading, mime } = useDocumentUrl(open ? doc : null);
  const isPdf = (mime || doc?.mime) === 'application/pdf';
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={`${docKindLabel(doc?.kind)}${doc?.title ? ` — ${doc.title}` : ''}`}
      footer={url ? <a className="btn" href={url} download={`${doc?.title || docKindLabel(doc?.kind)}${isPdf ? '.pdf' : '.jpg'}`}>Save a copy…</a> : null}
    >
      {!intact ? <p><Badge tone="rose">This file has changed since it was added</Badge></p> : null}
      {loading ? <p className="muted">Loading…</p> : error ? <p className="field__error">Couldn't open it: {error}</p> : isPdf ? (
        <p className="muted">PDF documents open outside the app: use Save a copy…, then open the saved file.</p>
      ) : url ? <div className="hr-doc-frame"><img src={url} alt={docKindLabel(doc?.kind)} /></div> : null}
    </Modal>
  );
}

/* ─── Attendance ──────────────────────────────────────────────────────── */

function AttendanceSection({ profile, canManage }) {
  const tick = useHrTick(['attendance', 'correction', 'leave', 'holiday', 'schedule', 'overtime', 'lateness']);
  const [month, setMonth] = useState(ppMonthKey());
  const [row, setRow] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    let alive = true;
    window.api.attendance.monthSummary({ month, employeeId: profile.id })
      .then((s) => { if (alive) { setRow(s?.rows?.[0] || { days: [], totals: null }); setError(null); } })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [profile.id, month, tick]);
  const t = row?.totals;
  const days = (row?.days || []).filter((d) => d.status !== 'not_employed');
  return (
    <section className="card hr-card">
      <div className="section-head">
        <h2 className="section-title">Attendance</h2>
        <div className="section-head__actions"><MonthSelect value={month} onChange={setMonth} /></div>
      </div>
      {error ? <p className="field__error">{error}</p> : null}
      {t ? (
        <div className="hr-totals">
          <span>Worked <strong>{t.daysWorked} d · {fmtHours(t.workedMin)}</strong></span>
          <span>Late <strong>{t.lateMin ? `${t.lateMin} min (${t.lateDays} d)` : '—'}</strong></span>
          <span>Left early <strong>{t.earlyLeaveMin ? `${t.earlyLeaveMin} min` : '—'}</strong></span>
          <span>Absent <strong>{t.absentDays || '—'}</strong></span>
          <span>Leave <strong>{t.leaveDays || '—'}</strong></span>
          <span>Overtime <strong>{otTotal(t.overtimeComputed) ? `${fmtMinutes(otTotal(t.overtimeComputed))} (${fmtMinutes(otTotal(t.overtimeApproved))} approved)` : '—'}</strong></span>
          {t.missingOutDays ? <Badge tone="amber">{t.missingOutDays} without a clock-out</Badge> : null}
        </div>
      ) : null}
      {days.length === 0 ? <p className="muted">{row ? 'Nothing to show for this month.' : 'Loading…'}</p> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Day</th><th>Status</th><th>In</th><th>Out</th><th className="is-num">Worked</th><th className="is-num">Late</th><th className="is-num">Overtime</th></tr></thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date} className="is-clickable" onClick={() => setOpen(d)}>
                  <td className="hr-nowrap">{fmtWorkDate(d.date)}</td>
                  <td><DayStatusBadge status={d.status} />{d.holiday ? <span className="muted"> {d.holiday.nameEn || d.holiday.nameKm}</span> : null}</td>
                  <td>{fmtHmOn(d.firstIn, d.date)}</td>
                  <td>{fmtHmOn(d.lastOut, d.date)}</td>
                  <td className="is-num">{d.workedMin ? fmtHours(d.workedMin) : '—'}</td>
                  <td className="is-num">{d.lateMin ? `${d.lateMin} min` : '—'}</td>
                  <td className="is-num" title={OT_CATEGORIES.filter((c) => d.overtime?.[c.key]).map((c) => `${c.label} ${d.overtime[c.key]} min`).join(', ')}>{otTotal(d.overtime) ? fmtMinutes(otTotal(d.overtime)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DayDetailModal open={!!open} employee={profile} date={open?.date} day={open} canManage={canManage} onClose={() => setOpen(null)} />
    </section>
  );
}

/* ─── Leave ───────────────────────────────────────────────────────────── */

function LeaveSection({ profile, lookups, canManage }) {
  const tick = useHrTick(['leave', 'leaveType']);
  const [balances, setBalances] = useState([]);
  const [requests, setRequests] = useState({ items: [], total: 0 });
  const [ledger, setLedger] = useState([]);
  // Review fix L6: requests are paged on the server, the ledger on screen (§10).
  const pager = usePager([profile.id]);
  const [ledgerPage, setLedgerPage] = useState(0);
  const [ledgerSize, setLedgerSize] = useState(50);
  const [retry, setRetry] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [error, setError] = useState(null);
  const decisions = useLeaveDecisions(() => setRetry((n) => n + 1));
  useEffect(() => {
    let alive = true;
    Promise.all([
      window.api.leave.balances(profile.id),
      window.api.leave.ledger(profile.id),
    ]).then(([b, l]) => {
      if (!alive) return;
      setBalances(b || []); setLedger(l || []); setError(null);
    }).catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [profile.id, tick, retry]);
  useEffect(() => {
    let alive = true;
    window.api.leave.listRequests({ employeeId: profile.id, limit: pager.pageSize, offset: pager.offset })
      .then((r) => {
        if (!alive) return;
        setRequests({ items: r?.items || [], total: r?.total || 0 });
        clampServerPage(r?.total, pager.page, pager.pageSize, pager.setPage);
      })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [profile.id, pager.page, pager.pageSize, pager.offset, tick, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  const reqPage = paginate(requests.total, pager.page, pager.pageSize);
  const led = paginate(ledger.length, ledgerPage, ledgerSize);
  return (
    <div className="hr-sections">
      <section className="card hr-card">
        <div className="section-head">
          <h2 className="section-title">Balances</h2>
          {canManage ? (
            <div className="section-head__actions">
              <Button size="sm" onClick={() => setAdjusting(true)}>Adjust balance…</Button>
              <Button size="sm" variant="primary" onClick={() => setRequesting(true)}>+ Request leave…</Button>
            </div>
          ) : null}
        </div>
        {error ? <p className="field__error">{error}</p> : null}
        <BalanceTable balances={balances} />
      </section>
      <section className="card hr-card">
        <h2 className="section-title">Requests</h2>
        {requests.items.length === 0 ? <p className="muted">No leave requests yet.</p> : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Leave</th><th>When</th><th className="is-num">Days</th><th>Reason</th><th>Status</th>{canManage ? <th className="is-actions" /> : null}</tr></thead>
              <tbody>
                {requests.items.map((r) => (
                  <tr key={r.id}>
                    <td>{leaveTypeName(lookups.maps.leaveTypes.get(r.leaveTypeId))}</td>
                    <td>{fmtDateRange(r.fromDate, r.toDate)}{r.halfDay ? <span className="muted"> ({r.halfDay === 'am' ? 'morning' : 'afternoon'})</span> : null}</td>
                    <td className="is-num">{fmtDays(r.days)}</td>
                    <td className="hr-cell-text">{r.reason || <span className="muted">—</span>}</td>
                    <td><ToneBadge meta={LEAVE_STATUS[r.status]} />{r.decisionNote ? <div className="muted">{r.decisionNote}</div> : null}</td>
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
        <Pagination total={requests.total} pageStart={reqPage.pageStart} pageEnd={Math.min(reqPage.pageStart + requests.items.length, requests.total)}
          currentPage={reqPage.currentPage} maxPage={reqPage.maxPage} pageSize={pager.pageSize} onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize} />
      </section>
      <section className="card hr-card">
        <h2 className="section-title">Ledger</h2>
        <LedgerTable rows={ledger.slice(led.pageStart, led.pageEnd)} types={lookups.maps.leaveTypes} />
        <Pagination total={ledger.length} pageStart={led.pageStart} pageEnd={led.pageEnd} currentPage={led.currentPage} maxPage={led.maxPage}
          pageSize={ledgerSize} onPageChange={setLedgerPage} onPageSizeChange={(n) => { setLedgerSize(n); setLedgerPage(0); }} />
      </section>
      <LeaveRequestModal open={requesting} staff={lookups.staff} types={lookups.leaveTypes} employeeId={profile.id} onClose={() => { setRequesting(false); setRetry((n) => n + 1); }} />
      <AdjustBalanceModal open={adjusting} employee={profile} types={lookups.leaveTypes} onClose={() => { setAdjusting(false); setRetry((n) => n + 1); }} />
      {decisions.dialogs}
    </div>
  );
}

/* ─── Account & PIN ───────────────────────────────────────────────────── */

function AccountSection({ profile, onChanged }) {
  const addToast = useAppStore((s) => s.addToast);
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState(profile.userId || '');
  const [busy, setBusy] = useState(false);
  const [settingPin, setSettingPin] = useState(false);
  useEffect(() => { setUserId(profile.userId || ''); }, [profile.userId]);
  useEffect(() => {
    let alive = true;
    window.api.users?.listForAttribution?.().then((u) => { if (alive) setUsers(Array.isArray(u) ? u : []); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const pin = pinStatus(profile);

  async function saveAccount(next) {
    setUserId(next);
    setBusy(true);
    try {
      await window.api.staff.update(profile.id, { userId: next || null });
      addToast(next ? 'App account linked.' : 'App account unlinked.', 'success');
      onChanged();
    } catch (err) { addToast(errText(err), 'error'); setUserId(profile.userId || ''); }
    finally { setBusy(false); }
  }
  async function clearPin() {
    const ok = await confirm({
      title: `Remove ${personName(profile)}'s PIN?`,
      message: 'They cannot sign in on the kiosk until a new PIN is set.',
      confirmLabel: 'Remove PIN',
      danger: true,
    });
    if (!ok) return;
    try { await window.api.hr.clearPin(profile.id); addToast('PIN removed.', 'success'); onChanged(); }
    catch (err) { addToast(errText(err), 'error'); }
  }
  async function unlock() {
    try { await window.api.hr.unlockPin(profile.id); addToast('PIN unlocked.', 'success'); onChanged(); }
    catch (err) { addToast(errText(err), 'error'); }
  }

  return (
    <div className="hr-sections">
      <section className="card hr-card">
        <h2 className="section-title">App account</h2>
        <p className="muted">A linked account lets this person clock in with a selfie on their own phone, see their attendance and leave, and — with "Mark my crew" — mark the people they supervise. One account links to one person per company.</p>
        <div className="form-grid">
          <Field label="Linked account">
            {({ id }) => (
              <Select id={id} value={userId} disabled={busy} onChange={(e) => saveAccount(e.target.value)}>
                <option value="">None</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                {userId && !users.some((u) => u.id === userId) ? <option value={userId}>Linked account</option> : null}
              </Select>
            )}
          </Field>
        </div>
      </section>
      <section className="card hr-card">
        <div className="section-head">
          <h2 className="section-title">Kiosk PIN</h2>
          <ToneBadge meta={pin} />
        </div>
        <p className="muted">The PIN signs this person in on the shop kiosk. Wrong PINs lock it for a while; the third lock in a day can only be lifted here.</p>
        <div className="hr-actions-row">
          <Button variant="primary" onClick={() => setSettingPin(true)}>{profile.hasPin ? 'Reset PIN…' : 'Set PIN…'}</Button>
          {pin.locked ? <Button onClick={unlock}>Unlock PIN</Button> : null}
          {profile.hasPin ? <Button variant="danger" onClick={clearPin}>Remove PIN…</Button> : null}
        </div>
      </section>
      <PinModal open={settingPin} employee={profile} onClose={() => { setSettingPin(false); onChanged(); }} />
    </div>
  );
}

function PinModal({ open, employee, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPin(''); setAgain(''); setError(null); setBusy(false); } }, [open]);
  async function save() {
    const problem = pinProblem(pin);
    if (problem) { setError(problem); return; }
    if (pin !== again) { setError('The two PINs are different'); return; }
    setBusy(true);
    try {
      await window.api.hr.setPin(employee.id, pin);
      addToast('PIN set. Tell them in person.', 'success');
      onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  const digits = (v) => v.replace(/\D/g, '').slice(0, 8);
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`${employee?.hasPin ? 'Reset' : 'Set'} ${personName(employee)}'s PIN`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Set PIN'}</Button></>}
    >
      <p className="fuel-modal-text">4 to 8 digits — not one digit repeated and not a run like 1234. It also lifts any lock.</p>
      <div className="form-grid">
        <Field label="New PIN" required error={error}>
          {({ id }) => <Input id={id} type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => { setPin(digits(e.target.value)); setError(null); }} />}
        </Field>
        <Field label="Type it again" required>
          {({ id }) => <Input id={id} type="password" inputMode="numeric" autoComplete="off" value={again} onChange={(e) => { setAgain(digits(e.target.value)); setError(null); }} />}
        </Field>
      </div>
    </Modal>
  );
}

