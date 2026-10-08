/**
 * Staff — the thin staff list Fuel F1 needs (docs/PEOPLE_AND_FUEL_PLAN.md
 * §3.1): code, names in English and Khmer, photo, position, phone, driver and
 * pump-attendant flags, status, and the optional app account (a phone
 * account linked here makes that person the default driver / attendant).
 * Nobody is deleted: someone who leaves is marked "Left" and keeps every
 * record that names them. HR1 extends this screen.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Pagination, Select, Textarea, cx, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useFuelCaps, useFuelTick } from '../Fuel/fuelHooks.js';
import { ManageOnlyNote, StaffAvatar } from '../Fuel/FuelShared.jsx';
import { errText, ppDateKey, validateStaffForm } from '../Fuel/fuelModel.js';

const STATUS_VIEWS = [{ value: 'active', label: 'Working' }, { value: 'left', label: 'Left' }, { value: 'all', label: 'All' }];

export function Staff() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canManage } = useFuelCaps();
  const tick = useFuelTick(['staff']);
  const [status, setStatus] = useState('active');
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => { setPage(0); }, [status, role, q, pageSize, activeCompanyId]);
  useEffect(() => { setRows([]); setEditing(null); }, [activeCompanyId]); // L4
  useEffect(() => {
    if (!activeCompanyId || !canManage) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      window.api.staff.list({ status: status === 'all' ? undefined : status, role: role || undefined, q: q.trim() || undefined })
        .then((list) => { if (alive) setRows(list || []); })
        .catch((err) => { if (alive) { setRows([]); addToast(`Couldn't load staff: ${errText(err)}`, 'error'); } })
        .finally(() => { if (alive) setLoading(false); });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [activeCompanyId, canManage, status, role, q, tick, addToast]);

  const { currentPage, maxPage, pageStart, pageEnd } = paginate(rows.length, page, pageSize);

  if (!activeCompanyId) return <div className="page"><PageHeader title="Staff" /><NoCompanyState purpose="list its staff" /></div>;
  if (!canManage) return <div className="page"><PageHeader title="Staff" /><ManageOnlyNote /></div>;

  return (
    <div className="page page--staff">
      <PageHeader
        title="Staff"
        subtitle="The people who drive, pump and dip. Nobody is deleted — mark someone as left instead."
        actions={<Button variant="primary" onClick={() => setEditing('new')}>+ New staff member</Button>}
      />
      <div className="toolbar">
        <div className="search-wrap">
          <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input type="search" className="search-input" placeholder="Search name, code or phone…" aria-label="Search staff" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">Everyone</option>
          <option value="driver">Drivers</option>
          <option value="attendant">Pump attendants</option>
        </Select>
        <span className="toolbar__count">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="Status">
          {STATUS_VIEWS.map((v) => <button key={v.value} type="button" className={`segment${status === v.value ? ' is-active' : ''}`} onClick={() => setStatus(v.value)}>{v.label}</button>)}
        </div>
      </div>

      {loading && !rows.length ? <p className="muted">Loading…</p> : rows.length === 0 ? (
        <EmptyState
          title={q || role ? 'Nobody matches' : status === 'left' ? 'Nobody has left' : 'No staff yet'}
          body={q || role ? 'Try a shorter search or another role.' : status === 'left' ? 'People marked as left are listed here with their history.' : 'Add the drivers and pump attendants first — fill-ups and dips name them.'}
          action={!q && !role && status !== 'left' ? <Button variant="primary" onClick={() => setEditing('new')}>+ New staff member</Button> : null}
        />
      ) : (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Photo</th><th>Name</th><th>Code</th><th>Position</th><th>Phone</th><th>Does</th><th>Status</th></tr></thead>
              <tbody>
                {rows.slice(pageStart, pageEnd).map((e) => (
                  <tr key={e.id} className={cx('is-clickable', e.status === 'left' && 'is-muted')} onClick={() => setEditing(e)}>
                    <td><StaffAvatar employee={e} size={36} /></td>
                    <td><strong>{e.nameEn || e.nameKm || '—'}</strong>{e.nameEn && e.nameKm ? <div className="muted">{e.nameKm}</div> : null}</td>
                    <td><code>{e.staffCode}</code></td>
                    <td>{e.position || <span className="muted">—</span>}</td>
                    <td>{e.phone || <span className="muted">—</span>}</td>
                    <td>
                      {/* The flex row lives in a div: `display: flex` on the td
                          itself took it out of the table and broke the row lines. */}
                      <div className="fuel-badges">
                        {e.isDriver ? <Badge tone="blue">Driver</Badge> : null}
                        {e.isFuelAttendant ? <Badge tone="blue">Pump attendant</Badge> : null}
                        {e.userId ? <Badge tone="slate">Phone account</Badge> : null}
                        {!e.isDriver && !e.isFuelAttendant && !e.userId ? <span className="muted">—</span> : null}
                      </div>
                    </td>
                    <td>{e.status === 'left' ? <Badge tone="slate">Left {e.leftOn || ''}</Badge> : <Badge tone="emerald">Working</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={rows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      )}

      <StaffEditorModal open={editing !== null} employee={editing === 'new' ? null : editing} onSaved={setEditing} onClose={() => setEditing(null)} />
    </div>
  );
}

