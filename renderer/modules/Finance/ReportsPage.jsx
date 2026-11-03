/**
 * Finance → Reports: one month at a time. Expenses by branch and by category,
 * the money waiting for approval (shown separately — it is not recorded yet),
 * and what every money account holds. Tables only; no charts (FINANCE_PLAN §7).
 *
 * A recorded USD balance follows the journal. It is not a live bank balance,
 * and a native KHR balance is shown as recorded with its USD context.
 */

import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { EmptyState, Input } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useFinanceContext, useFinanceTick } from './financeHooks.js';
import { errText, formatMinor, formatUsdMinor } from './financeModel.js';

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthTitle(key) {
  const [y, m] = String(key || '').split('-').map(Number);
  if (!y || !m) return key || '';
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function FinanceReports() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const context = useFinanceContext();
  const tick = useFinanceTick();
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const companyRef = useRef(activeCompanyId);

  useEffect(() => {
    if (companyRef.current === activeCompanyId) return;
    companyRef.current = activeCompanyId;
    setData(null);
    setMonth(thisMonth());
  }, [activeCompanyId]);

  useEffect(() => {
    if (!activeCompanyId || !context.loaded || !context.permissions?.canViewAll) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.finance.reports({ month })
      .then((res) => { if (alive) { setData(res); setError(''); } })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, context.loaded, context.permissions?.canViewAll, month, tick]);

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Reports" /><p className="muted">Choose a company first.</p></div>;
  }
  if (!context.loaded) return <div className="page"><p className="muted">Loading Finance…</p></div>;
  if (!context.permissions?.canViewAll) {
    return <div className="page"><PageHeader title="Reports" /><p className="muted">Only the owner and people with company-wide Finance view can see the monthly reports.</p></div>;
  }

  const rate = data?.rate;
  const empty = !loading && !error && !(data?.byBranch?.length) && !(data?.byCategory?.length) && !data?.pending?.count && !(data?.accounts?.length);

  return (
    <div className="page finance-page">
      <PageHeader
        title="Reports"
        subtitle={`Recorded expenses for ${monthTitle(month)}.`}
        actions={<Input type="month" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} />}
      />

      {rate?.khrPerUsd ? (
        <p className="muted finance-hint">Current company rate: {Number(rate.khrPerUsd).toLocaleString()} riel per dollar{rate.rateDate ? ` (${rate.rateDate})` : ''}. Recorded USD amounts keep the rate used when posted.</p>
      ) : null}

      {error ? <LoadError message={error} onRetry={() => window.location.reload()} /> : null}
      {loading ? <p className="muted">Loading the report…</p> : null}

      {empty ? (
        <EmptyState title={`Nothing recorded in ${monthTitle(month)}.`} body="Recorded expenses appear here, grouped by branch and by category." />
      ) : null}

      {data ? (
        <>
          <section className="finance-section">
            <h2 className="section-title">Waiting for approval</h2>
            <div className="finance-pending">
              <strong>{data.pending?.count || 0}</strong>
              <span className="muted">expense{data.pending?.count === 1 ? '' : 's'} not yet recorded</span>
              <span className="finance-pending__amount">{formatUsdMinor(data.pending?.totalUsdMinor || 0)}</span>
            </div>
            <p className="muted finance-hint">These are not in the ledger and are not counted in the totals below.</p>
          </section>

          <section className="finance-section">
            <h2 className="section-title">By branch</h2>
            {data.byBranch?.length ? (
              <div className="data-table-wrap">
                <table className="data-table finance-table">
                  <thead><tr><th>Branch</th><th className="is-num">Recorded</th></tr></thead>
                  <tbody>
                    {data.byBranch.map((r) => <tr key={r.id}><td>{r.name}</td><td className="is-num">{formatUsdMinor(r.totalUsdMinor)}</td></tr>)}
                  </tbody>
                  <tfoot><tr><th>Total</th><th className="is-num">{formatUsdMinor(data.byBranch.reduce((s, r) => s + (r.totalUsdMinor || 0), 0))}</th></tr></tfoot>
                </table>
              </div>
            ) : <p className="muted">Nothing recorded this month.</p>}
          </section>

          <section className="finance-section">
            <h2 className="section-title">By category</h2>
            {data.byCategory?.length ? (
              <div className="data-table-wrap">
                <table className="data-table finance-table">
                  <thead><tr><th>Category</th><th className="is-num">Recorded</th></tr></thead>
                  <tbody>
                    {data.byCategory.map((r) => <tr key={r.id}><td>{r.name}</td><td className="is-num">{formatUsdMinor(r.totalUsdMinor)}</td></tr>)}
                  </tbody>
                  <tfoot><tr><th>Total</th><th className="is-num">{formatUsdMinor(data.byCategory.reduce((s, r) => s + (r.totalUsdMinor || 0), 0))}</th></tr></tfoot>
                </table>
              </div>
            ) : <p className="muted">Nothing recorded this month.</p>}
          </section>

          <section className="finance-section">
            <h2 className="section-title">Money accounts</h2>
            {data.accounts?.length ? (
              <div className="data-table-wrap">
                <table className="data-table finance-table">
                  <thead><tr><th>Account</th><th>Currency</th><th className="is-num">Recorded balance</th><th className="is-num">In USD</th></tr></thead>
                  <tbody>
                    {data.accounts.map((a) => (
                      <tr key={a.id}>
                        <td>{a.name}</td>
                        <td>{a.currency}</td>
                        <td className="is-num">{a.balanceMinor == null ? '—' : formatMinor(a.balanceMinor, a.currency)}</td>
                        <td className="is-num muted">{a.balanceUsdMinor == null ? '—' : formatUsdMinor(a.balanceUsdMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">No money accounts yet.</p>}
            <p className="muted finance-hint">Recorded balances follow the ledger. They are not a live bank balance.</p>
          </section>
        </>
      ) : null}
    </div>
  );
}
