/**
 * Fuel F1 — Tanks & dips: the owner's named tanks and farm stores (capacity,
 * flow meter), the dip chart (typed, pasted from Excel, or built from dipped
 * deliveries), recording a dip / delivery / transfer to a farm store and its
 * receipt, and each tank's reconciliation (rule T1: expected vs measured,
 * with the tolerance) month by month.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea, cx } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { newClientRef, useFuelCaps, useFuelIntent, useFuelLookups, useFuelTick } from './fuelHooks.js';
import { LocationSelect, PhotoPicker, PhotoStrip, PhotoViewer, ReasonModal, StaffSelect, photosPayload } from './FuelShared.jsx';
import {
  FUEL_TYPES, PHOTO_KINDS, chartError, chartPoints, dipAge, errText, fmtDay, fmtLitres, fmtMoney, fmtNumber, fmtWhen,
  fuelTypeLabel, intervalVerdict, monthLabel, parseChartText, parseNumber, parsePpInput, ppInputValue, ppMonthKey,
  recentMonths, staffName, toMinor,
} from './fuelModel.js';

const TANK_EVENTS = ['dip', 'delivery', 'transfer', 'location', 'fill', 'staff', 'settings'];

export function FuelTanks() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canManage, canRecord } = useFuelCaps();
  const lookups = useFuelLookups({ includeRetired: true });
  const intent = useFuelIntent('fueltanks');
  const tick = useFuelTick(TANK_EVENTS);
  const [showRetired, setShowRetired] = useState(false);
  const [overview, setOverview] = useState(null);
  const [pending, setPending] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [dialog, setDialog] = useState(null); // { kind: 'edit'|'chart'|'dip'|'delivery'|'transfer'|'receive', location?, transfer? }

  useEffect(() => {
    if (!intent) return;
    if (intent.add && canManage) setDialog({ kind: 'edit', location: null });
    if (intent.locationId) setSelectedId(intent.locationId);
  }, [intent, canManage]);
  useEffect(() => { setSelectedId(null); setDialog(null); }, [activeCompanyId]);

  useEffect(() => {
    if (!activeCompanyId) return;
    let alive = true;
    window.api.fuel.listPendingTransfers({}).then((p) => { if (alive) setPending(p || []); }).catch(() => { if (alive) setPending([]); });
    if (canManage) window.api.fuel.getOverview().then((o) => { if (alive) setOverview(o); }).catch((err) => addToast(errText(err), 'error'));
    return () => { alive = false; };
  }, [activeCompanyId, canManage, tick, addToast]);

  const lastDips = useMemo(() => new Map((overview?.tanks || []).map((t) => [t.locationId, t.lastDip])), [overview]);
  const locations = lookups.locations.filter((l) => showRetired || l.status !== 'retired');
  const selected = selectedId ? lookups.maps.locations.get(selectedId) : null;
  const missedDipDays = lookups.settings?.missedDipDays ?? 2;

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Tanks & dips" /><NoCompanyState purpose="see its tanks" /></div>;
  }

  return (
    <div className="page page--fuel">
      <PageHeader
        title="Tanks & dips"
        subtitle="Your own tanks and farm stores. A daily dip is what makes missing litres visible."
        actions={(
          <>
            {canRecord ? <Button onClick={() => setDialog({ kind: 'delivery' })} disabled={!locations.length}>Delivery arrived…</Button> : null}
            {canRecord ? <Button onClick={() => setDialog({ kind: 'transfer' })} disabled={!locations.some((l) => l.kind === 'farm_store')}>Send to farm…</Button> : null}
            {canRecord ? <Button onClick={() => setDialog({ kind: 'dip' })} disabled={!locations.length}>Record dip…</Button> : null}
            {canManage ? <Button variant="primary" onClick={() => setDialog({ kind: 'edit', location: null })}>+ New tank or store</Button> : null}
          </>
        )}
      />

      <div className="toolbar">
        <span className="toolbar__count">{locations.length} tank{locations.length === 1 ? '' : 's'} and store{locations.length === 1 ? '' : 's'}</span>
        <div className="toolbar__spacer" />
        <label className="list-tools__all">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          <span>Show retired</span>
        </label>
      </div>

      {lookups.loaded && !locations.length ? (
        <EmptyState
          title="No tanks yet"
          body="Name each tank and farm store with its size. Then dips, deliveries and fills can be recorded against it."
          action={canManage ? <Button variant="primary" onClick={() => setDialog({ kind: 'edit', location: null })}>+ New tank or store</Button> : null}
        />
      ) : (
        <div className="card-grid card-grid--compact">
          {locations.map((l) => {
            const last = lastDips.get(l.id);
            const age = dipAge(last, missedDipDays);
            return (
              <div key={l.id} className={cx('card', 'fuel-tank-card', selectedId === l.id && 'is-selected', l.status === 'retired' && 'is-muted')}>
                <div className="card__body">
                  <div className="card__eyebrow">{l.kind === 'farm_store' ? 'Farm store' : 'Tank'} · {fuelTypeLabel(l.fuelType)}{l.hasFlowMeter ? ' · flow meter' : ''}</div>
                  <div className="card__title">{l.name}</div>
                  <div className="card__meta">
                    {l.capacityL ? `Holds ${fmtLitres(l.capacityL, 0)}` : 'Size not set'}
                    {l.kind === 'tank' ? (l.hasChart ? ` · dip chart ${l.chartPoints} rows` : ' · no dip chart') : ''}
                  </div>
                  {canManage ? (
                    <div className="card__meta">
                      {last ? <>Last dip {fmtWhen(last.takenAt)} · {fmtLitres(last.litres, 0)}</> : 'Never dipped'}
                      {l.kind === 'tank' && age.stale && l.status !== 'retired' ? <> <Badge tone="amber">{age.never ? 'Dip it' : `${age.days} days ago`}</Badge></> : null}
                    </div>
                  ) : null}
                </div>
                <div className="card__actions">
                  {canRecord ? <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'dip', location: l })}>Dip…</Button> : null}
                  {canManage ? <Button size="sm" onClick={() => setSelectedId(selectedId === l.id ? null : l.id)}>{selectedId === l.id ? 'Hide details' : 'Details'}</Button> : null}
                  {canManage && l.kind === 'tank' ? <Button size="sm" onClick={() => setDialog({ kind: 'chart', location: l })}>Dip chart…</Button> : null}
                  {canManage ? <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'edit', location: l })}>Edit…</Button> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pending.length ? (
        <section className="fuel-section">
          <div className="section-head"><h2 className="section-title">On the way to a farm store</h2><span className="section-hint">Sent and not yet received.</span></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Sent</th><th>From</th><th>To</th><th className="is-num">Litres sent</th><th>Containers</th><th className="is-actions" /></tr></thead>
              <tbody>
                {pending.map((t) => (
                  <tr key={t.id}>
                    <td>{fmtWhen(t.sentAt)}</td>
                    <td>{lookups.maps.locations.get(t.fromLocationId)?.name || '—'}</td>
                    <td>{lookups.maps.locations.get(t.toLocationId)?.name || '—'}</td>
                    <td className="is-num">{fmtLitres(t.litresSent)}</td>
                    <td>{t.containers ? `${t.containers}${t.containerNote ? ` · ${t.containerNote}` : ''}` : '—'}</td>
                    <td className="is-actions">{canRecord ? <Button size="sm" onClick={() => setDialog({ kind: 'receive', transfer: t })}>Received…</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {selected && canManage ? <TankDetail location={selected} lookups={lookups} tick={tick} /> : null}

      <LocationEditorModal open={dialog?.kind === 'edit'} location={dialog?.location} onClose={() => setDialog(null)} />
      <ChartEditorModal open={dialog?.kind === 'chart'} location={dialog?.location} onClose={() => setDialog(null)} />
      <DipModal open={dialog?.kind === 'dip'} location={dialog?.location} lookups={lookups} onClose={() => setDialog(null)} />
      <DeliveryModal open={dialog?.kind === 'delivery'} location={dialog?.location} lookups={lookups} canManage={canManage} onClose={() => setDialog(null)} />
      <TransferModal open={dialog?.kind === 'transfer'} lookups={lookups} onClose={() => setDialog(null)} />
      <ReceiveModal transfer={dialog?.kind === 'receive' ? dialog.transfer : null} lookups={lookups} onClose={() => setDialog(null)} />
    </div>
  );
}

/* ─── one tank: reconciliation, dips, deliveries, transfers ───────────── */

