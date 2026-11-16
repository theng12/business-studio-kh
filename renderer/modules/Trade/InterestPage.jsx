/**
 * Trade Finance → Interest: what has accrued and what has been recorded.
 *
 * "Accrued now" integrates the outstanding principal day by day since the
 * last recorded charge, so a part-repayment mid-period is handled exactly.
 * It is an estimate until the bank bills; the recorded interest below is the
 * real figure at the moment it was charged.
 *
 * Phase A records interest when it is paid with a repayment. Month-end
 * capitalisation for running-balance facilities and comparing the bank's
 * actual charge arrive in a later phase.
 */

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Badge, EmptyState, Pagination } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { usePager } from '../People/hrHooks.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useTradeContext, useTradeTick } from './tradeHooks.js';
import { errText, formatMinor, formatRate } from './tradeModel.js';

export function TradeInterest() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const context = useTradeContext();
  const tick = useTradeTick();
  const [preview, setPreview] = useState([]);
  const [postings, setPostings] = useState({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { page, setPage, pageSize, setPageSize } = usePager([activeCompanyId, tick]);

  useEffect(() => {
    if (!activeCompanyId || !context.loaded || !context.permissions.canView) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    Promise.all([
      window.api.trade.interest.preview(),
      window.api.trade.interest.list({ page: page + 1, pageSize }),
    ])
      .then(([accrued, recorded]) => {
        if (!alive) return;
        setPreview(Array.isArray(accrued) ? accrued : []);
        setPostings({ rows: recorded?.rows || [], total: recorded?.total || 0 });
        setError('');
      })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, context.loaded, context.permissions.canView, page, pageSize, tick]);

  const accruedTotals = useMemo(() => {
    const out = {};
    for (const r of preview) out[r.currency] = (out[r.currency] || 0) + r.accruedMinor;
    return out;
  }, [preview]);

  if (!activeCompanyId) return <div className="page"><PageHeader title="Interest" /><p className="muted">Choose a company first.</p></div>;
  if (!context.loaded) return <div className="page"><p className="muted">Loading Trade Finance…</p></div>;
  if (context.error) return <div className="page"><PageHeader title="Interest" /><LoadError message={context.error} onRetry={() => window.location.reload()} /></div>;

  const pager = {
    total: postings.total, currentPage: page,
    maxPage: Math.max(0, Math.ceil(postings.total / pageSize) - 1),
    pageStart: page * pageSize,
    pageEnd: Math.min(page * pageSize + pageSize, postings.total),
    pageSize,
  };

  return (
    <div className="page tf-page">
      <PageHeader
        title="Interest"
        subtitle="What each drawdown has accrued since the last charge, and every interest figure recorded."
      />

      {error ? <p className="field__error">Couldn't load the interest record: {error}</p> : null}

      {Object.keys(accruedTotals).length ? (
        <div className="tf-cards">
          {Object.entries(accruedTotals).map(([currency, minor]) => (
            <div className="tf-card" key={currency}>
              <span className="tf-card__label">Accrued now — {currency}</span>
              <span className="tf-card__value">{formatMinor(minor, currency)}</span>
              <span className="muted">an estimate until the bank bills</span>
            </div>
          ))}
        </div>
      ) : null}

      <section className="finance-section">
        <h2 className="section-title">Accrued now</h2>
        {!loading && !preview.length ? (
          <p className="muted">Nothing is accruing: no active drawdown has an outstanding balance.</p>
        ) : preview.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Facility</th><th>Drawdown</th><th>Since</th><th className="is-num">Days</th><th className="is-num">Outstanding</th><th className="is-num">Accrued</th></tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.drawdownId}>
                    <td>{r.facilityName}</td>
                    <td>{r.reference || <span className="muted">No reference</span>}<div className="muted tf-sub">{r.maturityDate ? `Matures ${r.maturityDate}` : 'No maturity'}</div></td>
                    <td>{r.from}</td>
                    <td className="is-num">{r.days}</td>
                    <td className="is-num">{formatMinor(r.outstandingMinor, r.currency)}</td>
                    <td className="is-num">{formatMinor(r.accruedMinor, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="muted finance-hint">The daily balance is integrated across part-repayments. The bank's actual charge can differ by rounding or its own day-count convention.</p>
      </section>

      <section className="finance-section">
        <h2 className="section-title">Recorded interest</h2>
        {!loading && !postings.rows.length ? (
          <EmptyState title="No interest recorded yet." body="Interest is recorded when it is paid with a repayment." />
        ) : postings.rows.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Period</th><th>Facility</th><th>Drawdown</th><th className="is-num">Basis</th><th className="is-num">Rate</th><th className="is-num">Days</th><th className="is-num">Interest</th><th>Source</th></tr>
              </thead>
              <tbody>
                {postings.rows.map((p) => (
                  <tr key={p.id}>
                    <td>{p.periodStart} → {p.periodEnd}</td>
                    <td>{p.facilityName}</td>
                    <td>{p.drawdownReference || <span className="muted">Facility</span>}</td>
                    <td className="is-num">{formatMinor(p.basisMinor, p.currency)}</td>
                    <td className="is-num">{formatRate(p.rate)}</td>
                    <td className="is-num">{p.days}</td>
                    <td className="is-num">{formatMinor(p.amountMinor, p.currency)}</td>
                    <td><Badge tone={p.source === 'bank_actual' ? 'amber' : 'slate'}>{p.source === 'bank_actual' ? "Bank's figure" : 'Charged'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...pager} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(0); }} />
          </div>
        ) : null}
      </section>

      <p className="muted finance-hint">Month-end capitalisation for overdrafts and comparing the bank's actual charge arrive in a later update.</p>
    </div>
  );
}