function staffForm(e) {
  return {
    staffCode: e?.staffCode || '', nameEn: e?.nameEn || '', nameKm: e?.nameKm || '', phone: e?.phone || '',
    position: e?.position || '', isDriver: !!e?.isDriver, isFuelAttendant: !!e?.isFuelAttendant,
    userId: e?.userId || '', notes: e?.notes || '',
  };
}

function StaffEditorModal({ open, employee, onSaved, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState(staffForm(null));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [users, setUsers] = useState([]);
  const [leaving, setLeaving] = useState(false);
  // L2: saved, but the photo failed — keep editing that record (no duplicate on Save).
  const keepDraftFor = useRef(null);
  useEffect(() => {
    if (!open) { keepDraftFor.current = null; return; }
    if (employee?.id && employee.id === keepDraftFor.current) return;
    setForm(staffForm(employee)); setErrors({}); setBusy(false); setPhoto(null); setLeaving(false);
    window.api.users?.listForAttribution?.().then((u) => setUsers(Array.isArray(u) ? u : [])).catch(() => setUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee?.id]);
  useEffect(() => () => { if (photo?.url) URL.revokeObjectURL(photo.url); }, [photo]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };

  async function save() {
    const errs = validateStaffForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input = {
      staffCode: form.staffCode.trim(), nameEn: form.nameEn.trim() || null, nameKm: form.nameKm.trim() || null,
      phone: form.phone.trim() || null, position: form.position.trim() || null,
      isDriver: form.isDriver, isFuelAttendant: form.isFuelAttendant, userId: form.userId || null, notes: form.notes.trim() || null,
    };
    setBusy(true);
    try {
      const saved = employee
        ? await window.api.staff.update(employee.id, { ...input, expectedUpdatedAt: employee.updatedAt })
        : await window.api.staff.create(input);
      if (photo?.file) {
        try {
          await window.api.staff.setPhoto(saved.id, await photo.file.arrayBuffer());
        } catch (photoErr) {
          keepDraftFor.current = saved.id;
          onSaved?.(saved);
          addToast(`Saved, but the photo did not upload: ${errText(photoErr)} Press Save to try the photo again.`, 'error');
          setBusy(false);
          return;
        }
      }
      addToast(employee ? 'Saved.' : `Added ${saved.nameEn || saved.nameKm || saved.staffCode}.`, 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  async function reactivate() {
    setBusy(true);
    try { await window.api.staff.reactivate(employee.id); addToast('Back at work.', 'success'); onClose(); }
    catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }

  return (
    <>
      <Modal
        open={open && !leaving}
        onClose={onClose}
        busy={busy}
        size="lg"
        title={employee ? `Edit ${employee.nameEn || employee.nameKm || employee.staffCode}` : 'New staff member'}
        footer={(
          <>
            {employee && employee.status !== 'left' ? <Button variant="ghost" onClick={() => setLeaving(true)} disabled={busy}>Mark as left…</Button> : null}
            {employee && employee.status === 'left' ? <Button variant="ghost" onClick={reactivate} disabled={busy}>Back at work</Button> : null}
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </>
        )}
      >
        {employee?.status === 'left' ? <p className="fuel-modal-text">Left on {employee.leftOn}{employee.leftReason ? ` — ${employee.leftReason}` : ''}.</p> : null}
        <div className="form-grid">
          <Field label="Name (English)" error={errors.nameEn}>
            {({ id }) => <Input id={id} autoFocus value={form.nameEn} invalid={!!errors.nameEn} onChange={(e) => set('nameEn')(e.target.value)} />}
          </Field>
          <Field label="Name (Khmer)">
            {({ id }) => <Input id={id} value={form.nameKm} lang="km" onChange={(e) => set('nameKm')(e.target.value)} />}
          </Field>
          <Field label="Staff code" required error={errors.staffCode} hint="Short and unique, e.g. D01.">
            {({ id }) => <Input id={id} value={form.staffCode} invalid={!!errors.staffCode} onChange={(e) => set('staffCode')(e.target.value)} />}
          </Field>
          <Field label="Position">
            {({ id }) => <Input id={id} value={form.position} onChange={(e) => set('position')(e.target.value)} placeholder="e.g. Truck driver" />}
          </Field>
          <Field label="Phone">
            {({ id }) => <Input id={id} type="tel" value={form.phone} onChange={(e) => set('phone')(e.target.value)} />}
          </Field>
          <Field label="Phone app account" hint="Links this person to an account, so their phone fills in their name.">
            {({ id }) => (
              <Select id={id} value={form.userId} onChange={(e) => set('userId')(e.target.value)}>
                <option value="">None</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                {form.userId && !users.some((u) => u.id === form.userId) ? <option value={form.userId}>Linked account</option> : null}
              </Select>
            )}
          </Field>
          <label className="fuel-check">
            <input type="checkbox" checked={form.isDriver} onChange={(e) => set('isDriver')(e.target.checked)} />
            <span>Drives a vehicle or machine</span>
          </label>
          <label className="fuel-check">
            <input type="checkbox" checked={form.isFuelAttendant} onChange={(e) => set('isFuelAttendant')(e.target.checked)} />
            <span>Pump attendant (gives fuel, dips tanks)</span>
          </label>
          <Field label="Photo" span="full" hint="Shown on the phone so the attendant taps the right person.">
            {() => (
              <div className="fuel-inline">
                {photo?.url ? <img className="fuel-photo-preview" src={photo.url} alt="New photo" /> : employee ? <StaffAvatar employee={employee} size={64} /> : <span className="muted">No photo yet</span>}
                <label className="btn btn--sm">
                  {employee?.hasPhoto || photo ? 'Change photo…' : 'Add photo…'}
                  <input type="file" accept="image/*" hidden onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    if (photo?.url) URL.revokeObjectURL(photo.url);
                    setPhoto({ file, url: URL.createObjectURL(file) });
                  }} />
                </label>
              </div>
            )}
          </Field>
          <Field label="Notes" span="full">
            {({ id }) => <Textarea id={id} rows={2} value={form.notes} onChange={(e) => set('notes')(e.target.value)} />}
          </Field>
        </div>
      </Modal>
      <MarkLeftModal open={open && leaving} employee={employee} onCancel={() => setLeaving(false)} onDone={onClose} />
    </>
  );
}

function MarkLeftModal({ open, employee, onCancel, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const [leftOn, setLeftOn] = useState(ppDateKey());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const name = useMemo(() => employee?.nameEn || employee?.nameKm || employee?.staffCode || '', [employee]);
  useEffect(() => { if (open) { setLeftOn(ppDateKey()); setReason(''); setBusy(false); } }, [open]);
  async function save() {
    setBusy(true);
    try {
      await window.api.staff.markLeft(employee.id, leftOn, reason.trim() || null);
      addToast(`${name} is marked as left. Their records stay.`, 'success');
      onDone();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onCancel}
      busy={busy}
      closeOnBackdrop={false}
      title={`Mark ${name} as left?`}
      footer={<><Button onClick={onCancel} disabled={busy}>Keep working</Button><Button variant="danger" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Mark as left'}</Button></>}
    >
      <p className="fuel-modal-text">They drop off the phone's lists. Every fill-up and dip that names them stays, and they can be brought back later.</p>
      <div className="form-grid">
        <Field label="Last day">
          {({ id }) => <Input id={id} type="date" value={leftOn} onChange={(e) => setLeftOn(e.target.value)} />}
        </Field>
        <Field label="Reason">
          {({ id }) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
