/**
 * Trade Finance → Reports: the lender-side picture.
 *
 * Per-bank relationship summary, interest recorded this year, the maturity
 * ladder and the cash-flow forecast of principal plus estimated interest.
 * Every figure is grouped by currency — nothing is summed across currencies
 * without a rate, and the interest-to-maturity part is labelled an estimate.
 */

import { useEffect, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { EmptyState } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useTradeContext, useTradeTick } from './tradeHooks.js';
import { daysLabel, errText, formatMinor, formatPercent, formatRate } from './tradeModel.js';

export function TradeReports() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const context = useTradeContext();
  const tick = useTradeTick();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!activeCompanyId || !context.loaded || !context.permissions.canView) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.trade.reports.summary()
      .then((res) => { if (alive) { setData(res); setError(''); } })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, context.loaded, context.permissions.canView, tick]);

  if (!activeCompanyId) return <div className="page"><PageHeader title="Reports" /><p className="muted">Choose a company first.</p></div>;
  if (!context.loaded) return <div className="page"><p className="muted">Loading Trade Finance…</p></div>;
  if (context.error) return <div className="page"><PageHeader title="Reports" /><LoadError message={context.error} onRetry={() => window.location.reload()} /></div>;

  const empty = !loading && !error && data && !data.perBank?.length && !data.cashflow?.length;

  return (
    <div className="page tf-page">
      <PageHeader
        title="Reports"
        subtitle={data ? `As of ${data.asOf}. Principal and estimated interest, grouped by currency.` : 'The lender-side picture.'}
      />

      {error ? <LoadError message={error} onRetry={() => window.location.reload()} /> : null}
      {loading ? <p className="muted">Building the report…</p> : null}

      {empty ? (
        <EmptyState title="Nothing to report yet." body="Record a facility and a drawdown, and this page fills in." />
      ) : null}

      {data?.perBank?.length ? (
        <section className="finance-section">
          <h2 className="section-title">By bank</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Bank</th><th>Currency</th><th className="is-num">Facilities</th><th className="is-num">Limit</th><th className="is-num">Drawn</th><th>Used</th><th className="is-num">Average rate</th><th className="is-num">Fees</th></tr>
              </thead>
              <tbody>
                {data.perBank.map((r) => (
                  <tr key={`${r.bankId}-${r.currency}`}>
                    <td>{r.bank}</td>
                    <td>{r.currency}</td>
                    <td className="is-num">{r.facilities}</td>
                    <td className="is-num">{formatMinor(r.limitMinor, r.currency)}</td>
                    <td className="is-num">{formatMinor(r.drawnMinor, r.currency)}</td>
                    <td>
                      <div className="tf-meter">
                        <div className="tf-meter__track"><div className="tf-meter__fill" style={{ width: `${Math.min(100, r.utilisation * 100)}%` }} /></div>
                        <span className="tf-meter__label">{formatPercent(r.utilisation)}</span>
                      </div>
                    </td>
                    <td className="is-num">{formatRate(r.avgRate)}</td>
                    <td className="is-num">{formatMinor(r.feesMinor || 0, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted finance-hint">Average rate is weighted by the amount drawn. A fee recorded without a facility is in the year total below, not in a bank row.</p>
        </section>
      ) : null}

      {data?.ytd?.length ? (
        <section className="finance-section">
          <h2 className="section-title">Interest recorded this year</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Currency</th><th className="is-num">Interest</th></tr></thead>
              <tbody>
                {data.ytd.map((r) => <tr key={r.currency}><td>{r.currency}</td><td className="is-num">{formatMinor(r.totalMinor, r.currency)}</td></tr>)}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {data?.ytdFees?.length ? (
        <section className="finance-section">
          <h2 className="section-title">Fees recorded this year</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Currency</th><th className="is-num">Fees</th></tr></thead>
              <tbody>
                {data.ytdFees.map((r) => <tr key={r.currency}><td>{r.currency}</td><td className="is-num">{formatMinor(r.totalMinor, r.currency)}</td></tr>)}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {data?.ladder?.length ? (
        <section className="finance-section">
          <h2 className="section-title">Maturity ladder</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Bucket</th><th>Currency</th><th className="is-num">Principal + estimated interest</th></tr></thead>
              <tbody>
                {data.ladder.flatMap((b) => (b.totals.length
                  ? b.totals.map((t) => (
                    <tr key={`${b.bucket}-${t.currency}`}>
                      <td>{b.bucket}</td>
                      <td>{t.currency}</td>
                      <td className="is-num">{formatMinor(t.totalMinor, t.currency)}</td>
                    </tr>
                  ))
                  : [<tr key={b.bucket}><td>{b.bucket}</td><td className="muted">—</td><td className="is-num muted">Nothing due</td></tr>]))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {data?.cashflow?.length ? (
        <section className="finance-section">
          <h2 className="section-title">Cash-flow forecast</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Maturity</th><th>Facility</th><th>Reference</th><th className="is-num">Principal</th><th className="is-num">Interest (estimate)</th><th className="is-num">Total</th></tr>
              </thead>
              <tbody>
                {data.cashflow.map((r) => (
                  <tr key={r.drawdownId}>
                    <td>{r.maturityDate}<div className="muted tf-sub">{daysLabel(r.daysTo)}</div></td>
                    <td>{r.facility}<div className="muted tf-sub">{r.bank}</div></td>
                    <td>{r.reference || <span className="muted">—</span>}</td>
                    <td className="is-num">{formatMinor(r.principalMinor, r.currency)}</td>
                    <td className="is-num">{formatMinor(r.interestMinor, r.currency)}</td>
                    <td className="is-num">{formatMinor(r.totalMinor, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted finance-hint">Interest to maturity uses today's outstanding balance and the drawdown's rate.</p>
        </section>
      ) : null}
    </div>
  );
}
