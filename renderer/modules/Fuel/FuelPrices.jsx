/**
 * Fuel F1 — Fuel prices: the published price per litre for each period
 * (diesel / gasoline, KHR), which cash purchases are checked against (rules
 * C1 / C2), and the public stations drivers buy from.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Select, cx } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useFuelCaps, useFuelTick } from './fuelHooks.js';
import { ReasonModal } from './FuelShared.jsx';
import { FUEL_TYPES, errText, fmtDay, fmtMoney, fuelTypeLabel, parseNumber, ppDateKey, toMinor } from './fuelModel.js';

export function FuelPrices() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canManage } = useFuelCaps();
  const tick = useFuelTick(['price', 'station', 'fill']);
  const [prices, setPrices] = useState([]);
  const [stations, setStations] = useState([]);
  const [showVoided, setShowVoided] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const [station, setStation] = useState(null); // null | 'new' | station
  const [voiding, setVoiding] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { setPrices([]); setStations([]); setStation(null); setPriceOpen(false); }, [activeCompanyId]); // L4
  useEffect(() => {
    if (!activeCompanyId) return undefined;
    let alive = true;
    setLoading(true);
    Promise.all([
      window.api.fuel.listPrices({ includeVoided: showVoided }),
      window.api.fuel.listStations({ includeArchived: showArchived }),
    ]).then(([p, s]) => { if (alive) { setPrices(p || []); setStations(s || []); } })
      .catch((err) => { if (alive) { setPrices([]); setStations([]); addToast(errText(err), 'error'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, showVoided, showArchived, tick, addToast]);

  const byType = useMemo(() => FUEL_TYPES.map((t) => ({ ...t, rows: prices.filter((p) => p.fuelType === t.value) })).filter((g) => g.rows.length), [prices]);
  const today = ppDateKey();

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Fuel prices" /><NoCompanyState purpose="keep its fuel prices" /></div>;
  }

  return (
    <div className="page page--fuel">
      <PageHeader
        title="Fuel prices"
        subtitle="The posted price per litre for each period. Cash purchases are checked against it."
        actions={canManage ? (
          <>
            <Button onClick={() => setStation('new')}>+ New station</Button>
            <Button variant="primary" onClick={() => setPriceOpen(true)}>+ New price</Button>
          </>
        ) : null}
      />

      <section className="fuel-section">
        <div className="section-head">
          <h2 className="section-title">Posted prices</h2>
          <span className="section-hint">A new price closes the previous period the day before it starts.</span>
          <div className="section-head__actions">
            <label className="list-tools__all"><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} /><span>Show void</span></label>
          </div>
        </div>
        {loading && !prices.length ? <p className="muted">Loading…</p> : !byType.length ? (
          <EmptyState
            title="No prices yet"
            body="Enter the government's published price for diesel and gasoline. Without it, cash fills can only be checked with a pump-display photo."
            action={canManage ? <Button variant="primary" onClick={() => setPriceOpen(true)}>+ New price</Button> : null}
          />
        ) : byType.map((g) => (
          <div key={g.value} className="fuel-subsection">
            <h3 className="section-title fuel-subhead">{g.label}</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>From</th><th>To</th><th className="is-num">Price per litre</th><th>Source</th><th>Status</th><th className="is-actions" /></tr></thead>
                <tbody>
                  {g.rows.map((p) => {
                    const current = !p.voided && p.effectiveFrom <= today && (!p.effectiveTo || p.effectiveTo >= today);
                    return (
                      <tr key={p.id} className={cx(p.voided && 'is-muted')}>
                        <td className="fuel-nowrap">{fmtDay(p.effectiveFrom)}</td>
                        <td className="fuel-nowrap">{p.effectiveTo ? fmtDay(p.effectiveTo) : <span className="muted">open</span>}</td>
                        <td className="is-num"><strong>{fmtMoney(p.priceMinorPerL, p.currency)}</strong></td>
                        <td>{p.sourceNote || <span className="muted">—</span>}</td>
                        <td>{p.voided ? <Badge tone="slate">Void</Badge> : current ? <Badge tone="emerald">Current</Badge> : p.effectiveFrom > today ? <Badge tone="blue">Upcoming</Badge> : <Badge tone="slate">Past</Badge>}</td>
                        <td className="is-actions">{canManage && !p.voided ? <Button size="sm" variant="ghost" onClick={() => setVoiding(p)}>Void…</Button> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <section className="fuel-section">
        <div className="section-head">
          <h2 className="section-title">Stations</h2>
          <span className="section-hint">Where drivers buy fuel with cash. Most recently used first.</span>
          <div className="section-head__actions">
            <label className="list-tools__all"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /><span>Show archived</span></label>
          </div>
        </div>
        {!stations.length ? (
          <p className="muted">No stations yet. They are added here, or the first time a driver names one.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Name</th><th>Area</th><th>Last used</th><th>Status</th></tr></thead>
              <tbody>
                {stations.map((s) => (
                  <tr key={s.id} className={cx(canManage && 'is-clickable', s.archived && 'is-muted')} onClick={canManage ? () => setStation(s) : undefined}>
                    <td><strong>{s.name}</strong></td>
                    <td>{s.area || <span className="muted">—</span>}</td>
                    <td>{s.lastUsedAt ? fmtDay(s.lastUsedAt) : <span className="muted">never</span>}</td>
                    <td>{s.archived ? <Badge tone="slate">Archived</Badge> : <Badge tone="emerald">In use</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <PriceModal open={priceOpen} onClose={() => setPriceOpen(false)} />
      <StationModal station={station} onClose={() => setStation(null)} />
      <ReasonModal
        open={!!voiding}
        title="Void this price?"
        message={voiding ? `${fuelTypeLabel(voiding.fuelType)} ${fmtMoney(voiding.priceMinorPerL, voiding.currency)} from ${fmtDay(voiding.effectiveFrom)}. It stays in the history, marked void, and cash fills are checked again without it.` : ''}
        confirmLabel="Void price"
        danger
        onCancel={() => setVoiding(null)}
        onConfirm={async (reason) => {
          await window.api.fuel.voidPrice(voiding.id, reason);
          setVoiding(null);
          addToast('Price voided.', 'success');
        }}
      />
    </div>
  );
}

function PriceModal({ open, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const [form, setForm] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setForm({ fuelType: 'diesel', price: '', currency: 'KHR', effectiveFrom: ppDateKey(), sourceNote: '' }); setError(''); setBusy(false); }
  }, [open]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setError(''); };
  async function save() {
    const price = parseNumber(form.price);
    if (price == null || Number.isNaN(price) || price <= 0) { setError('Enter the price per litre'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom || '')) { setError('Enter the date the price starts'); return; }
    setBusy(true);
    try {
      await window.api.fuel.setPrice({
        fuelType: form.fuelType, priceMinorPerL: toMinor(price, form.currency), currency: form.currency,
        effectiveFrom: form.effectiveFrom, sourceNote: form.sourceNote.trim() || null,
      });
      addToast(`${fuelTypeLabel(form.fuelType)} price saved from ${form.effectiveFrom}.`, 'success');
      onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title="New posted price"
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save price'}</Button></>}
    >
      <div className="form-grid">
        <Field label="Fuel">
          {({ id }) => <Select id={id} value={form.fuelType || 'diesel'} onChange={(e) => set('fuelType')(e.target.value)}>{FUEL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>}
        </Field>
        <Field label="Starts on" required>
          {({ id }) => <Input id={id} type="date" value={form.effectiveFrom || ''} onChange={(e) => set('effectiveFrom')(e.target.value)} />}
        </Field>
        <Field label="Price per litre" required error={error}>
          {({ id }) => (
            <div className="fuel-inline">
              <Input id={id} inputMode="decimal" autoFocus value={form.price || ''} onChange={(e) => set('price')(e.target.value)} />
              <Select aria-label="Currency" value={form.currency || 'KHR'} onChange={(e) => set('currency')(e.target.value)}><option value="KHR">KHR</option><option value="USD">USD</option></Select>
            </div>
          )}
        </Field>
        <Field label="Source" hint="Where the price was published, e.g. Ministry of Commerce notice.">
          {({ id }) => <Input id={id} value={form.sourceNote || ''} onChange={(e) => set('sourceNote')(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function StationModal({ station, onClose }) {
  const addToast = useAppStore((s) => s.addToast);
  const open = station !== null;
  const existing = station && station !== 'new' ? station : null;
  const [form, setForm] = useState({ name: '', area: '', archived: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setForm({ name: existing?.name || '', area: existing?.area || '', archived: !!existing?.archived }); setError(''); setBusy(false); }
  }, [open, existing]);
  async function save() {
    if (!form.name.trim()) { setError('Give the station a name'); return; }
    setBusy(true);
    try {
      if (existing) await window.api.fuel.updateStation(existing.id, { name: form.name.trim(), area: form.area.trim() || null, archived: form.archived });
      else await window.api.fuel.createStation({ name: form.name.trim(), area: form.area.trim() || null });
      addToast(existing ? 'Station saved.' : 'Station added.', 'success');
      onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={existing ? `Edit ${existing.name}` : 'New station'}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button></>}
    >
      <div className="form-grid">
        <Field label="Name" required error={error}>
          {({ id }) => <Input id={id} autoFocus value={form.name} onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setError(''); }} placeholder="e.g. Tela — National Road 4" />}
        </Field>
        <Field label="Area" hint="Helps to spot one station recurring in flags.">
          {({ id }) => <Input id={id} value={form.area} onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))} />}
        </Field>
        {existing ? (
          <label className="fuel-check field--full">
            <input type="checkbox" checked={form.archived} onChange={(e) => setForm((f) => ({ ...f, archived: e.target.checked }))} />
            <span>Archived — hidden from the phone's station list</span>
          </label>
        ) : null}
      </div>
    </Modal>
  );
}
