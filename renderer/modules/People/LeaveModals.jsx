/**
 * HR1 leave dialogs and tables shared by People → Leave and the staff
 * profile: request leave on someone's behalf, adjust a balance (opening
 * balances, with a note), decide a request (approve — asking before a
 * balance goes below zero — reject with a note, cancel with a reason), and
 * the ledger of one person.
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { ReasonModal } from '../Fuel/FuelShared.jsx';
import {
  LEDGER_KINDS, errText, fmtDays, fmtWorkDate, leaveTypeName, negativeBalanceQuestion, personName, ppDateKey, validateAdjustForm,
  validateLeaveRequestForm,
} from './hrModel.js';

export function LeaveRequestModal({ open, staff, types, employeeId = '', onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const blank = () => ({ employeeId, leaveTypeId: '', fromDate: ppDateKey(), toDate: '', halfDay: '', reason: '' });
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(blank()); setErrors({}); setBusy(false); } }, [open, employeeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  async function save() {
    const errs = validateLeaveRequestForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await window.api.leave.request({
        employeeId: form.employeeId, leaveTypeId: form.leaveTypeId, fromDate: form.fromDate,
        toDate: form.toDate || undefined, halfDay: form.halfDay || undefined, reason: form.reason.trim() || undefined,
      });
      addToast('Leave requested — approve it in the list.', 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  const people = (staff || []).filter((e) => e.status !== 'left' || e.id === form.employeeId);
  const liveTypes = (types || []).filter((t) => !t.archived);
  const type = liveTypes.find((t) => t.id === form.leaveTypeId);
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title="Request leave"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Request leave'}</Button></>}
    >
      <p className="fuel-modal-text">On someone's behalf. The days are counted from their schedule, without public holidays.</p>
      <div className="form-grid">
        <Field label="Person" required error={errors.employeeId}>
          {({ id }) => (
            <Select id={id} value={form.employeeId} invalid={!!errors.employeeId} disabled={!!employeeId} onChange={(e) => set('employeeId')(e.target.value)}>
              <option value="">Choose…</option>
              {people.map((e) => <option key={e.id} value={e.id}>{personName(e)} · {e.staffCode}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Kind of leave" required error={errors.leaveTypeId} hint={type?.needsDocument ? 'Needs a document (e.g. a doctor\'s note) — add it to their Documents.' : undefined}>
          {({ id }) => (
            <Select id={id} value={form.leaveTypeId} invalid={!!errors.leaveTypeId} onChange={(e) => set('leaveTypeId')(e.target.value)}>
              <option value="">Choose…</option>
              {liveTypes.map((t) => <option key={t.id} value={t.id}>{leaveTypeName(t)}{t.paid ? '' : ' (unpaid)'}</option>)}
            </Select>
          )}
        </Field>
        <Field label="First day" required error={errors.fromDate}>
          {({ id }) => <Input id={id} type="date" value={form.fromDate} invalid={!!errors.fromDate} onChange={(e) => set('fromDate')(e.target.value)} />}
        </Field>
        <Field label="Last day" error={errors.toDate} hint="Empty for one day.">
          {({ id }) => <Input id={id} type="date" value={form.toDate} invalid={!!errors.toDate} onChange={(e) => set('toDate')(e.target.value)} />}
        </Field>
        <Field label="Half day" error={errors.halfDay}>
          {({ id }) => (
            <Select id={id} value={form.halfDay} invalid={!!errors.halfDay} onChange={(e) => set('halfDay')(e.target.value)}>
              <option value="">No — whole day(s)</option>
              <option value="am">Morning</option>
              <option value="pm">Afternoon</option>
            </Select>
          )}
        </Field>
        <Field label="Reason" span="full">
          {({ id }) => <Textarea id={id} rows={2} value={form.reason} onChange={(e) => set('reason')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

export function AdjustBalanceModal({ open, employee, types, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const blank = () => ({ leaveTypeId: '', days: '', date: ppDateKey(), note: '' });
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(blank()); setErrors({}); setBusy(false); } }, [open]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  async function save() {
    const errs = validateAdjustForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await window.api.leave.adjust({ employeeId: employee.id, leaveTypeId: form.leaveTypeId, days: Number(form.days), date: form.date || undefined, note: form.note.trim() });
      addToast(`Balance is now ${fmtDays(res?.balance)} day(s).`, 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  const tracked = (types || []).filter((t) => t.tracksBalance && !t.archived);
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`Adjust ${personName(employee)}'s leave balance`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Adjust balance'}</Button></>}
    >
      <p className="fuel-modal-text">For an opening balance (leave earned before the app) or a correction. Kept in the ledger with your note.</p>
      <div className="form-grid">
        <Field label="Kind of leave" required error={errors.leaveTypeId}>
          {({ id }) => (
            <Select id={id} value={form.leaveTypeId} invalid={!!errors.leaveTypeId} onChange={(e) => set('leaveTypeId')(e.target.value)}>
              <option value="">Choose…</option>
              {tracked.map((t) => <option key={t.id} value={t.id}>{leaveTypeName(t)}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Days" required error={errors.days} hint="Use a minus to take days away, e.g. -1.5.">
          {({ id }) => <Input id={id} inputMode="decimal" value={form.days} invalid={!!errors.days} onChange={(e) => set('days')(e.target.value)} />}
        </Field>
        <Field label="Dated" error={errors.date}>
          {({ id }) => <Input id={id} type="date" value={form.date} invalid={!!errors.date} onChange={(e) => set('date')(e.target.value)} />}
        </Field>
        <Field label="Note" required span="full" error={errors.note}>
          {({ id }) => <Input id={id} value={form.note} invalid={!!errors.note} placeholder="e.g. Opening balance on 1 Oct 2026" onChange={(e) => set('note')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Approve / reject / cancel for one request. `onDone` after a change.
 * Returns the dialogs and an `act(kind, request)` starter.
 */
