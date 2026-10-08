/**
 * HR1 positions (docs/PEOPLE_AND_FUEL_PLAN.md §3.1): the company's list of
 * job titles in English and Khmer, with a department. Chosen on a staff
 * profile. Never deleted — a position no longer used is archived (hidden from
 * the picker; people who hold it keep it).
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, Field, Input, Modal } from '../../components/ui.jsx';
import { useHrTick } from '../People/hrHooks.js';
import { errText } from '../People/hrModel.js';

const blank = { nameEn: '', nameKm: '', department: '' };

export function PositionsModal({ open, onClose }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useHrTick(['position']);
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | position
  const [form, setForm] = useState(blank);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open || !activeCompanyId) return undefined;
    let alive = true;
    window.api.hr.listPositions({ includeArchived: true })
      .then((p) => { if (alive) setList(p || []); })
      .catch((err) => { if (alive) addToast(errText(err), 'error'); });
    return () => { alive = false; };
  }, [open, activeCompanyId, tick, retry, addToast]);
  useEffect(() => { if (!open) setEditing(null); }, [open]);

  function startEdit(p) {
    setEditing(p);
    setForm(p === 'new' ? blank : { nameEn: p.nameEn || '', nameKm: p.nameKm || '', department: p.department || '' });
    setError(null);
  }
  async function save() {
    if (!form.nameEn.trim() && !form.nameKm.trim()) { setError('Give the position a name in English or Khmer'); return; }
    setBusy(true);
    const input = { nameEn: form.nameEn.trim() || null, nameKm: form.nameKm.trim() || null, department: form.department.trim() || null };
    try {
      if (editing === 'new') await window.api.hr.createPosition(input);
      else await window.api.hr.updatePosition(editing.id, input);
      addToast('Position saved.', 'success');
      setEditing(null);
      setRetry((n) => n + 1);
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  async function toggleArchived(p) {
    try {
      await window.api.hr.updatePosition(p.id, { archived: !p.archived });
      addToast(p.archived ? `${p.nameEn || p.nameKm} is offered again.` : `${p.nameEn || p.nameKm} is hidden from the picker.`, 'success');
      setRetry((n) => n + 1);
    } catch (err) { addToast(errText(err), 'error'); }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title="Positions"
      footer={editing ? (
        <>
          <Button onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : editing === 'new' ? 'Add position' : 'Save'}</Button>
        </>
      ) : <Button variant="primary" onClick={() => startEdit('new')}>+ New position</Button>}
    >
      {editing ? (
        <div className="form-grid">
          <Field label="Name (English)" error={error}>
            {({ id }) => <Input id={id} autoFocus value={form.nameEn} onChange={(e) => setForm((f) => ({ ...f, nameEn: e.target.value }))} />}
          </Field>
          <Field label="Name (Khmer)">
            {({ id }) => <Input id={id} lang="km" value={form.nameKm} onChange={(e) => setForm((f) => ({ ...f, nameKm: e.target.value }))} />}
          </Field>
          <Field label="Department" hint="Optional, e.g. Transport, Shop, Farm.">
            {({ id }) => <Input id={id} value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />}
          </Field>
        </div>
      ) : list.length === 0 ? <p className="muted">No positions yet. Add the job titles people hold, e.g. Truck driver, Cashier.</p> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Position</th><th>Department</th><th /><th className="is-actions" /></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={p.archived ? 'is-muted' : ''}>
                  <td><strong>{p.nameEn || p.nameKm}</strong>{p.nameEn && p.nameKm ? <span className="muted" lang="km"> · {p.nameKm}</span> : null}</td>
                  <td>{p.department || <span className="muted">—</span>}</td>
                  <td>{p.archived ? <Badge tone="slate">Hidden</Badge> : null}</td>
                  <td className="is-actions">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(p)}>Edit…</Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleArchived(p)}>{p.archived ? 'Show again' : 'Hide'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