function TankDetail({ location, lookups, tick }) {
  const addToast = useAppStore((s) => s.addToast);
  const months = useMemo(() => recentMonths(24), []);
  const [month, setMonth] = useState(ppMonthKey());
  const [report, setReport] = useState(null);
  const [lists, setLists] = useState({ dips: [], deliveries: [], transfers: [] });
  const [viewer, setViewer] = useState(null);
  const [voiding, setVoiding] = useState(null); // { kind, record }
  const [linking, setLinking] = useState(null); // delivery
  const req = useRef(0);

  useEffect(() => {
    const r = ++req.current;
    const f = window.api.fuel;
    Promise.all([
      f.getMonthlyReport(month),
      f.listDips({ locationId: location.id, limit: 50, includeVoided: true }),
      f.listDeliveries({ locationId: location.id, limit: 50, includeVoided: true }),
      f.listTransfers({ locationId: location.id, limit: 50, includeVoided: true }),
    ]).then(([rep, dips, deliveries, transfers]) => {
      if (r !== req.current) return;
      setReport(rep);
      setLists({ dips: dips?.items || [], deliveries: deliveries?.items || [], transfers: transfers?.items || [] });
    }).catch((err) => { if (r === req.current) addToast(errText(err), 'error'); });
  }, [location.id, month, tick, addToast]);

  const tank = report?.tanks?.find((t) => t.locationId === location.id);
  const intervals = tank?.intervals || [];
  const name = (id) => (id ? staffName(lookups.maps.staff.get(id)) : '—');

  return (
    <section className="fuel-section fuel-tank-detail">
      <div className="section-head">
        <h2 className="section-title">{location.name}</h2>
        <span className="section-hint">Does what went in and out match the dips?</span>
        <div className="section-head__actions">
          <Select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </div>
      </div>

      {tank ? (
        <div className="stat-grid fuel-stats">
          <div className="stat-card"><div className="stat-card__label">Delivered</div><div className="stat-card__value">{fmtLitres(tank.delivered, 0)}</div></div>
          <div className="stat-card"><div className="stat-card__label">Filled into vehicles</div><div className="stat-card__value">{fmtLitres(tank.filled, 0)}</div></div>
          <div className="stat-card"><div className="stat-card__label">{location.kind === 'farm_store' ? 'Received' : 'Sent to farm'}</div><div className="stat-card__value">{fmtLitres(location.kind === 'farm_store' ? tank.received : tank.sent, 0)}</div></div>
          <div className={`stat-card${tank.varianceTotal < 0 ? ' fuel-stat--rose' : ''}`}>
            <div className="stat-card__label">Dips vs records</div>
            <div className="stat-card__value">{tank.varianceTotal == null ? '—' : `${tank.varianceTotal > 0 ? '+' : ''}${fmtLitres(tank.varianceTotal, 0)}`}</div>
            <div className="stat-card__hint">Negative = litres unaccounted for, over {monthLabel(month)}</div>
          </div>
        </div>
      ) : null}

      <h3 className="section-title fuel-subhead">Between dips</h3>
      {intervals.length === 0 ? (
        <p className="muted">Two dips in {monthLabel(month)} are needed to compare. Dip at the same time each day.</p>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>From dip</th><th>To dip</th><th className="is-num">Start</th><th className="is-num">+ Delivered</th><th className="is-num">+ Received</th><th className="is-num">− Filled</th><th className="is-num">− Sent</th><th className="is-num">Expected</th><th className="is-num">Measured</th><th className="is-num">Difference</th><th className="is-num">Allowed ±</th><th>Result</th></tr>
            </thead>
            <tbody>
              {intervals.map((iv) => {
                const v = intervalVerdict(iv);
                return (
                  <tr key={`${iv.fromDipId}-${iv.toDipId}`}>
                    <td>{fmtWhen(iv.fromAt)}</td>
                    <td>{fmtWhen(iv.toAt)}</td>
                    <td className="is-num">{fmtNumber(iv.startLitres, 0)}</td>
                    <td className="is-num">{fmtNumber(iv.delivered, 0)}</td>
                    <td className="is-num">{fmtNumber(iv.received, 0)}</td>
                    <td className="is-num">{fmtNumber(iv.filled, 0)}</td>
                    <td className="is-num">{fmtNumber(iv.sent, 0)}</td>
                    <td className="is-num">{fmtNumber(iv.expected, 0)}</td>
                    <td className="is-num">{fmtNumber(iv.measured, 0)}</td>
                    <td className="is-num"><strong>{iv.variance > 0 ? '+' : ''}{fmtNumber(iv.variance, 1)}</strong></td>
                    <td className="is-num">{fmtNumber(iv.tolerance, 1)}</td>
                    <td>{v === 'red' ? <Badge tone="rose">Missing</Badge> : v === 'amber' ? <Badge tone="amber">More than recorded</Badge> : <Badge tone="emerald">OK</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tank?.fillsByAttendant?.length ? (
        <p className="muted fuel-note">Filled by attendant this month: {tank.fillsByAttendant.map((g) => `${g.name} ${fmtLitres(g.litres, 0)} (${g.fills})`).join(' · ')}</p>
      ) : null}

      <h3 className="section-title fuel-subhead">Dips</h3>
      {lists.dips.length === 0 ? <p className="muted">No dips yet.</p> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Photo</th><th>When</th><th className="is-num">Dip</th><th className="is-num">Litres</th><th>By</th><th>Witness</th><th className="is-actions" /></tr></thead>
            <tbody>
              {lists.dips.map((d) => (
                <tr key={d.id} className={d.voided ? 'is-muted' : ''}>
                  <td><PhotoStrip photos={d.photos} size={36} max={2} onOpen={(i) => setViewer({ photos: d.photos, index: i })} /></td>
                  <td>{fmtWhen(d.takenAt)}{d.voided ? <div className="muted">void: {d.voidReason}</div> : null}</td>
                  <td className="is-num">{d.dipCm != null ? `${fmtNumber(d.dipCm, 1)} cm` : '—'}</td>
                  <td className="is-num">{fmtLitres(d.litres, 0)}{d.outOfChart ? <div className="muted">outside the chart</div> : null}</td>
                  <td>{name(d.takenByEmployeeId)}</td>
                  <td>{name(d.witnessEmployeeId)}</td>
                  <td className="is-actions">{!d.voided ? <Button size="sm" variant="ghost" onClick={() => setVoiding({ kind: 'dip', record: d })}>Void…</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {location.kind === 'tank' ? (
        <>
          <h3 className="section-title fuel-subhead">Deliveries</h3>
          {lists.deliveries.length === 0 ? <p className="muted">No deliveries yet.</p> : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Photo</th><th>When</th><th>Supplier</th><th className="is-num">Invoiced</th><th className="is-num">Price / L</th><th>Dips either side</th><th className="is-actions" /></tr></thead>
                <tbody>
                  {lists.deliveries.map((d) => (
                    <tr key={d.id} className={d.voided ? 'is-muted' : ''}>
                      <td><PhotoStrip photos={d.photos} size={36} max={2} onOpen={(i) => setViewer({ photos: d.photos, index: i })} /></td>
                      <td>{fmtWhen(d.deliveredAt)}{d.voided ? <div className="muted">void: {d.voidReason}</div> : null}</td>
                      <td>{d.supplier || '—'}{d.invoiceNo ? <div className="muted">#{d.invoiceNo}</div> : null}</td>
                      <td className="is-num">{fmtLitres(d.litresInvoiced, 0)}</td>
                      <td className="is-num">{d.priceMinorPerL != null ? fmtMoney(d.priceMinorPerL, d.currency) : '—'}</td>
                      <td>{d.dipBeforeId && d.dipAfterId ? 'Before and after' : d.dipBeforeId || d.dipAfterId ? 'One side only' : <span className="fuel-missing">none — cannot check</span>}</td>
                      <td className="is-actions">
                        {!d.voided ? <Button size="sm" variant="ghost" onClick={() => setLinking(d)}>Dips…</Button> : null}
                        {!d.voided ? <Button size="sm" variant="ghost" onClick={() => setVoiding({ kind: 'delivery', record: d })}>Void…</Button> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      <h3 className="section-title fuel-subhead">Transfers</h3>
      {lists.transfers.length === 0 ? <p className="muted">No transfers yet.</p> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Photo</th><th>Sent</th><th>From → to</th><th className="is-num">Sent</th><th className="is-num">Received</th><th>By</th><th className="is-actions" /></tr></thead>
            <tbody>
              {lists.transfers.map((t) => (
                <tr key={t.id} className={t.voided ? 'is-muted' : ''}>
                  <td><PhotoStrip photos={t.photos} size={36} max={2} onOpen={(i) => setViewer({ photos: t.photos, index: i })} /></td>
                  <td>{fmtWhen(t.sentAt)}{t.voided ? <div className="muted">void: {t.voidReason}</div> : null}</td>
                  <td>{lookups.maps.locations.get(t.fromLocationId)?.name || '—'} → {lookups.maps.locations.get(t.toLocationId)?.name || 'outside'}</td>
                  <td className="is-num">{fmtLitres(t.litresSent)}</td>
                  <td className="is-num">{t.received ? fmtLitres(t.litresReceived) : <span className="muted">not yet</span>}</td>
                  <td>{name(t.sentByEmployeeId)}{t.received ? <div className="muted">received by {name(t.receivedByEmployeeId)}</div> : null}</td>
                  <td className="is-actions">{!t.voided ? <Button size="sm" variant="ghost" onClick={() => setVoiding({ kind: 'transfer', record: t })}>Void…</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PhotoViewer open={!!viewer} photos={viewer?.photos} index={viewer?.index || 0} onClose={() => setViewer(null)} />
      <ReasonModal
        open={!!voiding}
        title={`Void this ${voiding?.kind || 'record'}?`}
        message="It stays in the history, marked void, and the tank is checked again without it."
        confirmLabel="Void"
        danger
        onCancel={() => setVoiding(null)}
        onConfirm={async (reason) => {
          await window.api.fuel.voidRecord(voiding.kind, voiding.record.id, reason);
          setVoiding(null);
          addToast('Voided.', 'success');
        }}
      />
      <DeliveryDipsModal delivery={linking} dips={lists.dips.filter((d) => !d.voided)} onClose={() => setLinking(null)} />
    </section>
  );
}

function dipOption(d) {
  return `${fmtWhen(d.takenAt)} · ${d.dipCm != null ? `${fmtNumber(d.dipCm, 1)} cm · ` : ''}${fmtLitres(d.litres, 0)}`;
}

function DeliveryDipsModal({ delivery, dips, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (delivery) { setBefore(delivery.dipBeforeId || ''); setAfter(delivery.dipAfterId || ''); setBusy(false); } }, [delivery]);
  async function save() {
    setBusy(true);
    try {
      await window.api.fuel.setDeliveryDips({ id: delivery.id, dipBeforeId: before || null, dipAfterId: after || null });
      addToast('Delivery dips saved — it will be checked for a short delivery.', 'success');
      onClose();
    } catch (err) { addToast(errText(err), 'error'); setBusy(false); }
  }
  return (
    <Modal open={!!delivery} onClose={onClose} busy={busy} title="Dips either side of the delivery" footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>Save</Button></>}>
      <p className="fuel-modal-text">With a dip just before and just after, the litres that really arrived can be compared with the invoice (rule T2), and the deliveries can build a dip chart.</p>
      <div className="form-grid">
        <Field label="Dip before">
          {({ id }) => <Select id={id} value={before} onChange={(e) => setBefore(e.target.value)}><option value="">None</option>{dips.map((d) => <option key={d.id} value={d.id}>{dipOption(d)}</option>)}</Select>}
        </Field>
        <Field label="Dip after">
          {({ id }) => <Select id={id} value={after} onChange={(e) => setAfter(e.target.value)}><option value="">None</option>{dips.map((d) => <option key={d.id} value={d.id}>{dipOption(d)}</option>)}</Select>}
        </Field>
      </div>
    </Modal>
  );
}

/* ─── set-up: tank editor and dip chart ───────────────────────────────── */

function LocationEditorModal({ open, location, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setForm({
      name: location?.name || '', kind: location?.kind || 'tank', fuelType: location?.fuelType || 'diesel',
      capacityL: location?.capacityL != null ? String(location.capacityL) : '', hasFlowMeter: !!location?.hasFlowMeter,
      notes: location?.notes || '', active: location ? location.status !== 'retired' : true,
    });
    setError(''); setBusy(false);
  }, [open, location]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setError(''); };
  async function save() {
    if (!form.name.trim()) { setError('Give it a name, e.g. Warehouse tank 1'); return; }
    const cap = parseNumber(form.capacityL);
    if (cap != null && (Number.isNaN(cap) || cap <= 0)) { setError('Capacity must be a number more than 0'); return; }
    const input = { name: form.name.trim(), kind: form.kind, fuelType: form.fuelType, capacityL: cap, hasFlowMeter: !!form.hasFlowMeter, notes: form.notes.trim() || null };
    setBusy(true);
    try {
      if (location) await window.api.fuel.updateLocation(location.id, { ...input, status: form.active ? 'active' : 'retired', expectedUpdatedAt: location.updatedAt });
      else await window.api.fuel.createLocation(input);
      addToast(location ? `Saved ${input.name}.` : `Added ${input.name}.`, 'success');
      onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={location ? `Edit ${location.name}` : 'New tank or farm store'}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button></>}
    >
      <div className="form-grid">
        <Field label="Name" required error={error}>
          {({ id }) => <Input id={id} autoFocus value={form.name || ''} onChange={(e) => set('name')(e.target.value)} placeholder="e.g. Warehouse tank 1" />}
        </Field>
        <Field label="Kind">
          {({ id }) => (
            <Select id={id} value={form.kind || 'tank'} onChange={(e) => set('kind')(e.target.value)} disabled={!!location}>
              <option value="tank">Tank (dipped, with a pump)</option>
              <option value="farm_store">Farm store (cans or drums)</option>
            </Select>
          )}
        </Field>
        <Field label="Fuel">
          {({ id }) => <Select id={id} value={form.fuelType || 'diesel'} onChange={(e) => set('fuelType')(e.target.value)}>{FUEL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>}
        </Field>
        <Field label="Capacity (litres)">
          {({ id }) => <Input id={id} inputMode="decimal" value={form.capacityL || ''} onChange={(e) => set('capacityL')(e.target.value)} />}
        </Field>
        <label className="fuel-check field--full">
          <input type="checkbox" checked={!!form.hasFlowMeter} onChange={(e) => set('hasFlowMeter')(e.target.checked)} />
          <span>The pump has a flow meter — fills record the meter before and after</span>
        </label>
        <Field label="Notes" span="full">
          {({ id }) => <Textarea id={id} rows={2} value={form.notes || ''} onChange={(e) => set('notes')(e.target.value)} />}
        </Field>
        {location ? (
          <label className="fuel-check field--full">
            <input type="checkbox" checked={!!form.active} onChange={(e) => set('active')(e.target.checked)} />
            <span>In use — untick to retire it (its history stays)</span>
          </label>
        ) : null}
      </div>
    </Modal>
  );
}

function ChartEditorModal({ open, location, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [rows, setRows] = useState([]);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [anchor, setAnchor] = useState({ dipCm: '0', litres: '0' });
  useEffect(() => {
    if (!open || !location) return;
    setPaste(''); setError(''); setBusy(false); setSuggestion(null);
    window.api.fuel.getChart(location.id)
      .then((pts) => setRows((pts || []).map((p) => ({ dipCm: String(p.dipCm), litres: String(p.litres) }))))
      .catch((err) => setError(errText(err)));
  }, [open, location]);

  function usePaste() {
    const { points, errors } = parseChartText(paste);
    if (errors.length) { setError(errors[0]); return; }
    if (!points.length) { setError('Nothing to read — paste two columns, cm and litres'); return; }
    setRows(points.map((p) => ({ dipCm: String(p.dipCm), litres: String(p.litres) })));
    setPaste(''); setError('');
  }
  async function suggest() {
    const a = { dipCm: parseNumber(anchor.dipCm), litres: parseNumber(anchor.litres) };
    if ([a.dipCm, a.litres].some((n) => n == null || Number.isNaN(n))) { setError('The starting point needs numbers'); return; }
    try {
      const res = await window.api.fuel.getChartSuggestion({ locationId: location.id, anchor: a, stepCm: 5 });
      setSuggestion(res);
      setError('');
    } catch (err) { setError(errText(err)); }
  }
  async function save() {
    const err = chartError(rows);
    if (err) { setError(err); return; }
    setBusy(true);
    try {
      await window.api.fuel.setChart(location.id, chartPoints(rows));
      addToast(`Dip chart saved for ${location.name}. The old chart is kept in History.`, 'success');
      onClose();
    } catch (e) { setError(errText(e)); setBusy(false); }
  }
  const setRow = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      size="lg"
      title={`Dip chart — ${location?.name || ''}`}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save chart'}</Button></>}
    >
      <p className="fuel-modal-text">The chart turns a dip in cm into litres; between two rows the litres are worked out in a straight line. Use the tank maker's chart if you have one.</p>
      {error ? <p className="field__error" role="alert">{error}</p> : null}
      <div className="fuel-chart-editor">
        <div>
          <table className="data-table fuel-chart-table">
            <thead><tr><th className="is-num">Dip (cm)</th><th className="is-num">Litres</th><th className="is-actions" /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><Input aria-label={`Row ${i + 1} cm`} inputMode="decimal" value={r.dipCm} onChange={(e) => setRow(i, 'dipCm', e.target.value)} /></td>
                  <td><Input aria-label={`Row ${i + 1} litres`} inputMode="decimal" value={r.litres} onChange={(e) => setRow(i, 'litres', e.target.value)} /></td>
                  <td className="is-actions"><Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button size="sm" onClick={() => setRows((rs) => rs.concat({ dipCm: '', litres: '' }))}>+ Add row</Button>
        </div>
        <div className="fuel-chart-editor__side">
          <Field label="Paste from Excel" hint="Two columns: cm, then litres. Replaces the rows.">
            {({ id }) => <Textarea id={id} rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'0\t0\n10\t180\n20\t420'} />}
          </Field>
          <Button size="sm" onClick={usePaste} disabled={!paste.trim()}>Use pasted rows</Button>
          <div className="fuel-subsection">
            <h3 className="section-title">Build from deliveries</h3>
            <p className="muted">Works out litres per cm from deliveries dipped before and after. It is an estimate — it gets better with each delivery.</p>
            <div className="fuel-inline">
              <Field label="Start at (cm)">{({ id }) => <Input id={id} inputMode="decimal" value={anchor.dipCm} onChange={(e) => setAnchor((a) => ({ ...a, dipCm: e.target.value }))} />}</Field>
              <Field label="= litres">{({ id }) => <Input id={id} inputMode="decimal" value={anchor.litres} onChange={(e) => setAnchor((a) => ({ ...a, litres: e.target.value }))} />}</Field>
            </div>
            <Button size="sm" onClick={suggest}>Work it out</Button>
            {suggestion ? (
              <div className="fuel-note">
                <p className="muted">{suggestion.points?.length || 0} rows from {suggestion.observations ?? '?'} deliver{suggestion.observations === 1 ? 'y' : 'ies'}; covers {fmtNumber(suggestion.coveredFromCm, 0)}–{fmtNumber(suggestion.coveredToCm, 0)} cm.</p>
                <Button size="sm" variant="primary" onClick={() => { setRows((suggestion.points || []).map((p) => ({ dipCm: String(p.dipCm), litres: String(Math.round(p.litres * 10) / 10) }))); setSuggestion(null); }}>Use these rows</Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ─── recording: dip, delivery, transfer, receipt ─────────────────────── */

function RecordFooter({ busy, onClose, onSave, label }) {
  return <><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={onSave} disabled={busy}>{busy ? 'Saving…' : label}</Button></>;
}

function useRecordForm(open, initial) {
  const [form, setForm] = useState(initial);
  const [photos, setPhotos] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(newClientRef());
  useEffect(() => {
    if (!open) return;
    setForm(initial); setPhotos([]); setError(''); setBusy(false); ref.current = newClientRef();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setError(''); };
  return { form, set, setForm, photos, setPhotos, error, setError, busy, setBusy, clientRef: ref.current };
}

function timeOrError(value) {
  const at = parsePpInput(value);
  if (at == null) return { error: 'Enter the date and time' };
  if (at > Date.now() + 60_000) return { error: 'The time cannot be in the future' };
  return { at };
}

function DipModal({ open, location, lookups, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const r = useRecordForm(open, { locationId: location?.id || '', dipCm: '', litres: '', takenBy: '', witness: '', at: ppInputValue(), note: '' });
  const loc = lookups.maps.locations.get(r.form.locationId);
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    const cm = parseNumber(r.form.dipCm);
    if (!loc?.hasChart || cm == null || Number.isNaN(cm)) { setPreview(null); return undefined; }
    const t = setTimeout(() => {
      window.api.fuel.getDipLitres(loc.id, cm).then(setPreview).catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [loc, r.form.dipCm]);
  async function save() {
    const { form } = r;
    if (!form.locationId) { r.setError('Pick the tank'); return; }
    const cm = parseNumber(form.dipCm);
    const litres = parseNumber(form.litres);
    if (Number.isNaN(cm) || Number.isNaN(litres)) { r.setError('Dip and litres must be numbers'); return; }
    if (loc?.hasChart && cm == null) { r.setError('Enter the dip in cm'); return; }
    if (!loc?.hasChart && litres == null) { r.setError('This tank has no dip chart yet — enter the litres too'); return; }
    const t = timeOrError(form.at);
    if (t.error) { r.setError(t.error); return; }
    r.setBusy(true);
    try {
      const input = { locationId: form.locationId, at: t.at, source: 'mac', clientRef: r.clientRef };
      if (cm != null) input.dipCm = cm;
      if (!loc?.hasChart && litres != null) input.litres = litres;
      if (form.takenBy) input.takenByEmployeeId = form.takenBy;
      if (form.witness) input.witnessEmployeeId = form.witness;
      if (form.note.trim()) input.note = form.note.trim();
      if (r.photos.length) input.photos = await photosPayload(r.photos);
      const res = await window.api.fuel.recordDip(input);
      const red = (res?.flags || []).find((f) => f.ruleKey === 'T1' && !f.resolved && f.status === 'open');
      addToast(red ? `Dip saved — ${loc?.name || 'the tank'} does not add up since the last dip. See Fuel overview.` : `Dip saved: ${fmtLitres(res?.dip?.litres, 0)}.`, red ? 'info' : 'success');
      onClose();
    } catch (err) { r.setError(errText(err)); r.setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} busy={r.busy} title="Record a dip" footer={<RecordFooter busy={r.busy} onClose={onClose} onSave={save} label="Save dip" />}>
      {r.error ? <p className="field__error" role="alert">{r.error}</p> : null}
      <div className="form-grid">
        <Field label="Tank" required>
          {({ id }) => <LocationSelect id={id} locations={lookups.locations.filter((l) => l.status !== 'retired')} value={r.form.locationId} onChange={r.set('locationId')} />}
        </Field>
        <Field label="When (Phnom Penh time)" required>
          {({ id }) => <Input id={id} type="datetime-local" value={r.form.at} onChange={(e) => r.set('at')(e.target.value)} />}
        </Field>
        <Field label="Dip (cm)" hint={preview ? `= ${fmtLitres(preview.litres, 0)}${preview.outOfRange ? ' (outside the chart — estimated)' : ''}` : loc && !loc.hasChart ? 'No dip chart yet — enter the litres as well.' : undefined}>
          {({ id }) => <Input id={id} inputMode="decimal" autoFocus value={r.form.dipCm} onChange={(e) => r.set('dipCm')(e.target.value)} />}
        </Field>
        {loc && !loc.hasChart ? (
          <Field label="Litres" required>
            {({ id }) => <Input id={id} inputMode="decimal" value={r.form.litres} onChange={(e) => r.set('litres')(e.target.value)} />}
          </Field>
        ) : <span />}
        <Field label="Dipped by">
          {({ id }) => <StaffSelect id={id} staff={lookups.staff} value={r.form.takenBy} onChange={r.set('takenBy')} />}
        </Field>
        <Field label="Witness" hint="Two people at every dip.">
          {({ id }) => <StaffSelect id={id} staff={lookups.staff} value={r.form.witness} onChange={r.set('witness')} />}
        </Field>
        <Field label="Photo of the stick" span="full">
          {() => <PhotoPicker kinds={PHOTO_KINDS.dip} value={r.photos} onChange={r.setPhotos} defaultKind="stick" onError={(m) => addToast(m, 'error')} />}
        </Field>
        <Field label="Note" span="full">
          {({ id }) => <Input id={id} value={r.form.note} onChange={(e) => r.set('note')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function DeliveryModal({ open, location, lookups, canManage, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const r = useRecordForm(open, { locationId: location?.id || '', litresInvoiced: '', supplier: '', invoiceNo: '', price: '', currency: 'KHR', dipBefore: '', dipAfter: '', receivedBy: '', at: ppInputValue(), note: '' });
  const [dips, setDips] = useState([]);
  useEffect(() => {
    if (!open || !canManage || !r.form.locationId) { setDips([]); return; }
    window.api.fuel.listDips({ locationId: r.form.locationId, limit: 20 }).then((res) => setDips(res?.items || [])).catch(() => setDips([]));
  }, [open, canManage, r.form.locationId]);
  async function save() {
    const { form } = r;
    if (!form.locationId) { r.setError('Pick the tank it went into'); return; }
    const litres = parseNumber(form.litresInvoiced);
    if (litres == null || Number.isNaN(litres) || litres <= 0) { r.setError('Enter the litres on the invoice'); return; }
    const price = parseNumber(form.price);
    if (Number.isNaN(price) || (price != null && price <= 0)) { r.setError('Price per litre must be a number more than 0'); return; }
    const t = timeOrError(form.at);
    if (t.error) { r.setError(t.error); return; }
    r.setBusy(true);
    try {
      const input = { locationId: form.locationId, litresInvoiced: litres, at: t.at, source: 'mac', clientRef: r.clientRef, currency: form.currency };
      if (price != null) input.priceMinorPerL = toMinor(price, form.currency);
      if (form.supplier.trim()) input.supplier = form.supplier.trim();
      if (form.invoiceNo.trim()) input.invoiceNo = form.invoiceNo.trim();
      if (form.dipBefore) input.dipBeforeId = form.dipBefore;
      if (form.dipAfter) input.dipAfterId = form.dipAfter;
      if (form.receivedBy) input.receivedByEmployeeId = form.receivedBy;
      if (form.note.trim()) input.note = form.note.trim();
      if (r.photos.length) input.photos = await photosPayload(r.photos);
      await window.api.fuel.recordDelivery(input);
      addToast(`Delivery of ${fmtLitres(litres, 0)} saved.`, 'success');
      onClose();
    } catch (err) { r.setError(errText(err)); r.setBusy(false); }
  }
  const tanks = lookups.locations.filter((l) => l.status !== 'retired' && l.kind === 'tank');
  return (
    <Modal open={open} onClose={onClose} busy={r.busy} size="lg" title="Delivery arrived" footer={<RecordFooter busy={r.busy} onClose={onClose} onSave={save} label="Save delivery" />}>
      {r.error ? <p className="field__error" role="alert">{r.error}</p> : null}
      <p className="fuel-modal-text">Dip just before and just after the delivery — then the litres that really arrived can be checked against the invoice.</p>
      <div className="form-grid">
        <Field label="Tank" required>
          {({ id }) => <LocationSelect id={id} locations={tanks} value={r.form.locationId} onChange={r.set('locationId')} />}
        </Field>
        <Field label="When (Phnom Penh time)" required>
          {({ id }) => <Input id={id} type="datetime-local" value={r.form.at} onChange={(e) => r.set('at')(e.target.value)} />}
        </Field>
        <Field label="Litres on the invoice" required>
          {({ id }) => <Input id={id} inputMode="decimal" autoFocus value={r.form.litresInvoiced} onChange={(e) => r.set('litresInvoiced')(e.target.value)} />}
        </Field>
        <Field label="Price per litre">
          {({ id }) => (
            <div className="fuel-inline">
              <Input id={id} inputMode="decimal" value={r.form.price} onChange={(e) => r.set('price')(e.target.value)} />
              <Select aria-label="Currency" value={r.form.currency} onChange={(e) => r.set('currency')(e.target.value)}><option value="KHR">KHR</option><option value="USD">USD</option></Select>
            </div>
          )}
        </Field>
        <Field label="Supplier">
          {({ id }) => <Input id={id} value={r.form.supplier} onChange={(e) => r.set('supplier')(e.target.value)} />}
        </Field>
        <Field label="Invoice number">
          {({ id }) => <Input id={id} value={r.form.invoiceNo} onChange={(e) => r.set('invoiceNo')(e.target.value)} />}
        </Field>
        {canManage ? (
          <>
            <Field label="Dip before">
              {({ id }) => <Select id={id} value={r.form.dipBefore} onChange={(e) => r.set('dipBefore')(e.target.value)}><option value="">None yet</option>{dips.map((d) => <option key={d.id} value={d.id}>{dipOption(d)}</option>)}</Select>}
            </Field>
            <Field label="Dip after" hint="Record the dip first if it is not in the list.">
              {({ id }) => <Select id={id} value={r.form.dipAfter} onChange={(e) => r.set('dipAfter')(e.target.value)}><option value="">None yet</option>{dips.map((d) => <option key={d.id} value={d.id}>{dipOption(d)}</option>)}</Select>}
            </Field>
          </>
        ) : null}
        <Field label="Received by">
          {({ id }) => <StaffSelect id={id} staff={lookups.staff} value={r.form.receivedBy} onChange={r.set('receivedBy')} />}
        </Field>
        <span />
        <Field label="Photos" span="full" hint="Invoice, the stick, the delivery truck.">
          {() => <PhotoPicker kinds={PHOTO_KINDS.delivery} value={r.photos} onChange={r.setPhotos} defaultKind="invoice" onError={(m) => addToast(m, 'error')} />}
        </Field>
        <Field label="Note" span="full">
          {({ id }) => <Input id={id} value={r.form.note} onChange={(e) => r.set('note')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function TransferModal({ open, lookups, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const r = useRecordForm(open, { fromLocationId: '', toLocationId: '', litresSent: '', pumpBefore: '', pumpAfter: '', containers: '', containerNote: '', sentBy: '', at: ppInputValue(), note: '' });
  const from = lookups.maps.locations.get(r.form.fromLocationId);
  async function save() {
    const { form } = r;
    if (!form.fromLocationId) { r.setError('Pick the tank it was sent from'); return; }
    if (!form.toLocationId) { r.setError('Pick the farm store it was sent to'); return; }
    const litres = parseNumber(form.litresSent);
    const before = parseNumber(form.pumpBefore);
    const after = parseNumber(form.pumpAfter);
    const containers = parseNumber(form.containers);
    if ([litres, before, after, containers].some((n) => Number.isNaN(n))) { r.setError('Litres, meter readings and containers must be numbers'); return; }
    if ((before == null) !== (after == null)) { r.setError('Enter both pump meter readings, or neither'); return; }
    if (litres == null && before == null) { r.setError('Enter the litres sent'); return; }
    const t = timeOrError(form.at);
    if (t.error) { r.setError(t.error); return; }
    r.setBusy(true);
    try {
      const input = { fromLocationId: form.fromLocationId, toLocationId: form.toLocationId, at: t.at, source: 'mac', clientRef: r.clientRef };
      if (litres != null) input.litresSent = litres;
      if (before != null) { input.pumpMeterBefore = before; input.pumpMeterAfter = after; }
      if (containers != null) input.containers = Math.round(containers);
      if (form.containerNote.trim()) input.containerNote = form.containerNote.trim();
      if (form.sentBy) input.sentByEmployeeId = form.sentBy;
      if (form.note.trim()) input.note = form.note.trim();
      if (r.photos.length) input.photos = await photosPayload(r.photos);
      const res = await window.api.fuel.recordTransfer(input);
      addToast(`Sent ${fmtLitres(res?.transfer?.litresSent)} — mark it received when it arrives.`, 'success');
      onClose();
    } catch (err) { r.setError(errText(err)); r.setBusy(false); }
  }
  const active = lookups.locations.filter((l) => l.status !== 'retired');
  return (
    <Modal open={open} onClose={onClose} busy={r.busy} size="lg" title="Send fuel to a farm store" footer={<RecordFooter busy={r.busy} onClose={onClose} onSave={save} label="Save transfer" />}>
      {r.error ? <p className="field__error" role="alert">{r.error}</p> : null}
      <div className="form-grid">
        <Field label="From tank" required>
          {({ id }) => <LocationSelect id={id} locations={active} kind="tank" value={r.form.fromLocationId} onChange={r.set('fromLocationId')} />}
        </Field>
        <Field label="To farm store" required>
          {({ id }) => <LocationSelect id={id} locations={active} kind="farm_store" value={r.form.toLocationId} onChange={r.set('toLocationId')} />}
        </Field>
        <Field label="Litres sent">
          {({ id }) => <Input id={id} inputMode="decimal" value={r.form.litresSent} onChange={(e) => r.set('litresSent')(e.target.value)} />}
        </Field>
        <Field label="When (Phnom Penh time)" required>
          {({ id }) => <Input id={id} type="datetime-local" value={r.form.at} onChange={(e) => r.set('at')(e.target.value)} />}
        </Field>
        {from?.hasFlowMeter ? (
          <>
            <Field label="Pump meter before">{({ id }) => <Input id={id} inputMode="decimal" value={r.form.pumpBefore} onChange={(e) => r.set('pumpBefore')(e.target.value)} />}</Field>
            <Field label="Pump meter after">{({ id }) => <Input id={id} inputMode="decimal" value={r.form.pumpAfter} onChange={(e) => r.set('pumpAfter')(e.target.value)} />}</Field>
          </>
        ) : null}
        <Field label="Containers">
          {({ id }) => <Input id={id} inputMode="numeric" value={r.form.containers} onChange={(e) => r.set('containers')(e.target.value)} />}
        </Field>
        <Field label="Seal numbers / container note">
          {({ id }) => <Input id={id} value={r.form.containerNote} onChange={(e) => r.set('containerNote')(e.target.value)} />}
        </Field>
        <Field label="Sent by">
          {({ id }) => <StaffSelect id={id} staff={lookups.staff} value={r.form.sentBy} onChange={r.set('sentBy')} />}
        </Field>
        <span />
        <Field label="Photos" span="full" hint="Containers, seals, the pump meter.">
          {() => <PhotoPicker kinds={PHOTO_KINDS.transfer} value={r.photos} onChange={r.setPhotos} defaultKind="containers" onError={(m) => addToast(m, 'error')} />}
        </Field>
        <Field label="Note" span="full">
          {({ id }) => <Input id={id} value={r.form.note} onChange={(e) => r.set('note')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function ReceiveModal({ transfer, lookups, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const open = !!transfer;
  const r = useRecordForm(open, { litres: '', receivedBy: '', at: ppInputValue(), note: '' });
  const { setForm } = r;
  useEffect(() => {
    if (transfer) setForm((f) => ({ ...f, litres: String(transfer.litresSent ?? '') }));
  }, [transfer, setForm]);
  async function save() {
    const litres = parseNumber(r.form.litres);
    if (litres == null || Number.isNaN(litres) || litres < 0) { r.setError('Enter the litres that arrived'); return; }
    const t = timeOrError(r.form.at);
    if (t.error) { r.setError(t.error); return; }
    r.setBusy(true);
    try {
      const input = { id: transfer.id, litresReceived: litres, at: t.at, source: 'mac' };
      if (r.form.receivedBy) input.receivedByEmployeeId = r.form.receivedBy;
      if (r.form.note.trim()) input.note = r.form.note.trim();
      if (r.photos.length) input.photos = await photosPayload(r.photos);
      await window.api.fuel.receiveTransfer(input);
      addToast('Marked as received.', 'success');
      onClose();
    } catch (err) { r.setError(errText(err)); r.setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} busy={r.busy} title="Fuel arrived at the farm" footer={<RecordFooter busy={r.busy} onClose={onClose} onSave={save} label="Save" />}>
      {r.error ? <p className="field__error" role="alert">{r.error}</p> : null}
      {transfer ? <p className="fuel-modal-text">{fmtLitres(transfer.litresSent)} sent {fmtDay(transfer.sentAt)} to {lookups.maps.locations.get(transfer.toLocationId)?.name || 'the farm store'}. Measure what actually arrived.</p> : null}
      <div className="form-grid">
        <Field label="Litres that arrived" required>
          {({ id }) => <Input id={id} inputMode="decimal" autoFocus value={r.form.litres} onChange={(e) => r.set('litres')(e.target.value)} />}
        </Field>
        <Field label="When (Phnom Penh time)" required>
          {({ id }) => <Input id={id} type="datetime-local" value={r.form.at} onChange={(e) => r.set('at')(e.target.value)} />}
        </Field>
        <Field label="Received by">
          {({ id }) => <StaffSelect id={id} staff={lookups.staff} value={r.form.receivedBy} onChange={r.set('receivedBy')} />}
        </Field>
        <span />
        <Field label="Photos" span="full">
          {() => <PhotoPicker kinds={PHOTO_KINDS.transfer} value={r.photos} onChange={r.setPhotos} defaultKind="received" onError={(m) => addToast(m, 'error')} />}
        </Field>
        <Field label="Note" span="full">
          {({ id }) => <Input id={id} value={r.form.note} onChange={(e) => r.set('note')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