export function useLeaveDecisions(onDone) {
  const addToast = useAppStore((s) => s.addToast);
  const [rejecting, setRejecting] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [busyId, setBusyId] = useState(null);

  async function approve(r) {
    setBusyId(r.id);
    try {
      await window.api.leave.decide(r.id, 'approve');
      addToast('Leave approved.', 'success');
      onDone?.();
    } catch (err) {
      const question = negativeBalanceQuestion(err?.message);
      if (!question) { addToast(errText(err), 'error'); return; }
      const ok = await confirm({ title: 'Not enough leave', message: question, confirmLabel: 'Approve anyway' });
      if (ok) {
        try { await window.api.leave.decide(r.id, 'approve', undefined, true); addToast('Leave approved; the balance is below zero.', 'success'); onDone?.(); }
        catch (err2) { addToast(errText(err2), 'error'); }
      }
    } finally { setBusyId(null); }
  }

  const dialogs = (
    <>
      <ReasonModal
        open={!!rejecting}
        title="Reject this leave request?"
        message="Say why — the person sees it on the kiosk or their phone."
        label="Note"
        confirmLabel="Reject request"
        danger
        onCancel={() => setRejecting(null)}
        onConfirm={async (note) => {
          await window.api.leave.decide(rejecting.id, 'reject', note);
          addToast('Request rejected.', 'success');
          setRejecting(null);
          onDone?.();
        }}
      />
      <ReasonModal
        open={!!cancelling}
        title="Cancel this leave?"
        message={cancelling?.status === 'approved' ? 'The days go back to their balance. Kept in the ledger with your reason.' : 'The request is withdrawn.'}
        confirmLabel="Cancel leave"
        cancelLabel="Keep it"
        danger
        onCancel={() => setCancelling(null)}
        onConfirm={async (reason) => {
          await window.api.leave.cancel(cancelling.id, reason);
          addToast('Leave cancelled.', 'success');
          setCancelling(null);
          onDone?.();
        }}
      />
    </>
  );
  return { approve, reject: setRejecting, cancel: setCancelling, busyId, dialogs };
}

export function LedgerTable({ rows, types }) {
  if (!rows?.length) return <p className="muted">No ledger entries yet. Leave is earned at the end of each month worked.</p>;
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr><th>Date</th><th>Kind of leave</th><th>Entry</th><th className="is-num">Days</th><th>Note</th></tr></thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={l.id || `${l.date}-${i}`}>
              <td className="hr-nowrap">{fmtWorkDate(l.date, { year: true })}</td>
              <td>{leaveTypeName(types?.get?.(l.leaveTypeId))}</td>
              <td>{LEDGER_KINDS[l.kind] || l.kind}{l.period ? <span className="muted"> · {l.period}</span> : null}</td>
              <td className="is-num">{l.days > 0 ? <Badge tone="emerald">+{fmtDays(l.days)}</Badge> : <Badge tone="slate">{fmtDays(l.days)}</Badge>}</td>
              <td className="hr-cell-text">{l.note || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
