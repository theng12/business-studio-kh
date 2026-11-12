/**
 * Settings → Branches (system.manage; docs/ASSETS_AND_BRANCHES_PLAN.md §3.1):
 * the company's locations — assets, staff and tanks are given one. Create,
 * edit, close (refused while assets are still there; history is kept) and
 * reopen. Nothing is ever guessed: "Suggested from Fuel" lists the free-text
 * home locations of Fuel vehicles, and each one is created only by hand.
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Textarea, cx } from '../../components/ui.jsx';
import { ReasonModal } from '../Fuel/FuelShared.jsx';
import { useAssetCaps, useAssetsTick } from './assetsHooks.js';
import { Notice, StaffPicker } from './AssetsShared.jsx';
import { errText } from './assetsModel.js';

/** "Siem Reap shop" → "SRS" (a starting point the user edits). */
export function suggestCode(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const code = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] || '').slice(0, 3)).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return code.slice(0, 6);
}

export function BranchesPanel() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useAssetCaps();
  const tick = useAssetsTick(['branch']);
  const [branches, setBranches] = useState(null);
  const [staff, setStaff] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [editing, setEditing] = useState(null); // null | { branch?, prefill? }
  const [closing, setClosing] = useState(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => { setBranches(null); setSuggestions([]); }, [activeCompanyId]);
  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let alive = true;
    Promise.all([
      window.api.branches.list({ status: 'all' }),
      window.api.staff.list({}).catch(() => []),
      caps.canBranches ? window.api.branches.suggestFromFuel().catch(() => []) : Promise.resolve([]),
    ]).then(([b, s, sug]) => { if (alive) { setBranches(b || []); setStaff(Array.isArray(s) ? s : []); setSuggestions(sug || []); } })
      .catch((err) => { if (alive) addToast(errText(err), 'error'); });
    return () => { alive = false; };
  }, [activeCompanyId, tick, retry, caps.canBranches, addToast]);

  if (!activeCompanyId) return <div className="settings-page"><h2 className="section-title">Branches</h2><p className="muted">Choose a company first — branches belong to a company.</p></div>;
  const names = new Set((branches || []).map((b) => b.nameEn.toLowerCase()));
  const open = suggestions.filter((s) => !names.has(String(s.text).toLowerCase()));
  async function reopen(b) {
    try { await window.api.branches.update(b.id, { status: 'active' }); addToast(`${b.nameEn} reopened`, 'success'); setRetry((n) => n + 1); }
    catch (err) { addToast(errText(err), 'error'); }
  }

  return (
    <div className="settings-page assets-settings">
      <div className="section-head">
        <h2 className="section-title">Branches</h2>
        <span className="section-hint">Locations inside this company. Assets, staff and fuel tanks can be given one; every asset report can be filtered by branch.</span>
        {caps.canBranches ? <div className="section-head__actions"><Button variant="primary" onClick={() => setEditing({})}>+ New branch</Button></div> : null}
      </div>
      {!caps.canBranches ? <p className="muted">Adding or changing branches needs the “Manage system” permission.</p> : null}
      {!branches ? <p className="muted">Loading…</p> : !branches.length ? (
        <EmptyState title="No branches yet" body="Add the head office and each shop, farm or workshop." action={caps.canBranches ? <Button onClick={() => setEditing({})}>+ New branch</Button> : null} />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Code</th><th>Name</th><th>Khmer name</th><th>Phone</th><th className="is-num">Assets</th><th>Status</th>{caps.canBranches ? <th className="is-actions" aria-label="Actions" /> : null}</tr></thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.id} className={cx(b.status === 'closed' && 'is-muted')}>
                  <td><strong>{b.code}</strong></td>
                  <td>{b.nameEn}{b.isHeadOffice ? <> <Badge tone="blue">Head office</Badge></> : null}{b.address ? <div className="muted">{b.address}</div> : null}</td>
                  <td>{b.nameKm || ''}</td>
                  <td>{b.phone || ''}</td>
                  <td className="is-num">{b.assetCount ?? 0}</td>
                  <td>{b.status === 'closed' ? <><Badge tone="slate">Closed</Badge>{b.closedReason ? <div className="muted">{b.closedReason}</div> : null}</> : <Badge tone="emerald">Open</Badge>}</td>
                  {caps.canBranches ? (
                    <td className="is-actions">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ branch: b })}>Edit…</Button>
                      {b.status === 'closed'
                        ? <Button size="sm" variant="ghost" onClick={() => reopen(b)}>Reopen</Button>
                        : <Button size="sm" variant="ghost" onClick={() => setClosing(b)} disabled={(b.assetCount ?? 0) > 0} title={(b.assetCount ?? 0) > 0 ? 'Transfer its assets to another branch first' : undefined}>Close…</Button>}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {caps.canBranches && open.length ? (
        <section className="assets-section">
          <h3 className="section-title">Suggested from Fuel</h3>
          <p className="muted">Where Fuel's vehicles are kept (their "home location" text). Nothing is created until you add it; vehicles are not moved into it.</p>
          <ul className="assets-suggest">
            {open.map((s) => (
              <li key={s.text}>
                <span><strong>{s.text}</strong> <span className="muted">· {s.vehicles} vehicle{s.vehicles === 1 ? '' : 's'}</span></span>
                <Button size="sm" onClick={() => setEditing({ prefill: { nameEn: s.text, code: suggestCode(s.text) } })}>Add as a branch…</Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {editing ? (
        <BranchModal branch={editing.branch} prefill={editing.prefill} staff={staff} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); addToast(msg, 'success'); setRetry((n) => n + 1); }} />
      ) : null}
      <ReasonModal
        open={!!closing}
        title={`Close ${closing?.nameEn || 'branch'}?`}
        message="A closed branch keeps its history but cannot receive new assets or staff. It can be reopened."
        confirmLabel="Close branch"
        onCancel={() => setClosing(null)}
        onConfirm={async (reason) => { await window.api.branches.close(closing.id, reason); addToast(`${closing.nameEn} closed`, 'success'); setClosing(null); setRetry((n) => n + 1); }}
      />
    </div>
  );
}

function BranchModal({ branch, prefill, staff, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    code: branch?.code || prefill?.code || '', nameEn: branch?.nameEn || prefill?.nameEn || '', nameKm: branch?.nameKm || '',
    address: branch?.address || '', phone: branch?.phone || '', managerEmployeeId: branch?.managerEmployeeId || '',
    isHeadOffice: !!branch?.isHeadOffice, notes: branch?.notes || '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  async function save() {
    if (!form.code.trim()) { setError('A short code is required, like PP1'); return; }
    if (!form.nameEn.trim()) { setError('A name is required'); return; }
    const input = {
      code: form.code.trim(), nameEn: form.nameEn.trim(), nameKm: form.nameKm.trim() || null, address: form.address.trim() || null,
      phone: form.phone.trim() || null, managerEmployeeId: form.managerEmployeeId || null, isHeadOffice: form.isHeadOffice, notes: form.notes.trim() || null,
    };
    setBusy(true); setError('');
    try {
      if (branch) await window.api.branches.update(branch.id, input);
      else await window.api.branches.create(input);
      onSaved(`${input.nameEn} saved`);
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={branch ? `Edit ${branch.nameEn}` : 'New branch'} busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save branch'}</Button></>}>
      {error ? <Notice tone="rose">{error}</Notice> : null}
      <div className="form-grid assets-form">
        <Field label="Code" required hint="Short and unique, e.g. PP1 — shown in lists.">{({ id }) => <Input id={id} value={form.code} maxLength={12} onChange={(e) => set('code')(e.target.value.toUpperCase())} autoFocus />}</Field>
        <Field label="Name" required>{({ id }) => <Input id={id} value={form.nameEn} onChange={(e) => set('nameEn')(e.target.value)} />}</Field>
        <Field label="Khmer name">{({ id }) => <Input id={id} value={form.nameKm} onChange={(e) => set('nameKm')(e.target.value)} />}</Field>
        <Field label="Phone">{({ id }) => <Input id={id} value={form.phone} onChange={(e) => set('phone')(e.target.value)} />}</Field>
        <Field label="Address" span="full">{({ id }) => <Input id={id} value={form.address} onChange={(e) => set('address')(e.target.value)} />}</Field>
        <Field label="Manager">{({ id }) => <StaffPicker id={id} staff={staff} value={form.managerEmployeeId} onChange={set('managerEmployeeId')} noneLabel="—" />}</Field>
        <label className="assets-check"><input type="checkbox" checked={form.isHeadOffice} onChange={(e) => set('isHeadOffice')(e.target.checked)} /><span>Head office (one per company)</span></label>
        <Field label="Notes" span="full">{({ id }) => <Textarea id={id} rows={2} value={form.notes} onChange={(e) => set('notes')(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}
