/**
 * Fuel F1 — Vehicles & machines: the list, the editor (type incl. custom
 * types, plate/name, photo, meter unit, tank size, normal use, assigned
 * driver, active) and the meter-reset record (a replaced odometer is not
 * "going backwards").
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Pagination, Select, Textarea, cx, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useFuelCaps, useFuelIntent, useFuelLookups, useFuelTick } from './fuelHooks.js';
import { FuelPhotoThumb, PhotoViewer, ReasonModal, StaffSelect } from './FuelShared.jsx';
import {
  FUEL_TYPES, METER_UNITS, fmtLitres, fmtNumber, fmtWhen, fuelTypeLabel, meterWord, parseNumber, parsePpInput,
  ppInputValue, rateUnit, staffName, validateAssetForm, errText,
} from './fuelModel.js';

const STATUS_VIEWS = [{ value: 'active', label: 'Active' }, { value: 'retired', label: 'Retired' }, { value: 'all', label: 'All' }];

export function FuelAssets() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canManage } = useFuelCaps();
  const lookups = useFuelLookups({ includeRetired: true });
  const tick = useFuelTick(['asset', 'assetType', 'staff', 'meterReset']);
  const intent = useFuelIntent('fuelassets');
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const [typeId, setTypeId] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | 'new' | asset
  const [viewPhoto, setViewPhoto] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => { if (intent?.add && canManage) setEditing('new'); }, [intent, canManage]);
  useEffect(() => { setPage(0); }, [status, q, typeId, pageSize, activeCompanyId]);

  useEffect(() => { setRows([]); setTypeId(''); setEditing(null); }, [activeCompanyId]); // L4
  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      window.api.fuel.listAssets({ status, q: q.trim() || undefined })
        .then((list) => { if (alive) setRows(list || []); })
        .catch((err) => { if (alive) { setRows([]); addToast(`Couldn't load vehicles: ${errText(err)}`, 'error'); } })
        .finally(() => { if (alive) setLoading(false); });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [activeCompanyId, status, q, tick, addToast]);

  const filtered = useMemo(() => (typeId ? rows.filter((a) => a.typeId === typeId) : rows), [rows, typeId]);
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(filtered.length, page, pageSize);
  const visible = filtered.slice(pageStart, pageEnd);

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Vehicles & machines" /><NoCompanyState purpose="list its vehicles and machines" /></div>;
  }

  return (
    <div className="page page--fuel">
      <PageHeader
        title="Vehicles & machines"
        subtitle="Everything that takes fuel: trucks, motorbikes, generators, pumps…"
        actions={canManage ? <Button variant="primary" onClick={() => setEditing('new')}>+ New vehicle or machine</Button> : null}
      />
      <div className="toolbar">
        <div className="search-wrap">
          <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input type="search" className="search-input" placeholder="Search name or plate…" aria-label="Search vehicles" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select aria-label="Filter by type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          <option value="">All types</option>
          {lookups.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <span className="toolbar__count">{filtered.length} shown</span>
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="Status">
          {STATUS_VIEWS.map((v) => (
            <button key={v.value} type="button" className={`segment${status === v.value ? ' is-active' : ''}`} onClick={() => setStatus(v.value)}>{v.label}</button>
          ))}
        </div>
      </div>

      {loading && !rows.length ? <p className="muted">Loading…</p> : filtered.length === 0 ? (
        <EmptyState
          title={q || typeId ? 'Nothing matches' : status === 'retired' ? 'No retired vehicles' : 'No vehicles or machines yet'}
          body={q || typeId ? 'Try a shorter search or another type.' : status === 'retired' ? 'Vehicles you retire keep their history and are listed here.' : 'Add the first one so fill-ups can be recorded against it.'}
          action={!q && !typeId && status !== 'retired' && canManage ? <Button variant="primary" onClick={() => setEditing('new')}>+ New vehicle or machine</Button> : null}
        />
      ) : (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Photo</th><th>Name</th><th>Type</th><th>Fuel</th><th>Meter</th><th className="is-num">Tank</th><th className="is-num">Normal use</th><th>Driver</th><th>Status</th></tr>
              </thead>
              <tbody>
                {visible.map((a) => {
                  const driver = a.assignedEmployeeId ? lookups.maps.staff.get(a.assignedEmployeeId) : null;
                  return (
                    <tr key={a.id} className={cx(canManage && 'is-clickable', a.status === 'retired' && 'is-muted')} onClick={canManage ? () => setEditing(a) : undefined}>
                      <td onClick={(e) => e.stopPropagation()}>
                        {a.photoId ? <FuelPhotoThumb photo={{ id: a.photoId, kind: 'other' }} title={a.name} size={40} onOpen={() => setViewPhoto(a)} /> : <span className="fuel-thumb fuel-thumb--none" style={{ width: 40, height: 40 }} />}
                      </td>
                      <td><strong>{a.name}</strong>{a.plateOrSerial ? <div className="muted">{a.plateOrSerial}</div> : null}</td>
                      <td>{a.typeName || '—'}</td>
                      <td>{fuelTypeLabel(a.fuelType)}</td>
                      <td>{METER_UNITS.find((m) => m.value === a.meterUnit)?.label || a.meterUnit}</td>
                      <td className="is-num">{fmtLitres(a.tankCapacityL, 0)}</td>
                      <td className="is-num">
                        {a.baselineRate ? `${fmtNumber(a.baselineRate, 2)} ${rateUnit(a.meterUnit)}` : '—'}
                        {a.baselineSource === 'learned' ? <div className="muted">learned from fills</div> : null}
                      </td>
                      <td>{driver ? staffName(driver) : <span className="muted">—</span>}</td>
                      <td>{a.status === 'retired' ? <Badge tone="slate">Retired</Badge> : <Badge tone="emerald">Active</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination total={filtered.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      )}

      <AssetEditorModal
        open={editing !== null}
        asset={editing === 'new' ? null : editing}
        lookups={lookups}
        onSaved={setEditing}
        onClose={() => setEditing(null)}
      />
      <PhotoViewer
        open={!!viewPhoto}
        photos={viewPhoto ? [{ id: viewPhoto.photoId, kind: 'other', uploadedAt: viewPhoto.updatedAt }] : []}
        title={viewPhoto?.name || 'Photo'}
        onClose={() => setViewPhoto(null)}
      />
    </div>
  );
}

function assetForm(a, types) {
  const t = a ? null : types.find((x) => !x.archived);
  return {
    typeId: a?.typeId || t?.id || '',
    name: a?.name || '',
    plateOrSerial: a?.plateOrSerial || '',
    fuelType: a?.fuelType || t?.defaultFuel || 'diesel',
    meterUnit: a?.meterUnit || t?.meterUnit || 'km',
    tankCapacityL: a?.tankCapacityL != null ? String(a.tankCapacityL) : '',
    baselineRate: a?.baselineRate != null ? String(a.baselineRate) : '',
    baselineSource: a?.baselineSource || 'manual',
    assignedEmployeeId: a?.assignedEmployeeId || '',
    homeLocation: a?.homeLocation || '',
    notes: a?.notes || '',
    active: a ? a.status !== 'retired' : true,
  };
}

function AssetEditorModal({ open, asset, lookups, onSaved, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState(() => assetForm(null, []));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(null); // { file, url }
  const [typeOpen, setTypeOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  // L2: the record that was just saved while its photo failed. The dialog
  // switches to editing it (so Save cannot create a second one) and keeps
  // the typed fields and the picked photo, so Save simply retries the photo.
  const keepDraftFor = useRef(null);

  useEffect(() => {
    if (!open) { keepDraftFor.current = null; return; }
    if (asset?.id && asset.id === keepDraftFor.current) return;
    setForm(assetForm(asset, lookups.types));
    setErrors({});
    setBusy(false);
    setPhoto(null);
    // Only when the dialog opens or switches record — not on every lookup refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset?.id]);
  useEffect(() => () => { if (photo?.url) URL.revokeObjectURL(photo.url); }, [photo]);

  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  function pickType(id) {
    const t = lookups.maps.types.get(id);
    setForm((f) => ({
      ...f,
      typeId: id,
      // A new record follows its type's meter and fuel; an existing one keeps its own.
      ...(asset || !t ? {} : { meterUnit: t.meterUnit, fuelType: t.defaultFuel }),
    }));
  }

  async function save() {
    const errs = validateAssetForm(form);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const input = {
      typeId: form.typeId,
      name: form.name.trim(),
      plateOrSerial: form.plateOrSerial.trim() || null,
      fuelType: form.fuelType,
      meterUnit: form.meterUnit,
      tankCapacityL: parseNumber(form.tankCapacityL),
      baselineRate: parseNumber(form.baselineRate),
      baselineSource: form.baselineSource,
      assignedEmployeeId: form.assignedEmployeeId || null,
      homeLocation: form.homeLocation.trim() || null,
      notes: form.notes.trim() || null,
    };
    setBusy(true);
    try {
      let saved;
      if (asset) saved = await window.api.fuel.updateAsset(asset.id, { ...input, status: form.active ? 'active' : 'retired', expectedUpdatedAt: asset.updatedAt });
      else {
        saved = await window.api.fuel.createAsset(input);
        if (!form.active) saved = await window.api.fuel.updateAsset(saved.id, { status: 'retired' });
      }
      if (photo?.file) {
        try {
          await window.api.fuel.setAssetPhoto(saved.id, await photo.file.arrayBuffer());
        } catch (photoErr) {
          keepDraftFor.current = saved.id;
          onSaved?.(saved);
          addToast(`Saved ${saved.name}, but the photo did not upload: ${errText(photoErr)} Press Save to try the photo again.`, 'error');
          setBusy(false);
          return;
        }
      }
      addToast(asset ? `Saved ${saved.name}.` : `Added ${saved.name}.`, 'success');
      onClose();
    } catch (err) {
      addToast(errText(err), 'error');
      setBusy(false);
    }
  }

  const types = lookups.types.filter((t) => !t.archived || t.id === form.typeId);
  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        busy={busy}
        size="lg"
        title={asset ? `Edit ${asset.name}` : 'New vehicle or machine'}
        footer={(
          <>
            {asset ? <Button variant="ghost" onClick={() => setResetOpen(true)} disabled={busy || form.meterUnit === 'none'}>Record meter reset…</Button> : null}
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </>
        )}
      >
        <div className="form-grid">
          <Field label="Name" required error={errors.name} hint="What everyone calls it, e.g. Truck 3A.">
            {({ id }) => <Input id={id} value={form.name} autoFocus invalid={!!errors.name} onChange={(e) => set('name')(e.target.value)} />}
          </Field>
          <Field label="Plate or serial number">
            {({ id }) => <Input id={id} value={form.plateOrSerial} onChange={(e) => set('plateOrSerial')(e.target.value)} placeholder="e.g. 2A-1234" />}
          </Field>
          <Field label="Type" required error={errors.typeId}>
            {({ id }) => (
              <div className="fuel-inline">
                <Select id={id} value={form.typeId} invalid={!!errors.typeId} onChange={(e) => pickType(e.target.value)}>
                  <option value="">Choose…</option>
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.nameKm ? ` · ${t.nameKm}` : ''}{t.isBuiltin ? '' : ' (custom)'}</option>)}
                </Select>
                <Button size="sm" onClick={() => setTypeOpen(true)}>New type…</Button>
              </div>
            )}
          </Field>
          <Field label="Fuel">
            {({ id }) => (
              <Select id={id} value={form.fuelType} onChange={(e) => set('fuelType')(e.target.value)}>
                {FUEL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Meter" hint="What the driver photographs at each fill.">
            {({ id }) => (
              <Select id={id} value={form.meterUnit} onChange={(e) => set('meterUnit')(e.target.value)}>
                {METER_UNITS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Tank size (litres)" error={errors.tankCapacityL} hint="Used for “more than the tank holds”.">
            {({ id }) => <Input id={id} inputMode="decimal" value={form.tankCapacityL} invalid={!!errors.tankCapacityL} onChange={(e) => set('tankCapacityL')(e.target.value)} />}
          </Field>
          <Field label={`Normal use (${rateUnit(form.meterUnit)})`} error={errors.baselineRate} hint="Your figure until there are enough full-to-full fills to learn it.">
            {({ id }) => <Input id={id} inputMode="decimal" value={form.baselineRate} invalid={!!errors.baselineRate} onChange={(e) => set('baselineRate')(e.target.value)} />}
          </Field>
          <Field label="Normal use comes from">
            {({ id }) => (
              <Select id={id} value={form.baselineSource} onChange={(e) => set('baselineSource')(e.target.value)}>
                <option value="manual">My figure, then learned from fills</option>
                <option value="learned">Learned from fills only</option>
              </Select>
            )}
          </Field>
          <Field label="Usual driver">
            {({ id }) => <StaffSelect id={id} staff={lookups.staff} role="driver" value={form.assignedEmployeeId} onChange={set('assignedEmployeeId')} noneLabel="No usual driver" />}
          </Field>
          <Field label="Where it is kept">
            {({ id }) => <Input id={id} value={form.homeLocation} onChange={(e) => set('homeLocation')(e.target.value)} placeholder="e.g. Warehouse, Farm" />}
          </Field>
          <Field label="Photo" span="full" hint="So the pump attendant taps the right one on the phone.">
            {() => (
              <div className="fuel-inline">
                {photo?.url ? <img className="fuel-photo-preview" src={photo.url} alt="New photo" />
                  : asset?.photoId ? <FuelPhotoThumb photo={{ id: asset.photoId, kind: 'other' }} title={asset.name} size={64} /> : <span className="muted">No photo yet</span>}
                <label className="btn btn--sm">
                  {asset?.photoId || photo ? 'Change photo…' : 'Add photo…'}
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
          <label className="fuel-check field--full">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active')(e.target.checked)} />
            <span>Active — untick when it is sold or scrapped (its history stays).</span>
          </label>
        </div>
      </Modal>
      <AssetTypeModal open={typeOpen} onClose={() => setTypeOpen(false)} onCreated={(t) => { lookups.reload(); setForm((f) => ({ ...f, typeId: t.id, meterUnit: t.meterUnit, fuelType: t.defaultFuel })); }} />
      <MeterResetModal open={resetOpen} asset={asset} onClose={() => setResetOpen(false)} />
    </>
  );
}

export function AssetTypeModal({ open, type, onClose, onCreated }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState({ name: '', nameKm: '', meterUnit: 'hours', defaultFuel: 'diesel', maxPerDay: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm({
      name: type?.name || '', nameKm: type?.nameKm || '', meterUnit: type?.meterUnit || 'hours',
      defaultFuel: type?.defaultFuel || 'diesel', maxPerDay: type?.maxPerDay != null ? String(type.maxPerDay) : '',
    });
    setError(''); setBusy(false);
  }, [open, type]);
  async function save() {
    if (!form.name.trim()) { setError('Give the type a name'); return; }
    const max = parseNumber(form.maxPerDay);
    if (max != null && (Number.isNaN(max) || max <= 0)) { setError('Most per day must be a number more than 0'); return; }
    setBusy(true);
    try {
      const input = { name: form.name.trim(), nameKm: form.nameKm.trim() || null, meterUnit: form.meterUnit, defaultFuel: form.defaultFuel, maxPerDay: max };
      const saved = type ? await window.api.fuel.updateAssetType(type.id, input) : await window.api.fuel.createAssetType(input);
      addToast(type ? `Saved ${saved.name}.` : `Added the type ${saved.name}.`, 'success');
      onCreated?.(saved);
      onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  const unit = form.meterUnit === 'km' ? 'km' : 'hours';
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={type ? `Edit type ${type.name}` : 'New type'}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save type'}</Button></>}
    >
      <div className="form-grid">
        <Field label="Name" required error={error}>
          {({ id }) => <Input id={id} autoFocus value={form.name} onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setError(''); }} placeholder="e.g. Rice mill engine" />}
        </Field>
        <Field label="Name in Khmer">
          {({ id }) => <Input id={id} value={form.nameKm} onChange={(e) => setForm((f) => ({ ...f, nameKm: e.target.value }))} />}
        </Field>
        <Field label="Meter">
          {({ id }) => (
            <Select id={id} value={form.meterUnit} onChange={(e) => setForm((f) => ({ ...f, meterUnit: e.target.value }))}>
              {METER_UNITS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Usual fuel">
          {({ id }) => (
            <Select id={id} value={form.defaultFuel} onChange={(e) => setForm((f) => ({ ...f, defaultFuel: e.target.value }))}>
              {FUEL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          )}
        </Field>
        {form.meterUnit !== 'none' ? (
          <Field label={`Most ${unit} in a day`} hint="Above this a meter jump is flagged as impossible.">
            {({ id }) => <Input id={id} inputMode="decimal" value={form.maxPerDay} onChange={(e) => setForm((f) => ({ ...f, maxPerDay: e.target.value }))} />}
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}

function MeterResetModal({ open, asset, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState({ oldReading: '', newReading: '0', reason: '', at: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resets, setResets] = useState([]);
  const [voiding, setVoiding] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open || !asset) return;
    setForm({ oldReading: '', newReading: '0', reason: '', at: ppInputValue() });
    setError(''); setBusy(false);
  }, [open, asset]);
  useEffect(() => {
    if (!open || !asset) return;
    window.api.fuel.listMeterResets({ assetId: asset.id }).then((r) => setResets(r || [])).catch(() => setResets([]));
  }, [open, asset, reload]);
  async function save() {
    const oldR = parseNumber(form.oldReading);
    const newR = parseNumber(form.newReading);
    const at = parsePpInput(form.at);
    if (oldR == null || Number.isNaN(oldR)) { setError('Enter the last reading on the old meter'); return; }
    if (newR == null || Number.isNaN(newR)) { setError('Enter the reading on the new meter'); return; }
    if (!form.reason.trim()) { setError('Say why, e.g. "odometer replaced at the garage"'); return; }
    if (at == null || at > Date.now() + 60_000) { setError('Enter when it happened (not in the future)'); return; }
    setBusy(true);
    try {
      await window.api.fuel.recordMeterReset({ assetId: asset.id, oldReading: oldR, newReading: newR, reason: form.reason.trim(), at });
      addToast('Meter reset recorded.', 'success');
      onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  const word = meterWord(asset?.meterUnit);
  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        busy={busy}
        title={`Meter reset — ${asset?.name || ''}`}
        footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Record reset'}</Button></>}
      >
        <p className="fuel-modal-text">When a {word.toLowerCase()} is replaced or rolls over, record it so the next reading is not flagged as going backwards.</p>
        <div className="form-grid">
          <Field label="Last reading on the old meter" required>
            {({ id }) => <Input id={id} inputMode="decimal" autoFocus value={form.oldReading} onChange={(e) => setForm((f) => ({ ...f, oldReading: e.target.value }))} />}
          </Field>
          <Field label="Reading on the new meter" required>
            {({ id }) => <Input id={id} inputMode="decimal" value={form.newReading} onChange={(e) => setForm((f) => ({ ...f, newReading: e.target.value }))} />}
          </Field>
          <Field label="When (Phnom Penh time)" required>
            {({ id }) => <Input id={id} type="datetime-local" value={form.at} onChange={(e) => setForm((f) => ({ ...f, at: e.target.value }))} />}
          </Field>
          <Field label="Reason" required error={error} span="full">
            {({ id }) => <Input id={id} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />}
          </Field>
        </div>
        {resets.length ? (
          <div className="fuel-subsection">
            <h3 className="section-title">Earlier resets</h3>
            <ul className="fuel-plain-list">
              {resets.map((r) => (
                <li key={r.id} className={r.voided ? 'is-muted' : ''}>
                  {fmtWhen(r.at)} · {fmtNumber(r.oldReading, 1)} → {fmtNumber(r.newReading, 1)} · {r.reason}
                  {r.voided ? <span className="muted"> · void ({r.voidReason})</span> : <Button size="sm" variant="ghost" onClick={() => setVoiding(r)}>Void…</Button>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Modal>
      <ReasonModal
        open={!!voiding}
        title="Void this meter reset?"
        message="The reset stays in the history, marked void, and the readings are checked again without it."
        confirmLabel="Void reset"
        danger
        onCancel={() => setVoiding(null)}
        onConfirm={async (reason) => {
          await window.api.fuel.voidRecord('meterReset', voiding.id, reason);
          setVoiding(null);
          setReload((n) => n + 1);
          addToast('Meter reset voided.', 'success');
        }}
      />
    </>
  );
}
