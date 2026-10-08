/**
 * Fixed Assets — Tax year (docs/ASSETS_AND_BRANCHES_PLAN.md §4.3, §13a): the
 * Cambodian classes in riel, never posted. Classes 2–4 as pools (opening,
 * additions, proceeds, base, depreciation, closing), Class 1 / 1b /
 * intangible per asset, and the book-versus-tax worksheet. There is no
 * accountant yet (§13a), so the first year's opening pools are the app's
 * ESTIMATE from purchase history — said plainly and prominently. Setting an
 * opening needs assets.manage; marking a year filed (or un-filing it) is the
 * admin's.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { formatDateTime } from '../../lib/format.js';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { ReasonModal } from '../Fuel/FuelShared.jsx';
import { openAssetPage, useAssetCaps, useAssetLookups, useAssetsTick } from './assetsHooks.js';
import { LoadError, NeedsCapNote, Notice } from './AssetsShared.jsx';
import { errText, fmtKhr, fmtUsd, hasUnconfirmedEstimate, parseMoney, poolRows, taxClassLabel, taxYears } from './assetsModel.js';

const TZ = { timeZone: 'Asia/Phnom_Penh' };

export function AssetTaxYear() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useAssetCaps();
  const lookups = useAssetLookups();
  const tick = useAssetsTick(['tax', 'asset', 'run', 'fx', 'settings']);
  const years = useMemo(() => taxYears(lookups.settings?.registerStartDate), [lookups.settings?.registerStartDate]);
  const [year, setYear] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [opening, setOpening] = useState(null); // pool row being set
  const [unfiling, setUnfiling] = useState(false);

  useEffect(() => { setData(null); setYear(null); }, [activeCompanyId]);
  const shownYear = year ?? years[0] ?? null;
  useEffect(() => {
    if (!activeCompanyId || !caps.canView || !shownYear) return undefined;
    let alive = true;
    setError(null);
    window.api.assets.getTaxYear(shownYear).then((d) => { if (alive) setData(d); }).catch((err) => { if (alive) { setData(null); setError(errText(err)); } });
    return () => { alive = false; };
  }, [activeCompanyId, caps.canView, shownYear, tick, retry]);

  if (!activeCompanyId) return <div className="page"><PageHeader title="Tax year" /><NoCompanyState purpose="see its tax depreciation" /></div>;
  if (!caps.canView) return <div className="page"><PageHeader title="Tax year" /><NeedsCapNote what="tax depreciation" /></div>;

  const pools = poolRows(data);
  const unconfirmed = hasUnconfirmedEstimate(data);
  const isFirst = data && data.year === data.firstYear;

  async function markFiled() {
    const ok = await confirm({
      title: `Mark ${shownYear} as filed?`,
      message: 'The figures are frozen as filed. Later changes are listed as "changed since filing" for the accountant to decide on; the filed figures never move.',
      confirmLabel: 'Mark filed',
    });
    if (!ok) return;
    try { await window.api.assets.markTaxYearFiled(shownYear); addToast(`${shownYear} marked as filed`, 'success'); setRetry((n) => n + 1); }
    catch (err) { addToast(errText(err), 'error'); }
  }

  return (
    <div className="page page--assets">
      <PageHeader
        title="Tax year"
        subtitle="Tax depreciation by the Cambodian classes, in riel. Worked out for the return — never posted."
        actions={(
          <>
            <Select aria-label="Tax year" value={shownYear ? String(shownYear) : ''} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
            {caps.isAdmin && data && !data.filed ? <Button variant="primary" onClick={markFiled} disabled={unconfirmed} title={unconfirmed ? 'An estimated opening pool must be confirmed by an accountant first' : undefined}>Mark year filed…</Button> : null}
            {caps.isAdmin && data?.filed ? <Button onClick={() => setUnfiling(true)}>Unfile…</Button> : null}
          </>
        )}
      />

      <Notice tone="amber" title="Estimate — confirm with an accountant.">
        No accountant has checked these figures yet. The class rates and rules come from published summaries of Cambodian tax law, and {isFirst ? 'this first year opens with pools the app estimated from what each asset cost' : 'the pools carry on from the year before'}. Treat every number here as an estimate until an accountant confirms it.
      </Notice>

      {error ? <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} /> : null}
      {!data && !error ? <p className="muted">Loading…</p> : null}

      {data ? (
        <>
          {data.filed ? (
            <Notice tone="slate" title={`${data.year} is filed.`}>
              Filed {formatDateTime(data.filed.filedAt, TZ)}. The figures below are worked out again from today's data{data.changedSinceFiling?.length ? ' — and they differ from what was filed:' : ', and match what was filed.'}
              {data.changedSinceFiling?.length ? (
                <ul className="assets-list">
                  {data.changedSinceFiling.map((c, i) => <li key={i}>Class {c.taxClass}, {fieldLabel(c.field)}: {fmtKhr(c.filedKhr)} filed, now {fmtKhr(c.nowKhr)} ({c.differenceKhr > 0 ? '+' : ''}{fmtKhr(c.differenceKhr)})</li>)}
                </ul>
              ) : null}
            </Notice>
          ) : null}

          <section className="assets-section">
            <div className="section-head">
              <h2 className="section-title">Pools — Classes 2, 3 and 4</h2>
              <span className="section-hint">Declining balance on the pool: opening + additions − proceeds, times the class rate.</span>
            </div>
            <div className="data-table-wrap">
              <table className="data-table assets-pools">
                <thead><tr><th>Pool</th><th className="is-num">Opening</th><th>Opening from</th><th className="is-num">Additions</th><th className="is-num">Proceeds</th><th className="is-num">Base</th><th className="is-num">Depreciation</th><th className="is-num">Gain / loss</th><th className="is-num">Closing</th>{caps.canManage && isFirst ? <th className="is-actions" aria-label="Actions" /> : null}</tr></thead>
                <tbody>
                  {pools.map((p) => (
                    <tr key={p.taxClass}>
                      <td><strong>{p.label || taxClassLabel(p.taxClass)}</strong><div className="muted">{p.assets ?? 0} asset{p.assets === 1 ? '' : 's'}</div></td>
                      <td className="is-num">{fmtKhr(p.openingWdvKhr)}</td>
                      <td>
                        <Badge tone={p.source.tone}>{p.source.label}</Badge>
                        {p.openingSource === 'estimate' ? <div className="assets-estimate">{p.openingLabel || 'estimate — confirm with an accountant'}</div> : null}
                        {p.confirmedByAccountant ? <div className="muted">Confirmed by an accountant</div> : null}
                      </td>
                      <td className="is-num">{fmtKhr(p.additionsKhr)}</td>
                      <td className="is-num">{p.proceedsKhr ? fmtKhr(-p.proceedsKhr) : fmtKhr(0)}</td>
                      <td className="is-num">{fmtKhr(p.baseKhr)}</td>
                      <td className="is-num"><strong>{fmtKhr(p.depreciationKhr)}</strong><div className="muted">{(p.rateBp || 0) / 100} %</div></td>
                      <td className="is-num">{p.gainKhr ? <span className="assets-gain">gain {fmtKhr(p.gainKhr)}</span> : p.lossKhr ? <span className="assets-loss">loss {fmtKhr(p.lossKhr)}</span> : '—'}</td>
                      <td className="is-num">{fmtKhr(p.closingWdvKhr)}</td>
                      {caps.canManage && isFirst ? <td className="is-actions"><Button size="sm" variant="ghost" onClick={() => setOpening(p)} disabled={!!data.filed}>Set opening…</Button></td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {isFirst ? <p className="muted">The first year's openings come from the last Tax on Income return, per class. With no accountant yet, the app estimates them by running each asset's cost through the class rules from the year it was bought. Enter the real figures here once an accountant gives them.</p> : null}
          </section>

          <section className="assets-section">
            <div className="section-head">
              <h2 className="section-title">Class 1, 1b and intangibles — per asset</h2>
              <span className="section-hint">Straight-line on each asset: a full year in the year bought, none in the year sold.</span>
            </div>
            {!data.perAsset?.length ? <p className="muted">No buildings or intangibles this year.</p> : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Tag</th><th>Name</th><th>Class</th><th className="is-num">Tax cost</th><th className="is-num">Depreciation</th><th className="is-num">Written-down value</th><th className="is-num">Proceeds</th><th className="is-num">Gain / loss</th></tr></thead>
                  <tbody>
                    {data.perAsset.map((a) => (
                      <tr key={a.assetId || a.tagCode} className="is-clickable" onClick={() => a.assetId && openAssetPage(a.assetId, activeCompanyId)}>
                        <td><strong>{a.tagCode}</strong></td><td>{a.name}</td><td>{a.taxClass}</td>
                        <td className="is-num">{fmtKhr(a.costKhr)}</td><td className="is-num">{fmtKhr(a.depreciationKhr)}</td><td className="is-num">{fmtKhr(a.wdvKhr)}</td>
                        <td className="is-num">{a.proceedsKhr != null ? fmtKhr(a.proceedsKhr) : '—'}</td><td className="is-num">{a.gainLossKhr != null ? fmtKhr(a.gainLossKhr) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="assets-section">
            <div className="section-head">
              <h2 className="section-title">Book versus tax</h2>
              <span className="section-hint">The add-back worksheet: book depreciation is added back, tax depreciation deducted.</span>
            </div>
            {!data.bookVsTax?.length ? <EmptyState title="Nothing depreciated this year" /> : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Class</th><th className="is-num">Book (USD)</th><th className="is-num">Book (riel, as posted)</th><th className="is-num">Tax (riel)</th><th className="is-num">Tax − book</th></tr></thead>
                  <tbody>
                    {data.bookVsTax.map((r) => (
                      <tr key={r.taxClass}><td>{r.label || taxClassLabel(r.taxClass)}</td><td className="is-num">{fmtUsd(r.bookUsdMinor)}</td><td className="is-num">{fmtKhr(r.bookKhr)}</td><td className="is-num">{fmtKhr(r.taxKhr)}</td><td className="is-num">{fmtKhr(r.differenceKhr)}</td></tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td>Total</td><td className="is-num">{fmtUsd(data.totals?.bookDepreciationUsdMinor)}</td><td className="is-num">{fmtKhr(data.totals?.bookDepreciationKhr)}</td><td className="is-num">{fmtKhr(data.totals?.taxDepreciationKhr)}</td><td className="is-num">{fmtKhr((data.totals?.taxDepreciationKhr || 0) - (data.totals?.bookDepreciationKhr || 0))}</td></tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          {data.notes?.length ? (
            <section className="assets-section">
              <h2 className="section-title">Notes</h2>
              <ul className="assets-list">{data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </section>
          ) : null}
        </>
      ) : null}

      {opening ? <PoolOpeningModal year={shownYear} pool={opening} onClose={() => setOpening(null)} onSaved={() => { setOpening(null); addToast('Opening pool saved', 'success'); setRetry((n) => n + 1); }} /> : null}
      <ReasonModal
        open={unfiling}
        title={`Unfile ${shownYear}?`}
        message="The frozen figures are kept in History; the year can be changed and filed again."
        confirmLabel="Unfile"
        danger
        onCancel={() => setUnfiling(false)}
        onConfirm={async (reason) => { await window.api.assets.unfileTaxYear(shownYear, reason); setUnfiling(false); addToast(`${shownYear} is no longer marked filed`, 'success'); setRetry((n) => n + 1); }}
      />
    </div>
  );
}

function fieldLabel(f) {
  return { depreciationKhr: 'depreciation', closingWdvKhr: 'closing', additionsKhr: 'additions', proceedsKhr: 'proceeds' }[f] || f;
}

function PoolOpeningModal({ year, pool, onClose, onSaved }) {
  const [amount, setAmount] = useState(pool.openingSource === 'entered' ? String(pool.openingWdvKhr ?? '') : '');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(!!pool.confirmedByAccountant);
  const [kind, setKind] = useState(pool.openingSource === 'estimate' ? 'estimate' : 'return');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const money = parseMoney(kind === 'estimate' ? String(pool.estimateKhr ?? 0) : amount, 'KHR', { label: 'Opening' });
  async function save() {
    if (money.error || money.minor == null) { setError(money.error || 'Type the opening balance in riel'); return; }
    setBusy(true); setError('');
    try {
      await window.api.assets.setPoolOpening({
        year, taxClass: String(pool.taxClass), openingWdvKhrMinor: money.minor, sourceNote: note.trim() || undefined,
        confirmedByAccountant: confirmed, isEstimate: kind === 'estimate',
      });
      onSaved();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Opening pool — ${pool.label || `Class ${pool.taxClass}`}, ${year}`} busy={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save opening'}</Button></>}>
      {error ? <Notice tone="rose">{error}</Notice> : null}
      <div className="segments" role="tablist" aria-label="Where the opening comes from">
        <button type="button" className={`segment${kind === 'return' ? ' is-active' : ''}`} onClick={() => setKind('return')}>From the last tax return</button>
        <button type="button" className={`segment${kind === 'estimate' ? ' is-active' : ''}`} onClick={() => setKind('estimate')}>Keep the app's estimate</button>
      </div>
      <div className="assets-form">
        {kind === 'return' ? (
          <Field label="Written-down value at the start of the year (riel)" hint="The closing pool for this class on the last Tax on Income return.">
            {({ id }) => <Input id={id} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />}
          </Field>
        ) : (
          <p className="assets-modal-text">The estimate is {fmtKhr(pool.estimateKhr)}: each asset's cost at the official rate, run through the class rules from the year it was bought. It stays labelled “estimate — confirm with an accountant”.</p>
        )}
        <Field label="Where it came from (optional)" hint='e.g. "ToI return 2025, line 41".'>{({ id }) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <label className="assets-check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>An accountant has confirmed this figure</span>
        </label>
        <p className="muted">A year can be marked filed only when every estimated opening is confirmed by an accountant.</p>
      </div>
    </Modal>
  );
}
