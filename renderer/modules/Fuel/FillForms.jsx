/**
 * Fuel F1 — the fill-up dialogs: "+ Add fill-up" for paper slips (warehouse
 * tank / farm store / cash at a station; pump meter before/after when the tank
 * has a flow meter; photos by file pick or paste), and "Correct…" (a new
 * revision with a reason — the old one is kept).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { newClientRef } from './fuelHooks.js';
import { AssetSelect, LocationSelect, PhotoPicker, StaffSelect, WhenField, photosPayload, revokePreviews } from './FuelShared.jsx';
import {
  FILL_KINDS, PHOTO_KINDS, defaultPhotoKind, slipEvidenceNote, diffFillCorrection, emptyFillForm, errText, fillToCorrectionForm,
  flagHeadline, fmtLitres, meterWord, parseNumber, validateFillForm,
} from './fuelModel.js';

export function AddFillModal({ open, onClose, lookups, defaults, canManage = true }) {
  const addToast = useAppStore((s) => s.addToast);
  const settings = lookups.settings;
  const [form, setForm] = useState(() => emptyFillForm());
  const [photos, setPhotos] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const clientRef = useRef(newClientRef());

  function reset(keep = null) {
    const base = emptyFillForm(Date.now(), { currency: settings?.defaultCurrency, kind: keep?.kind || defaults?.kind });
    setForm(keep ? { ...base, kind: keep.kind, locationId: keep.locationId, stationId: keep.stationId, attendantEmployeeId: keep.attendantEmployeeId, at: keep.at } : { ...base, ...(defaults || {}) });
    setPhotos((old) => { revokePreviews(old); return []; });
    setErrors({});
    setBusy(false);
    clientRef.current = newClientRef();
  }
  useEffect(() => {
    if (open) reset();
    // Reset only when the dialog opens; `reset` reads the latest props itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const asset = lookups.maps.assets.get(form.assetId) || null;
  const location = lookups.maps.locations.get(form.locationId) || null;
  const cash = form.kind === 'cash_station';
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  function pickAsset(id) {
    const a = lookups.maps.assets.get(id);
    setForm((f) => ({ ...f, assetId: id, driverEmployeeId: f.driverEmployeeId || a?.assignedEmployeeId || '' }));
    setErrors((e) => ({ ...e, assetId: undefined }));
  }
  const canLitres = useMemo(() => {
    const n = parseNumber(form.cansCount);
    return n && !Number.isNaN(n) ? n * (settings?.canSizeL || 20) : null;
  }, [form.cansCount, settings]);

  async function save(another) {
    const { errors: errs, payload } = validateFillForm(form, { asset, location, timeIsNow: !canManage });
    setErrors(errs);
    if (!payload) return;
    setBusy(true);
    try {
      const input = { ...payload, clientRef: clientRef.current };
      if (input.cansCount != null) input.canSizeL = settings?.canSizeL || 20;
      if (photos.length) input.photos = await photosPayload(photos);
      const res = await window.api.fuel.recordFill(input);
      const flags = (res?.flags || []).filter((f) => f.status === 'open' && !f.resolved);
      if (flags.length) {
        addToast(`Saved — ${flags.length} flag${flags.length === 1 ? '' : 's'}: ${flagHeadline(flags[0], lookups.maps)}`, 'info');
      } else {
        addToast(res?.duplicate ? 'Already saved — nothing added twice.' : `Saved ${fmtLitres(res?.fill?.litres)} for ${asset?.name || 'the vehicle'}.`, 'success');
      }
      if (another) reset(form);
      else onClose();
    } catch (err) {
      addToast(errText(err), 'error');
      setBusy(false);
    }
  }

  const activeAssets = lookups.assets.filter((a) => a.status !== 'retired');
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title="Add a fill-up from a paper slip"
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => save(true)} disabled={busy}>Save and add another</Button>
          <Button variant="primary" onClick={() => save(false)} disabled={busy}>{busy ? 'Saving…' : 'Save fill-up'}</Button>
        </>
      )}
    >
      <div className="segments fuel-kind-switch" role="tablist" aria-label="Where the fuel came from">
        {FILL_KINDS.map((k) => (
          <button key={k.value} type="button" className={`segment${form.kind === k.value ? ' is-active' : ''}`} onClick={() => set('kind')(k.value)}>{k.label}</button>
        ))}
      </div>
      <div className="form-grid">
        <Field label="Vehicle or machine" required error={errors.assetId}>
          {({ id }) => <AssetSelect id={id} assets={activeAssets} value={form.assetId} onChange={pickAsset} invalid={!!errors.assetId} />}
        </Field>
        <WhenField canManage={canManage} value={form.at} error={errors.at} onChange={set('at')} />
        {cash ? (
          <Field label="Station" required error={errors.stationId} hint="Pick one, or type a new name below.">
            {({ id }) => (
              <Select id={id} value={form.stationId} invalid={!!errors.stationId} onChange={(e) => set('stationId')(e.target.value)}>
                <option value="">Type a new station…</option>
                {lookups.stations.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}{s.area ? ` · ${s.area}` : ''}</option>)}
              </Select>
            )}
          </Field>
        ) : (
          <Field label={form.kind === 'farm_store' ? 'Farm store' : 'Tank'} required error={errors.locationId}>
            {({ id }) => <LocationSelect id={id} locations={lookups.locations.filter((l) => l.status !== 'retired')} kind={form.kind === 'farm_store' ? 'farm_store' : 'tank'} value={form.locationId} onChange={set('locationId')} invalid={!!errors.locationId} />}
          </Field>
        )}
        {cash && !form.stationId ? (
          <Field label="New station name">
            {({ id }) => <Input id={id} value={form.stationName} onChange={(e) => set('stationName')(e.target.value)} placeholder="e.g. Tela Kampong Speu" />}
          </Field>
        ) : <span />}
        <Field label="Driver">
          {({ id }) => <StaffSelect id={id} staff={lookups.staff} role="driver" value={form.driverEmployeeId} onChange={set('driverEmployeeId')} />}
        </Field>
        {!cash ? (
          <Field label="Pump attendant">
            {({ id }) => <StaffSelect id={id} staff={lookups.staff} role="attendant" value={form.attendantEmployeeId} onChange={set('attendantEmployeeId')} />}
          </Field>
        ) : <span />}

        {cash ? (
          <>
            <Field label="Amount paid" required error={errors.amountPaid}>
              {({ id }) => (
                <div className="fuel-inline">
                  <Input id={id} inputMode="decimal" value={form.amountPaid} invalid={!!errors.amountPaid} onChange={(e) => set('amountPaid')(e.target.value)} />
                  <Select aria-label="Currency" value={form.currency} onChange={(e) => set('currency')(e.target.value)}>
                    <option value="KHR">KHR</option>
                    <option value="USD">USD</option>
                  </Select>
                </div>
              )}
            </Field>
            <Field label="Litres shown on the pump" error={errors.litresShownOnPump} hint="Leave empty if unknown — worked out from the posted price.">
              {({ id }) => <Input id={id} inputMode="decimal" value={form.litresShownOnPump} invalid={!!errors.litresShownOnPump} onChange={(e) => set('litresShownOnPump')(e.target.value)} />}
            </Field>
          </>
        ) : (
          <>
            <Field label="Litres" error={errors.litres} hint={location?.hasFlowMeter ? 'Or leave empty and enter the pump meter below.' : undefined}>
              {({ id }) => <Input id={id} inputMode="decimal" value={form.litres} invalid={!!errors.litres} onChange={(e) => set('litres')(e.target.value)} />}
            </Field>
            <Field label={`Or number of ${settings?.canSizeL || 20} L cans`} error={errors.cansCount} hint={canLitres ? `= ${fmtLitres(canLitres, 0)}` : undefined}>
              {({ id }) => <Input id={id} inputMode="numeric" value={form.cansCount} invalid={!!errors.cansCount} onChange={(e) => set('cansCount')(e.target.value)} />}
            </Field>
            {location?.hasFlowMeter ? (
              <>
                <Field label="Pump meter before" error={errors.pumpMeterBefore}>
                  {({ id }) => <Input id={id} inputMode="decimal" value={form.pumpMeterBefore} invalid={!!errors.pumpMeterBefore} onChange={(e) => set('pumpMeterBefore')(e.target.value)} />}
                </Field>
                <Field label="Pump meter after" error={errors.pumpMeterAfter}>
                  {({ id }) => <Input id={id} inputMode="decimal" value={form.pumpMeterAfter} invalid={!!errors.pumpMeterAfter} onChange={(e) => set('pumpMeterAfter')(e.target.value)} />}
                </Field>
              </>
            ) : null}
          </>
        )}

        {asset?.meterUnit !== 'none' ? (
          <Field label={asset ? meterWord(asset.meterUnit) : 'Meter reading'} error={errors.meterReading} hint="Without it the fill cannot be checked against normal use.">
            {({ id }) => <Input id={id} inputMode="decimal" value={form.meterReading} invalid={!!errors.meterReading} onChange={(e) => set('meterReading')(e.target.value)} />}
          </Field>
        ) : <span />}
        <label className="fuel-check">
          <input type="checkbox" checked={form.fullTank} onChange={(e) => set('fullTank')(e.target.checked)} />
          <span>Filled to full</span>
        </label>
        <Field label="Photos" span="full" hint="The slip first, then the odometer or pump display if you have them.">
          {() => {
            // Rule A7 for a paper slip: with the slip photographed (and the
            // meter reading typed) a missing meter / pump photo is only noted;
            // with no photo at all it is an amber flag. Say so before Save.
            const note = slipEvidenceNote({ photoCount: photos.length, meterUnit: asset?.meterUnit, meterReading: form.meterReading });
            return (
              <>
                <PhotoPicker
                  kinds={PHOTO_KINDS.fill}
                  value={photos}
                  onChange={setPhotos}
                  defaultKind={(list) => defaultPhotoKind(form.kind, list, { paperSlip: true })}
                  onError={(m) => addToast(m, 'error')}
                />
                <p className={`fuel-evidence-note${note.tone === 'amber' ? ' is-warning' : ' is-ok'}`} role="status">{note.text}</p>
              </>
            );
          }}
        </Field>
        <Field label="Note" span="full">
          {({ id }) => <Textarea id={id} rows={2} value={form.note} onChange={(e) => set('note')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

export function CorrectFillModal({ fill, lookups, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState(() => fillToCorrectionForm(null));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!fill) return;
    setForm(fillToCorrectionForm(fill));
    setReason(''); setErrors({}); setBusy(false);
  }, [fill]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  async function save() {
    const { errors: errs, patch } = diffFillCorrection(fill, form);
    if (!reason.trim()) errs.reason = 'Say why it is being corrected';
    if (!Object.keys(patch).length && !errs.reason) errs.reason = 'Nothing has changed yet';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await window.api.fuel.correctFill(fill.id, patch, reason.trim());
      addToast('Corrected — the earlier version is kept in the history.', 'success');
      onDone?.(res?.fill);
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  const cash = fill?.kind === 'cash_station';
  const location = fill?.locationId ? lookups.maps.locations.get(fill.locationId) : null;
  const asset = lookups.maps.assets.get(form.assetId);
  const showPump = !cash && (location?.hasFlowMeter || fill?.pumpMeterBefore != null);
  return (
    <Modal
      open={!!fill}
      onClose={onClose}
      busy={busy}
      size="lg"
      title="Correct this fill-up"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save correction'}</Button></>}
    >
      <p className="fuel-modal-text">A correction is saved as a new version. The original stays in the history with your reason.</p>
      <div className="form-grid">
        <Field label="Vehicle or machine" error={errors.assetId}>
          {({ id }) => <AssetSelect id={id} assets={lookups.assets} value={form.assetId} onChange={set('assetId')} invalid={!!errors.assetId} />}
        </Field>
        <Field label="When (Phnom Penh time)" error={errors.at}>
          {({ id }) => <Input id={id} type="datetime-local" value={form.at} invalid={!!errors.at} onChange={(e) => set('at')(e.target.value)} />}
        </Field>
        <Field label="Driver">
          {({ id }) => <StaffSelect id={id} staff={lookups.staff} value={form.driverEmployeeId} onChange={set('driverEmployeeId')} />}
        </Field>
        {!cash ? (
          <Field label="Pump attendant">
            {({ id }) => <StaffSelect id={id} staff={lookups.staff} value={form.attendantEmployeeId} onChange={set('attendantEmployeeId')} />}
          </Field>
        ) : <span />}
        {cash ? (
          <>
            <Field label={`Amount paid (${fill?.currency || 'KHR'})`} error={errors.amountPaid}>
              {({ id }) => <Input id={id} inputMode="decimal" value={form.amountPaid} invalid={!!errors.amountPaid} onChange={(e) => set('amountPaid')(e.target.value)} />}
            </Field>
            <Field label="Litres shown on the pump" error={errors.litresShownOnPump}>
              {({ id }) => <Input id={id} inputMode="decimal" value={form.litresShownOnPump} invalid={!!errors.litresShownOnPump} onChange={(e) => set('litresShownOnPump')(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <Field label="Litres (typed)" error={errors.litres} hint={fill?.litresSource === 'pump_meter' ? 'The pump meter figure is used when both readings are there.' : undefined}>
          {({ id }) => <Input id={id} inputMode="decimal" value={form.litres} invalid={!!errors.litres} onChange={(e) => set('litres')(e.target.value)} />}
        </Field>
        {asset?.meterUnit !== 'none' ? (
          <Field label={meterWord(asset?.meterUnit)} error={errors.meterReading}>
            {({ id }) => <Input id={id} inputMode="decimal" value={form.meterReading} invalid={!!errors.meterReading} onChange={(e) => set('meterReading')(e.target.value)} />}
          </Field>
        ) : <span />}
        {showPump ? (
          <>
            <Field label="Pump meter before" error={errors.pumpMeterBefore}>
              {({ id }) => <Input id={id} inputMode="decimal" value={form.pumpMeterBefore} invalid={!!errors.pumpMeterBefore} onChange={(e) => set('pumpMeterBefore')(e.target.value)} />}
            </Field>
            <Field label="Pump meter after" error={errors.pumpMeterAfter}>
              {({ id }) => <Input id={id} inputMode="decimal" value={form.pumpMeterAfter} invalid={!!errors.pumpMeterAfter} onChange={(e) => set('pumpMeterAfter')(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <label className="fuel-check">
          <input type="checkbox" checked={form.fullTank} onChange={(e) => set('fullTank')(e.target.checked)} />
          <span>Filled to full</span>
        </label>
        <Field label="Note" span="full">
          {({ id }) => <Textarea id={id} rows={2} value={form.note} onChange={(e) => set('note')(e.target.value)} />}
        </Field>
        <Field label="Reason for the correction" required span="full" error={errors.reason}>
          {({ id }) => <Input id={id} value={reason} invalid={!!errors.reason} onChange={(e) => { setReason(e.target.value); setErrors((er) => ({ ...er, reason: undefined })); }} placeholder="e.g. Odometer photo shows 45,210, not 45,120" />}
        </Field>
      </div>
    </Modal>
  );
}
