/**
 * Trade Finance → Interest: what has accrued, what has been recorded, and the
 * Phase B work that belongs to interest — month-end capitalisation, the
 * bank's actual charge compared with ours, fees and recurring fees.
 *
 * "Accrued now" integrates the outstanding principal day by day since the
 * last recorded charge. It is an estimate until the bank bills; the recorded
 * interest below is the real figure at the moment it was charged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Badge, Button, EmptyState, Field, Input, Pagination, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { usePager } from '../People/hrHooks.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useTradeContext, useTradeTick } from './tradeHooks.js';
import {
  COMMITMENT_FREQS, errText, formatMinor, formatRate, newClientId, parseAmount, todayISO,
} from './tradeModel.js';

const FEE_KINDS = ['TT fee', 'Commitment fee', 'Commission', 'Handling', 'Other'];

function StatusBadge({ status }) {
  const tone = status === 'match' ? 'emerald' : status === 'minor' ? 'amber' : 'rose';
  return <Badge tone={tone}>{status === 'match' ? 'Matches' : status === 'minor' ? 'Small difference' : 'Review'}</Badge>;
}

function CapitalisationSection({ tick }) {
  const [due, setDue] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  const load = useCallback(() => {
    window.api.trade.capitalisation.preview()
      .then((rows) => { setDue(Array.isArray(rows) ? rows : []); setError(''); })
      .catch((err) => setError(errText(err)));
  }, []);
  useEffect(() => { load(); }, [load, tick]);

  async function run() {
    const ok = await confirm({
      title: 'Charge the outstanding months?',
      message: 'Each completed month below is posted once, and the interest is added to the balance so the next month compounds. Re-running changes nothing already charged.',
      confirmLabel: 'Charge these months',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const rows = await window.api.trade.capitalisation.run();
      addToast(`${rows.length} month${rows.length === 1 ? '' : 's'} charged`, 'success');
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="finance-section">
      <h2 className="section-title">Month-end capitalisation</h2>
      {error ? <p className="field__error">{error}</p> : null}
      {due === null ? <p className="muted">Checking the overdrafts…</p> : null}
      {due && !due.length ? <p className="muted">No completed month is waiting to be charged.</p> : null}
      {due && due.length ? (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Facility</th><th>Month</th><th className="is-num">Days</th><th className="is-num">Average balance</th><th className="is-num">Interest</th></tr></thead>
              <tbody>
                {due.map((r) => (
                  <tr key={`${r.facilityId}-${r.period}`}>
                    <td>{r.facilityName}</td>
                    <td>{r.period}</td>
                    <td className="is-num">{r.days}</td>
                    <td className="is-num">{formatMinor(r.basisMinor, r.currency)}</td>
                    <td className="is-num">{formatMinor(r.amountMinor, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="tf-editor-actions">
            <Button variant="primary" onClick={run} disabled={busy}>{busy ? 'Charging…' : 'Charge these months'}</Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ReconciliationSection({ facilities, tick }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ facilityId: '', periodStart: '', periodEnd: todayISO(), amount: '', note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const addToast = useAppStore((s) => s.addToast);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const load = useCallback(() => {
    window.api.trade.reconciliation.list()
      .then((list) => { setRows(Array.isArray(list) ? list : []); setError(''); })
      .catch((err) => setError(errText(err)));
  }, []);
  useEffect(() => { load(); }, [load, tick]);

  const facility = facilities.find((f) => f.id === form.facilityId) || null;
  const currency = facility?.currency || 'USD';

  async function add() {
    setError('');
    if (!form.facilityId) { setError('Choose the facility.'); return; }
    if (!form.periodStart || !form.periodEnd) { setError('Enter the period the bank charged for.'); return; }
    const amount = parseAmount(form.amount, currency);
    if (!amount.ok) { setError(amount.error); return; }
    setBusy(true);
    try {
      const list = await window.api.trade.reconciliation.add({
        facilityId: form.facilityId,
        periodStart: form.periodStart,
        periodEnd: form.periodEnd,
        amountMinor: amount.minor,
        note: form.note.trim() || null,
      });
      setRows(Array.isArray(list) ? list : []);
      setForm((f) => ({ ...f, amount: '', note: '' }));
      addToast('Bank charge recorded', 'success');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="finance-section">
      <h2 className="section-title">The bank's charge, compared with ours</h2>
      {error ? <p className="field__error">{error}</p> : null}
      {rows.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Period</th><th>Facility</th><th className="is-num">Bank</th><th className="is-num">Ours</th><th className="is-num">Difference</th><th>Result</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.periodStart} → {r.periodEnd}</td>
                  <td>{r.facilityName}<div className="muted tf-sub">{r.drawdownReference || 'Whole facility'}</div></td>
                  <td className="is-num">{formatMinor(r.bankMinor, r.currency)}</td>
                  <td className="is-num">{formatMinor(r.oursMinor, r.currency)}</td>
                  <td className="is-num">{formatMinor(r.varianceMinor, r.currency)}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No bank charge recorded yet.</p>}

      <div className="tf-repayment-form">
        <Field label="Facility">
          <Select value={form.facilityId} onChange={(e) => set('facilityId', e.target.value)} disabled={busy}>
            <option value="">Choose…</option>
            {facilities.map((f) => <option key={f.id} value={f.id}>{f.bankName} — {f.name}</option>)}
          </Select>
        </Field>
        <Field label="Period start">
          <Input type="date" value={form.periodStart} onChange={(e) => set('periodStart', e.target.value)} disabled={busy} />
        </Field>
        <Field label="Period end">
          <Input type="date" value={form.periodEnd} onChange={(e) => set('periodEnd', e.target.value)} disabled={busy} />
        </Field>
        <Field label={`Bank charged (${currency})`}>
          <Input inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} disabled={busy} />
        </Field>
        <Button variant="primary" onClick={add} disabled={busy}>{busy ? 'Saving…' : 'Record bank charge'}</Button>
      </div>
      <p className="muted finance-hint">Ours integrates the daily balance across the period. A small difference is expected from rounding or the bank's own day count.</p>
    </section>
  );
}

function FeesSection({ facilities, tick }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ facilityId: '', kind: FEE_KINDS[0], amount: '', currency: 'USD', feeDate: todayISO(), note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clientId = useRef(newClientId());
  const addToast = useAppStore((s) => s.addToast);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const load = useCallback(() => {
    window.api.trade.fees.list({})
      .then((list) => { setRows(Array.isArray(list) ? list : []); setError(''); })
      .catch((err) => setError(errText(err)));
  }, []);
  useEffect(() => { load(); }, [load, tick]);

  const facility = facilities.find((f) => f.id === form.facilityId) || null;
  const currency = form.currency || facility?.currency || 'USD';

  async function add() {
    setError('');
    const amount = parseAmount(form.amount, currency);
    if (!amount.ok) { setError(amount.error); return; }
    setBusy(true);
    try {
      const row = await window.api.trade.fees.add({
        clientUuid: clientId.current,
        facilityId: form.facilityId || null,
        kind: form.kind,
        amountMinor: amount.minor,
        currency,
        feeDate: form.feeDate,
        note: form.note.trim() || null,
      });
      clientId.current = newClientId();
      setRows((list) => [row, ...list]);
      setForm((f) => ({ ...f, amount: '', note: '' }));
      addToast('Fee recorded', 'success');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="finance-section">
      <h2 className="section-title">Fees</h2>
      {error ? <p className="field__error">{error}</p> : null}
      {rows.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Date</th><th>What</th><th>Facility</th><th className="is-num">Amount</th><th>Note</th></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td>{f.feeDate}</td>
                  <td>{f.kind}</td>
                  <td>{f.facilityName || <span className="muted">No facility</span>}</td>
                  <td className="is-num">{formatMinor(f.amountMinor, f.currency)}</td>
                  <td className="muted">{f.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No fees recorded yet.</p>}

      <div className="tf-repayment-form">
        <Field label="What">
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value)} disabled={busy}>
            {FEE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
        </Field>
        <Field label={`Amount (${currency})`}>
          <Input inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} disabled={busy} />
        </Field>
        <Field label="Date">
          <Input type="date" value={form.feeDate} onChange={(e) => set('feeDate', e.target.value)} disabled={busy} />
        </Field>
        <Field label="Facility">
          <Select value={form.facilityId} onChange={(e) => {
            const f = facilities.find((x) => x.id === e.target.value);
            setForm((prev) => ({ ...prev, facilityId: e.target.value, currency: f?.currency || prev.currency }));
          }} disabled={busy}>
            <option value="">No facility</option>
            {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </Field>
        <Button variant="primary" onClick={add} disabled={busy}>{busy ? 'Saving…' : 'Add fee'}</Button>
      </div>
    </section>
  );
}

function RecurringSection({ facilities, tick, today }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ facilityId: '', kind: 'Commitment fee', amount: '', currency: 'USD', frequency: 'monthly', nextDate: todayISO(), note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const addToast = useAppStore((s) => s.addToast);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const load = useCallback(() => {
    window.api.trade.recurring.list()
      .then((list) => { setRows(Array.isArray(list) ? list : []); setError(''); })
      .catch((err) => setError(errText(err)));
  }, []);
  useEffect(() => { load(); }, [load, tick]);

  const facility = facilities.find((f) => f.id === form.facilityId) || null;
  const currency = form.currency || facility?.currency || 'USD';
  const dueCount = rows.filter((r) => r.enabled && r.nextDate <= (today || todayISO())).length;

  async function add() {
    setError('');
    const amount = parseAmount(form.amount, currency);
    if (!amount.ok) { setError(amount.error); return; }
    setBusy(true);
    try {
      const list = await window.api.trade.recurring.add({
        facilityId: form.facilityId || null,
        kind: form.kind,
        amountMinor: amount.minor,
        currency,
        frequency: form.frequency,
        nextDate: form.nextDate,
        note: form.note.trim() || null,
      });
      setRows(Array.isArray(list) ? list : []);
      setForm((f) => ({ ...f, amount: '', note: '' }));
      addToast('Recurring fee added', 'success');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row) {
    try {
      const list = await window.api.trade.recurring.update(row.id, { enabled: !row.enabled });
      setRows(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function postDue() {
    const ok = await confirm({
      title: `Post ${dueCount} due fee${dueCount === 1 ? '' : 's'}?`,
      message: 'Every period that has passed is added to Fees. A period already posted is skipped.',
      confirmLabel: 'Post them',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const posted = await window.api.trade.recurring.postDue();
      addToast(`${posted.length} fee period${posted.length === 1 ? '' : 's'} posted`, 'success');
      load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="finance-section">
      <h2 className="section-title">Recurring fees</h2>
      {error ? <p className="field__error">{error}</p> : null}
      {rows.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>What</th><th>Facility</th><th className="is-num">Amount</th><th>How often</th><th>Next</th><th>State</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.kind}</td>
                  <td>{r.facilityName || <span className="muted">No facility</span>}</td>
                  <td className="is-num">{formatMinor(r.amountMinor, r.currency)}</td>
                  <td>{r.frequency}</td>
                  <td>{r.nextDate}</td>
                  <td>{r.enabled ? <Badge tone="emerald">On</Badge> : <Badge tone="slate">Off</Badge>}</td>
                  <td><Button size="sm" onClick={() => toggle(r)}>{r.enabled ? 'Turn off' : 'Turn on'}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tf-editor-actions">
            <Button onClick={postDue} disabled={busy || !dueCount}>{busy ? 'Posting…' : `Post ${dueCount} due`}</Button>
          </div>
        </div>
      ) : <p className="muted">No recurring fee set up yet.</p>}

      <div className="tf-repayment-form">
        <Field label="What">
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value)} disabled={busy}>
            {FEE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
        </Field>
        <Field label={`Amount (${currency})`}>
          <Input inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} disabled={busy} />
        </Field>
        <Field label="How often">
          <Select value={form.frequency} onChange={(e) => set('frequency', e.target.value)} disabled={busy}>
            {COMMITMENT_FREQS.map((f) => <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>)}
          </Select>
        </Field>
        <Field label="Next date">
          <Input type="date" value={form.nextDate} onChange={(e) => set('nextDate', e.target.value)} disabled={busy} />
        </Field>
        <Button variant="primary" onClick={add} disabled={busy}>{busy ? 'Saving…' : 'Add recurring fee'}</Button>
      </div>
    </section>
  );
}

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
  const canManage = context.permissions.canManage;

  return (
    <div className="page tf-page">
      <PageHeader
        title="Interest"
        subtitle="What each drawdown has accrued since the last charge, every interest figure recorded, and the bank's own figure beside ours."
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
          <EmptyState title="No interest recorded yet." body="Interest is recorded when it is paid with a repayment, or charged at month-end." />
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

      {canManage ? (
        <>
          <CapitalisationSection tick={tick} />
          <ReconciliationSection facilities={context.facilities} tick={tick} />
          <FeesSection facilities={context.facilities} tick={tick} />
          <RecurringSection facilities={context.facilities} tick={tick} today={context.today} />
        </>
      ) : null}
    </div>
  );
}
