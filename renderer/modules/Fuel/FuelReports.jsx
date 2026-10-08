/**
 * Fuel F1 — Fuel reports (docs/PEOPLE_AND_FUEL_PLAN.md §4.5): one month, per
 * vehicle / machine, per driver (ranked by excess riel) and per tank, plus
 * the flags by rule; Export to Excel saves the same report as a workbook.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Select } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useFuelCaps, useFuelTick } from './fuelHooks.js';
import { LoadError, ManageOnlyNote } from './FuelShared.jsx';
import { errText, fmtLitres, fmtMoney, fmtNumber, fmtRiel, fmtWhen, monthLabel, ppMonthKey, rankDrivers, recentMonths, ruleTitle } from './fuelModel.js';

const VIEWS = [
  { value: 'assets', label: 'Per vehicle' },
  { value: 'drivers', label: 'Per driver' },
  { value: 'tanks', label: 'Per tank' },
  { value: 'flags', label: 'Flags' },
];

function cashText(cashPaid) {
  const parts = Object.entries(cashPaid || {}).filter(([, v]) => v).map(([c, v]) => fmtMoney(v, c));
  return parts.length ? parts.join(' + ') : '—';
}

function Excess({ litres, riel }) {
  if (litres == null) return <span className="muted" title="Needs a meter reading and a normal-use figure">—</span>;
  const tone = riel > 0 ? 'fuel-excess is-over' : 'fuel-excess';
  return <span className={tone}>{litres > 0 ? '+' : ''}{fmtLitres(litres, 1)}{riel != null ? <div>{fmtRiel(riel)}</div> : null}</span>;
}

export function FuelReports() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canManage } = useFuelCaps();
  const tick = useFuelTick(['fill', 'dip', 'delivery', 'transfer', 'flag', 'asset', 'location', 'price', 'settings', 'meterReset']);
  const months = useMemo(() => recentMonths(24), []);
  const [month, setMonth] = useState(ppMonthKey());
  const [view, setView] = useState('assets');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  // L4: a company switch (or a month change) never shows the previous report.
  useEffect(() => { setReport(null); setLoadError(''); }, [activeCompanyId, month]);
  useEffect(() => {
    if (!activeCompanyId || !canManage) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.fuel.getMonthlyReport(month)
      .then((r) => { if (alive) { setReport(r); setLoadError(''); } })
      .catch((err) => { if (alive) { setReport(null); setLoadError(errText(err)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, canManage, month, tick, retry]);

  async function exportXlsx() {
    setExporting(true);
    try {
      const path = await window.api.fuel.saveMonthlyWorkbook(month);
      if (path) addToast(`Exported to ${path}`, 'success');
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setExporting(false); }
  }

  if (!activeCompanyId) return <div className="page"><PageHeader title="Fuel reports" /><NoCompanyState purpose="see its fuel reports" /></div>;
  if (!canManage) return <div className="page"><PageHeader title="Fuel reports" /><ManageOnlyNote /></div>;

  const t = report?.totals;
  const drivers = rankDrivers(report?.drivers);
  return (
    <div className="page page--fuel">
      <PageHeader
        title="Fuel reports"
        subtitle="Where the fuel went, and how far each vehicle was above its normal."
        actions={(
          <>
            <Select className="fuel-month-select" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
            <Button variant="primary" onClick={exportXlsx} disabled={exporting || !report}>{exporting ? 'Exporting…' : 'Export to Excel…'}</Button>
          </>
        )}
      />

      <div className="stat-grid fuel-stats">
        <div className="stat-card"><div className="stat-card__label">Fill-ups</div><div className="stat-card__value">{t ? fmtNumber(t.fills) : '—'}</div></div>
        <div className="stat-card"><div className="stat-card__label">Litres</div><div className="stat-card__value">{t ? fmtLitres(t.litres, 0) : '—'}</div></div>
        <div className="stat-card"><div className="stat-card__label">Value</div><div className="stat-card__value">{t ? fmtRiel(t.valueRiel) : '—'}</div><div className="stat-card__hint">Cash paid, or litres × the riel price</div></div>
        <div className={`stat-card${t?.excessRiel > 0 ? ' fuel-stat--rose' : ''}`}><div className="stat-card__label">Excess</div><div className="stat-card__value">{t ? fmtRiel(t.excessRiel) : '—'}</div><div className="stat-card__hint">Above each vehicle's normal use</div></div>
      </div>

      <div className="toolbar">
        <div className="segments" role="tablist" aria-label="Report">
          {VIEWS.map((v) => <button key={v.value} type="button" className={`segment${view === v.value ? ' is-active' : ''}`} onClick={() => setView(v.value)}>{v.label}</button>)}
        </div>
        <div className="toolbar__spacer" />
        <span className="toolbar__count">{monthLabel(month)}</span>
      </div>

      {loadError ? <LoadError message={loadError} onRetry={() => setRetry((n) => n + 1)} /> : null}
      {loading && !report ? <p className="muted">Building the report…</p> : !report ? null : (
        view === 'assets' ? (
          report.assets.length ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Vehicle or machine</th><th className="is-num">Distance</th><th className="is-num">Litres</th><th className="is-num">Tank / farm / cash</th><th className="is-num">Cash paid</th><th className="is-num">Value</th><th className="is-num">Actual</th><th className="is-num">Normal</th><th className="is-num">Cost per km/h</th><th className="is-num">Excess</th><th>Flags</th></tr></thead>
                <tbody>
                  {report.assets.map((a) => (
                    <tr key={a.assetId}>
                      <td><strong>{a.name}</strong>{a.plateOrSerial ? <div className="muted">{a.plateOrSerial}</div> : null}<div className="muted">{a.typeName}</div></td>
                      <td className="is-num">{a.distance != null ? `${fmtNumber(a.distance, 1)} ${a.meterUnit === 'hours' ? 'h' : 'km'}` : '—'}</td>
                      <td className="is-num">{fmtLitres(a.litres)}<div className="muted">{a.fills} fill{a.fills === 1 ? '' : 's'}</div></td>
                      <td className="is-num">{fmtNumber(a.litresByKind?.warehouse_tank, 0)} / {fmtNumber(a.litresByKind?.farm_store, 0)} / {fmtNumber(a.litresByKind?.cash_station, 0)}</td>
                      <td className="is-num">{cashText(a.cashPaid)}</td>
                      <td className="is-num">{fmtRiel(a.valueRiel)}</td>
                      <td className="is-num">{a.actualRate != null ? `${fmtNumber(a.actualRate, 2)}` : '—'}<div className="muted">{a.rateUnit}</div></td>
                      <td className="is-num">{a.baseline != null ? fmtNumber(a.baseline, 2) : '—'}</td>
                      <td className="is-num">{a.costPerUnitRiel != null ? fmtRiel(a.costPerUnitRiel) : '—'}</td>
                      <td className="is-num"><Excess litres={a.excessLitres} riel={a.excessRiel} /></td>
                      <td>{a.openFlags ? <Badge tone={a.redFlags ? 'rose' : 'amber'}>{a.openFlags} open</Badge> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="No vehicles yet" body="Add vehicles and machines, and their fill-ups will be summed here." />
        ) : view === 'drivers' ? (
          drivers.length ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>#</th><th>Driver</th><th className="is-num">Litres</th><th className="is-num">Distance</th><th className="is-num">Fills</th><th className="is-num">Cash paid</th><th className="is-num">Excess</th><th>Vehicles</th><th>Flags</th></tr></thead>
                <tbody>
                  {drivers.map((d, i) => (
                    <tr key={d.employeeId || 'none'}>
                      <td className="muted">{i + 1}</td>
                      <td><strong>{d.employeeId ? d.name : 'No driver recorded'}</strong>{d.staffCode ? <div className="muted">{d.staffCode}</div> : null}</td>
                      <td className="is-num">{fmtLitres(d.litres)}</td>
                      <td className="is-num">{d.distanceKm ? `${fmtNumber(d.distanceKm, 0)} km` : ''}{d.hours ? `${d.distanceKm ? ' · ' : ''}${fmtNumber(d.hours, 1)} h` : ''}{!d.distanceKm && !d.hours ? '—' : ''}</td>
                      <td className="is-num">{d.fills}</td>
                      <td className="is-num">{cashText(d.cashPaid)}</td>
                      <td className="is-num"><Excess litres={d.excessLitres} riel={d.excessRiel} /></td>
                      <td>{(d.assets || []).map((a) => a.name).join(', ')}</td>
                      <td>{d.openFlags ? <Badge tone="amber">{d.openFlags} open</Badge> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="No fill-ups this month" body="Drivers are ranked here once fill-ups name them." />
        ) : view === 'tanks' ? (
          report.tanks.length ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Tank or store</th><th className="is-num">Delivered</th><th className="is-num">Filled</th><th className="is-num">Sent</th><th className="is-num">Received</th><th className="is-num">Dips vs records</th><th>Short deliveries</th><th>Last dip</th><th>Flags</th></tr></thead>
                <tbody>
                  {report.tanks.map((k) => {
                    const short = (k.deliveries || []).filter((d) => d.shortfall > 0);
                    return (
                      <tr key={k.locationId}>
                        <td><strong>{k.name}</strong><div className="muted">{k.kind === 'farm_store' ? 'Farm store' : 'Tank'}</div></td>
                        <td className="is-num">{fmtLitres(k.delivered, 0)}</td>
                        <td className="is-num">{fmtLitres(k.filled, 0)}</td>
                        <td className="is-num">{fmtLitres(k.sent, 0)}</td>
                        <td className="is-num">{fmtLitres(k.received, 0)}</td>
                        <td className="is-num"><strong className={k.varianceTotal < 0 ? 'fuel-excess is-over' : ''}>{k.varianceTotal == null ? '—' : `${k.varianceTotal > 0 ? '+' : ''}${fmtLitres(k.varianceTotal, 0)}`}</strong><div className="muted">{(k.intervals || []).length} dip-to-dip</div></td>
                        <td>{short.length ? short.map((d) => `${fmtLitres(d.shortfall, 0)} short`).join(', ') : <span className="muted">—</span>}</td>
                        <td>{k.lastDip ? fmtWhen(k.lastDip.takenAt) : <span className="muted">never</span>}</td>
                        <td>{k.openFlags ? <Badge tone="amber">{k.openFlags} open</Badge> : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="No tanks yet" body="Tanks and farm stores are reconciled here month by month." />
        ) : (
          report.flags.length ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Rule</th><th className="is-num">Red</th><th className="is-num">Amber</th><th className="is-num">Info</th><th className="is-num">Still open</th><th className="is-num">Total</th></tr></thead>
                <tbody>
                  {report.flags.map((f) => (
                    <tr key={f.ruleKey}>
                      <td><strong>{ruleTitle(f.ruleKey)}</strong> <span className="muted">({f.ruleKey})</span></td>
                      <td className="is-num">{f.red || '—'}</td>
                      <td className="is-num">{f.amber || '—'}</td>
                      <td className="is-num">{f.info || '—'}</td>
                      <td className="is-num">{f.open || '—'}</td>
                      <td className="is-num">{f.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="No flags this month" body="Every check passed." />
        )
      )}
    </div>
  );
}
