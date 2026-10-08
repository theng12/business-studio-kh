/**
 * Fuel F1 — Fuel reports (docs/PEOPLE_AND_FUEL_PLAN.md §4.5): one month, per
 * vehicle / machine and per driver (both ranked by SUSPECTED LOSS, like the
 * server: riel of the fuel above normal variation + cash paid above the pump
 * price; the raw excess stays under it), per tank, and every flag of the
 * month with its status. Export to Excel saves the same report.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Pagination, Select, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useFuelCaps, useFuelLookups, useFuelTick } from './fuelHooks.js';
import { LoadError, ManageOnlyNote, SeverityBadge } from './FuelShared.jsx';
import {
  errText, flagHeadline, flagStatusBadge, fmtDay, fmtLitres, fmtMoney, fmtNumber, fmtRiel, fmtShort, monthLabel, ppMonthKey,
  rankDrivers, recentMonths, ruleTitle, settingToDisplay, FUEL_SETTING_FIELDS, sortFlags, totalSuspectedLoss,
} from './fuelModel.js';

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

/** Suspected loss (the ranking) in bold; under it the suspected litres and the raw excess. */
function SuspectedLoss({ row, withCash = false }) {
  const loss = row.suspectedLossRiel;
  const sign = (n) => (n > 0 ? '+' : '');
  return (
    <span className={loss > 0 ? 'fuel-excess is-over' : 'fuel-excess'}>
      <strong>{loss != null ? fmtRiel(loss) : '—'}</strong>
      {row.suspectedExcessLitres ? <div className="muted">{sign(row.suspectedExcessLitres)}{fmtLitres(row.suspectedExcessLitres, 1)} suspected</div> : null}
      {withCash && row.cashOverpaidRiel ? <div className="muted fuel-overpaid">incl. {fmtRiel(row.cashOverpaidRiel)} cash above pump price</div> : null}
      <div className="muted" title="All fuel above normal, including normal variation">
        {row.excessLitres == null ? 'excess —' : (
          <>
            <span className="fuel-nowrap">excess {sign(row.excessLitres)}{fmtLitres(row.excessLitres, 1)}</span>
            {row.excessRiel != null ? <> · <span className="fuel-nowrap">{fmtRiel(row.excessRiel)}</span></> : null}
          </>
        )}
      </div>
    </span>
  );
}

function Overpaid({ riel }) {
  return riel ? <span className="fuel-excess is-over">{fmtRiel(riel)}</span> : <span className="muted">—</span>;
}

const A1_AMBER = FUEL_SETTING_FIELDS.find((f) => f.key === 'a1AmberRatio');

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
  // Every flag of the month (the Flags tab), named with the company's lookups.
  const lookups = useFuelLookups({ includeRetired: true });
  const flagList = useMemo(() => sortFlags(report?.flagList || []), [report]);
  const [flagPage, setFlagPage] = useState(0);
  const [flagPageSize, setFlagPageSize] = useState(25);
  useEffect(() => { setFlagPage(0); }, [report, flagPageSize]);

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
  const assets = rankDrivers(report?.assets);
  const fp = paginate(flagList.length, flagPage, flagPageSize);
  const amberPct = settingToDisplay(A1_AMBER, lookups.settings?.a1AmberRatio ?? A1_AMBER.def);
  const suspected = totalSuspectedLoss(report?.assets);
  const explain = (
    <p className="muted fuel-note fuel-explain">
      Suspected loss = fuel used more than {amberPct}% above a vehicle's normal (smaller differences are normal variation), valued at what the
      fuel cost, plus cash paid above the posted pump price. Excess counts all fuel above normal. Only full-to-full fills that closed this month count.
    </p>
  );
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
        <div className={`stat-card${suspected > 0 ? ' fuel-stat--rose' : ''}`}>
          <div className="stat-card__label">Suspected loss</div>
          <div className="stat-card__value">{t ? fmtRiel(suspected) : '—'}</div>
          <div className="stat-card__hint">{t ? `Excess ${fmtRiel(t.excessRiel)} · cash above pump price ${fmtRiel(t.cashOverpaidRiel ?? 0)}` : 'Above normal variation + cash overpaid'}</div>
        </div>
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
          assets.length ? (
            <>
              <div className="data-table-wrap">
                <table className="data-table">
                  {/* 1280 px fit: litres carry their split, value carries the cash
                      paid and the cost per km/h, actual sits over normal. */}
                  <thead><tr><th>Vehicle or machine</th><th className="is-num">Distance</th><th className="is-num" title="Tank / farm / cash under the total">Litres</th><th className="is-num" title="Cash paid and cost per km or hour under the value">Value</th><th className="is-num" title="Actual over the vehicle's normal">Use</th><th className="is-num" title="Fuel above normal variation, in riel, plus cash paid above the posted pump price">Suspected loss</th><th>Flags</th></tr></thead>
                  <tbody>
                    {assets.map((a) => (
                      <tr key={a.assetId}>
                        <td><strong>{a.name}</strong><div className="muted">{[a.plateOrSerial, a.typeName].filter(Boolean).join(' · ')}</div></td>
                        <td className="is-num">{a.distance != null ? `${fmtNumber(a.distance, 1)} ${a.meterUnit === 'hours' ? 'h' : 'km'}` : '—'}</td>
                        <td className="is-num">
                          {fmtLitres(a.litres, 1)}
                          <div className="muted" title="Tank / farm / cash">{fmtNumber(a.litresByKind?.warehouse_tank, 0)} / {fmtNumber(a.litresByKind?.farm_store, 0)} / {fmtNumber(a.litresByKind?.cash_station, 0)} · {a.fills} fill{a.fills === 1 ? '' : 's'}</div>
                        </td>
                        <td className="is-num">
                          {fmtRiel(a.valueRiel)}
                          {cashText(a.cashPaid) !== '—' ? <div className="muted">cash {cashText(a.cashPaid)}</div> : null}
                          {a.costPerUnitRiel != null ? <div className="muted">{fmtRiel(a.costPerUnitRiel)} per {a.meterUnit === 'hours' ? 'h' : 'km'}</div> : null}
                        </td>
                        <td className="is-num">
                          {a.actualRate != null ? fmtNumber(a.actualRate, 2) : '—'}<span className="muted"> / {a.baseline != null ? fmtNumber(a.baseline, 2) : '—'}</span>
                          <div className="muted">{a.rateUnit}</div>
                        </td>
                        {/* 1280 px fit: the cash paid above the pump price is a line of
                            the suspected loss (it is part of it), not its own column. */}
                        <td className="is-num"><SuspectedLoss row={a} withCash /></td>
                        <td>{a.openFlags ? <Badge tone={a.redFlags ? 'rose' : 'amber'}>{a.openFlags} open</Badge> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {explain}
            </>
          ) : <EmptyState title="No vehicles yet" body="Add vehicles and machines, and their fill-ups will be summed here." />
        ) : view === 'drivers' ? (
          drivers.length ? (
            <>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>#</th><th>Driver</th><th className="is-num">Litres</th><th className="is-num">Distance</th><th className="is-num">Suspected loss</th><th className="is-num" title="Cash paid above the posted pump price; total cash paid under it">Cash above pump price</th><th>Vehicles</th><th>Flags</th></tr></thead>
                  <tbody>
                    {drivers.map((d, i) => (
                      <tr key={d.employeeId || 'none'}>
                        <td className="muted">{i + 1}</td>
                        <td><strong>{d.employeeId ? d.name : 'No driver recorded'}</strong>{d.staffCode ? <div className="muted">{d.staffCode}</div> : null}</td>
                        <td className="is-num">{fmtLitres(d.litres, 1)}<div className="muted">{d.fills} fill{d.fills === 1 ? '' : 's'}</div></td>
                        <td className="is-num">{d.distanceKm ? `${fmtNumber(d.distanceKm, 0)} km` : ''}{d.hours ? `${d.distanceKm ? ' · ' : ''}${fmtNumber(d.hours, 1)} h` : ''}{!d.distanceKm && !d.hours ? '—' : ''}</td>
                        <td className="is-num"><SuspectedLoss row={d} /></td>
                        <td className="is-num"><Overpaid riel={d.cashOverpaidRiel} />{cashText(d.cashPaid) !== '—' ? <div className="muted">of {cashText(d.cashPaid)}</div> : null}</td>
                        <td>{(d.assets || []).map((a) => a.name).join(', ')}</td>
                        <td>{d.openFlags ? <Badge tone="amber">{d.openFlags} open</Badge> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {explain}
            </>
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
                        <td className="fuel-nowrap">{k.lastDip ? fmtShort(k.lastDip.takenAt) : <span className="muted">never</span>}</td>
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
            <>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Rule</th><th className="is-num">Red</th><th className="is-num">Amber</th><th className="is-num">Info</th><th className="is-num">Still open</th><th className="is-num">Answered</th><th className="is-num">No longer firing</th><th className="is-num">Total</th></tr></thead>
                  <tbody>
                    {report.flags.map((f) => (
                      <tr key={f.ruleKey}>
                        <td><strong>{ruleTitle(f.ruleKey)}</strong> <span className="muted">({f.ruleKey})</span></td>
                        <td className="is-num">{f.red || '—'}</td>
                        <td className="is-num">{f.amber || '—'}</td>
                        <td className="is-num">{f.info || '—'}</td>
                        <td className="is-num">{f.open || '—'}</td>
                        <td className="is-num">{((f.explained || 0) + (f.confirmed || 0) + (f.dismissed || 0)) || '—'}</td>
                        <td className="is-num">{f.resolved || '—'}</td>
                        <td className="is-num">{f.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 className="section-title fuel-subhead">Every flag this month</h3>
              <ul className="fuel-flag-list">
                {flagList.slice(fp.pageStart, fp.pageEnd).map((f) => {
                  const st = flagStatusBadge(f);
                  return (
                    <li key={f.id} className={`fuel-flag fuel-flag--${f.severity}${f.resolved && f.status === 'open' ? ' is-quiet' : ''}`}>
                      <div className="fuel-flag__main">
                        <div className="fuel-flag__title"><SeverityBadge severity={f.severity} /><strong>{flagHeadline(f, lookups.maps)}</strong><Badge tone={st.tone}>{st.label}</Badge></div>
                        <p className="fuel-flag__why">{f.explanation}</p>
                        <p className="fuel-flag__meta muted">{ruleTitle(f.ruleKey)} ({f.ruleKey}) · {f.at ? fmtDay(f.at) : '—'}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <Pagination total={flagList.length} pageStart={fp.pageStart} pageEnd={fp.pageEnd} currentPage={fp.currentPage} maxPage={fp.maxPage} pageSize={flagPageSize} onPageChange={setFlagPage} onPageSizeChange={setFlagPageSize} />
            </>
          ) : <EmptyState title="No flags this month" body="Every check passed." />
        )
      )}
    </div>
  );
}
