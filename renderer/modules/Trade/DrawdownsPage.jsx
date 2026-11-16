/**
 * Trade Finance → Drawdowns: money actually drawn on a facility.
 *
 * The list is server-paged. A drawdown opens as an editor view (Back returns
 * to the list): its terms, the interest accrued to today, its repayments and
 * the remaining balance. A repayment can be partial; once one exists the
 * money terms are frozen and only the note can change — the same rule the
 * Finance screens use for a submitted expense.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Badge, Button, EmptyState, Field, Input, Pagination, Select, Textarea } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { usePager } from '../People/hrHooks.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useTradeContext, useTradeTick } from './tradeHooks.js';
import {
  daysLabel, errText, formatMinor, formatRate, minorToInput, newClientId, parseAmount,
  statusLabel, statusTone, todayISO,
} from './tradeModel.js';

function facilityOf(facilities, id) {
  return (facilities || []).find((f) => f.id === id) || null;
}

function NewOrEditDrawdown({ drawdownId, isNew, facilities, today, onBack, onSaved }) {
  const [row, setRow] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const addToast = useAppStore((s) => s.addToast);
  const clientId = useRef(newClientId());

  const set = useCallback((key, value) => setForm((f) => ({ ...f, [key]: value })), []);

  const blank = useCallback(() => {
    const f = facilities[0] || null;
    return {
      facilityId: f?.id || '',
      principal: '',
      valueDate: today || todayISO(),
      maturityDate: '',
      rate: f ? String(f.rate ?? '') : '',
      reference: '',
      settleCurrency: '',
      fxRate: '',
      note: '',
    };
  }, [facilities, today]);

  useEffect(() => {
    if (isNew) { setForm(blank()); setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.trade.drawdowns.get(drawdownId)
      .then((d) => {
        if (!alive) return;
        setRow(d);
        setForm({
          facilityId: d.facilityId, principal: minorToInput(d.principalMinor, d.currency),
          valueDate: d.valueDate, maturityDate: d.maturityDate || '', rate: String(d.rate ?? ''),
          reference: d.reference || '', settleCurrency: d.settleCurrency || '',
          fxRate: d.fxRate == null ? '' : String(d.fxRate), note: d.note || '',
        });
      })
      .catch((err) => { if (alive) setLoadError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [drawdownId, isNew, blank]);

  const facilityOptions = useMemo(() => {
    const list = [...facilities];
    if (row && !list.some((f) => f.id === row.facilityId)) {
      list.unshift({ id: row.facilityId, name: row.facilityName, bankName: row.bankName, currency: row.currency });
    }
    return list;
  }, [facilities, row]);
  const facility = useMemo(
    () => facilityOf(facilities, form?.facilityId) || (row ? { id: row.facilityId, name: row.facilityName, currency: row.currency, rate: row.rate, dayCount: row.dayCount, hasMaturity: !!row.maturityDate } : null),
    [facilities, form?.facilityId, row],
  );
  const currency = facility?.currency || row?.currency || 'USD';

  async function save() {
    setError('');
    if (!form) return;
    if (!form.facilityId) { setError('Choose the facility.'); return; }
    const principal = parseAmount(form.principal, currency);
    if (!principal.ok || principal.minor <= 0) { setError(principal.ok ? 'Enter the amount drawn.' : principal.error); return; }
    if (!form.valueDate) { setError('Enter the value date.'); return; }
    if (facility?.hasMaturity !== false && !form.maturityDate) { setError('Enter the maturity date.'); return; }
    if (form.maturityDate && form.maturityDate <= form.valueDate) { setError('Maturity must be after the value date.'); return; }
    const rate = Number(form.rate || 0);
    if (!Number.isFinite(rate) || rate < 0) { setError('Enter the annual interest rate.'); return; }
    const settle = form.settleCurrency.trim().toUpperCase();
    if (settle && !/^[A-Z]{3}$/.test(settle)) { setError('Settlement currency is a three-letter code, like CNY.'); return; }
    const fx = form.fxRate === '' ? null : Number(form.fxRate);
    if (settle && settle !== currency && (!Number.isFinite(fx) || fx <= 0)) { setError('Enter the FX rate used for this settlement.'); return; }
    setBusy(true);
    try {
      const payload = {
        clientUuid: clientId.current,
        facilityId: form.facilityId,
        principalMinor: principal.minor,
        valueDate: form.valueDate,
        maturityDate: form.maturityDate || null,
        rate,
        reference: form.reference.trim() || null,
        settleCurrency: settle || null,
        fxRate: settle && settle !== currency ? fx : null,
        note: form.note.trim() || null,
      };
      const d = isNew
        ? await window.api.trade.drawdowns.create(payload)
        : await window.api.trade.drawdowns.update(drawdownId, payload);
      addToast(isNew ? 'Drawdown recorded' : 'Drawdown saved', 'success');
      onSaved(d);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  async function setStatus(status) {
    const label = status === 'cancelled' ? 'Cancel this drawdown?' : 'Close this drawdown?';
    const ok = await confirm({
      title: label,
      message: status === 'cancelled'
        ? 'A cancelled drawdown stays in the history but takes no repayments.'
        : 'A closed drawdown stays in the history and stops counting as open. You can reopen it by changing the status.',
      confirmLabel: status === 'cancelled' ? 'Cancel drawdown' : 'Close drawdown',
      danger: status === 'cancelled',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const d = await window.api.trade.drawdowns.setStatus(drawdownId, status);
      setRow(d);
      addToast(status === 'cancelled' ? 'Drawdown cancelled' : 'Drawdown closed', 'success');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="page"><p className="muted">Loading the drawdown…</p></div>;
  if (loadError) return <div className="page"><PageHeader title="Drawdown" backTo={{ label: 'Drawdowns', onClick: onBack }} /><LoadError message={loadError} onRetry={() => window.location.reload()} /></div>;
  if (!form) return null;

  const locked = !isNew && row && (row.repayments?.length || 0) > 0;
  const active = row?.status === 'active';

  return (
    <div className="page tf-page">
      <PageHeader
        title={isNew ? 'New drawdown' : (row?.reference || row?.facilityName || 'Drawdown')}
        subtitle={isNew ? 'Record money drawn on a facility.' : `${row?.facilityName} · ${row?.bankName || ''}`}
        backTo={{ label: 'Drawdowns', onClick: onBack }}
        actions={!isNew ? (
          <div className="tf-actions">
            {active ? <Button onClick={() => setStatus('closed')} disabled={busy}>Close</Button> : null}
            {active && !(row?.repayments?.length) ? <Button onClick={() => setStatus('cancelled')} disabled={busy}>Cancel</Button> : null}
            {!active ? <Button onClick={() => setStatus('active')} disabled={busy}>Reopen</Button> : null}
          </div>
        ) : null}
      />

      {error ? <p className="field__error">{error}</p> : null}

      {!isNew && row ? (
        <div className="tf-cards">
          <div className="tf-card"><span className="tf-card__label">Principal</span><span className="tf-card__value">{formatMinor(row.principalMinor, currency)}</span></div>
          <div className="tf-card"><span className="tf-card__label">Repaid</span><span className="tf-card__value">{formatMinor(row.repaidMinor, currency)}</span></div>
          <div className="tf-card"><span className="tf-card__label">Outstanding</span><span className="tf-card__value">{formatMinor(row.outstandingMinor, currency)}</span></div>
          <div className="tf-card">
            <span className="tf-card__label">Interest to today</span>
            <span className="tf-card__value">{formatMinor(row.accruedMinor, currency)}</span>
            <span className="muted">from {row.accruedFrom} · an estimate until the bank bills</span>
          </div>
          <div className="tf-card">
            <span className="tf-card__label">To maturity</span>
            <span className="tf-card__value">{formatMinor(row.interestToMaturityMinor, currency)}</span>
            <span className="muted">{daysLabel(row.daysToMaturity)}</span>
          </div>
        </div>
      ) : null}

      <div className="form-grid">
        <Field label="Facility" required>
          <Select value={form.facilityId} onChange={(e) => set('facilityId', e.target.value)} disabled={busy || locked}>
            <option value="">Choose a facility…</option>
            {facilityOptions.map((f) => <option key={f.id} value={f.id}>{f.bankName} — {f.name} ({f.currency})</option>)}
          </Select>
        </Field>
        <Field label={`Amount drawn (${currency})`} required>
          <Input inputMode="decimal" value={form.principal} onChange={(e) => set('principal', e.target.value)} disabled={busy || locked} />
        </Field>
        <Field label="Value date" required>
          <Input type="date" value={form.valueDate} onChange={(e) => set('valueDate', e.target.value)} disabled={busy || locked} />
        </Field>
        <Field label="Maturity" hint={facility?.hasMaturity === false ? 'This facility does not require one.' : 'The date the bank expects repayment.'}>
          <Input type="date" value={form.maturityDate} onChange={(e) => set('maturityDate', e.target.value)} disabled={busy || locked} />
        </Field>
        <Field label="Annual interest rate (%)" required>
          <Input inputMode="decimal" value={form.rate} onChange={(e) => set('rate', e.target.value)} disabled={busy || locked} />
        </Field>
        <Field label="Bank reference" hint="Optional. Two drawdowns can never share one.">
          <Input value={form.reference} onChange={(e) => set('reference', e.target.value)} disabled={busy || locked} maxLength={80} />
        </Field>
        <Field label="Settlement currency" hint="What actually left for the supplier, if not the facility currency.">
          <Input value={form.settleCurrency} onChange={(e) => set('settleCurrency', e.target.value.toUpperCase())} disabled={busy || locked} maxLength={3} placeholder="CNY" />
        </Field>
        <Field label="FX rate used" hint="Facility currency per one settlement unit, as the bank applied it.">
          <Input inputMode="decimal" value={form.fxRate} onChange={(e) => set('fxRate', e.target.value)} disabled={busy || locked} />
        </Field>
        <Field label="Note" span={2}>
          <Textarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} disabled={busy} maxLength={500} />
        </Field>
      </div>

      {locked ? <p className="muted finance-hint">This drawdown has repayments, so its money terms are fixed. The note can still change.</p> : null}

      <div className="tf-editor-actions">
        <Button onClick={onBack} disabled={busy}>Back</Button>
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>

      {!isNew && row ? <Repayments row={row} currency={currency} today={today} onChanged={(d) => { setRow(d); addToast('Repayment recorded', 'success'); }} /> : null}
    </div>
  );
}

function Repayments({ row, currency, today, onChanged }) {
  const defaultDate = today || todayISO();
  const [form, setForm] = useState({ principal: '', interest: '', paidOn: defaultDate, note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clientId = useRef(newClientId());
  const canAdd = row.status === 'active' && row.outstandingMinor > 0;

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function add() {
    setError('');
    const principal = form.principal === '' ? { ok: true, minor: 0 } : parseAmount(form.principal, currency);
    const interest = form.interest === '' ? { ok: true, minor: 0 } : parseAmount(form.interest, currency);
    if (!principal.ok) { setError(principal.error); return; }
    if (!interest.ok) { setError(interest.error); return; }
    if (principal.minor + interest.minor <= 0) { setError('Enter a principal or interest amount.'); return; }
    if (principal.minor > row.outstandingMinor) { setError('That is more than the outstanding principal.'); return; }
    if (!form.paidOn) { setError('Enter the payment date.'); return; }
    setBusy(true);
    try {
      const result = await window.api.trade.repayments.add({
        clientUuid: clientId.current,
        drawdownId: row.id,
        principalMinor: principal.minor,
        interestMinor: interest.minor,
        paidOn: form.paidOn,
        note: form.note.trim() || null,
      });
      clientId.current = newClientId();
      setForm({ principal: '', interest: '', paidOn: defaultDate, note: '' });
      onChanged(result.drawdown);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="finance-section">
      <h2 className="section-title">Repayments</h2>
      {error ? <p className="field__error">{error}</p> : null}
      {row.repayments?.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Date</th><th className="is-num">Principal</th><th className="is-num">Interest</th><th>Note</th></tr></thead>
            <tbody>
              {row.repayments.map((r) => (
                <tr key={r.id}>
                  <td>{r.paidOn}</td>
                  <td className="is-num">{formatMinor(r.principalMinor, currency)}</td>
                  <td className="is-num">{formatMinor(r.interestMinor, currency)}</td>
                  <td className="muted">{r.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No repayments yet.</p>}

      {canAdd ? (
        <div className="tf-repayment-form">
          <Field label={`Principal (${currency})`}>
            <Input inputMode="decimal" value={form.principal} onChange={(e) => set('principal', e.target.value)} disabled={busy} />
          </Field>
          <Field label={`Interest (${currency})`} hint="What was paid with this repayment; it is posted as interest.">
            <Input inputMode="decimal" value={form.interest} onChange={(e) => set('interest', e.target.value)} disabled={busy} />
          </Field>
          <Field label="Date">
            <Input type="date" value={form.paidOn} onChange={(e) => set('paidOn', e.target.value)} disabled={busy} />
          </Field>
          <Field label="Note">
            <Input value={form.note} onChange={(e) => set('note', e.target.value)} disabled={busy} maxLength={500} />
          </Field>
          <Button variant="primary" onClick={add} disabled={busy}>{busy ? 'Saving…' : 'Add repayment'}</Button>
        </div>
      ) : row.status === 'active' ? <p className="muted finance-hint">The principal is fully repaid. Close the drawdown when the interest is settled.</p> : null}
    </section>
  );
}

export function TradeDrawdowns() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const context = useTradeContext();
  const tick = useTradeTick();
  const [editing, setEditing] = useState(null); // { id } | { isNew: true } | null
  const [filters, setFilters] = useState({ facilityId: '', status: 'active', q: '' });
  const [search, setSearch] = useState('');
  const [result, setResult] = useState({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { page, setPage, pageSize, setPageSize } = usePager([filters]);
  const companyRef = useRef(activeCompanyId);

  useEffect(() => {
    if (companyRef.current === activeCompanyId) return;
    companyRef.current = activeCompanyId;
    setEditing(null);
    setResult({ rows: [], total: 0 });
    setFilters({ facilityId: '', status: 'active', q: '' });
    setSearch('');
  }, [activeCompanyId]);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() })), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (editing || !activeCompanyId || !context.loaded || !context.permissions.canView) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.trade.drawdowns.list({ ...filters, page: page + 1, pageSize })
      .then((res) => { if (alive) { setResult({ rows: res?.rows || [], total: res?.total || 0 }); setError(''); } })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [editing, activeCompanyId, context.loaded, context.permissions.canView, filters, page, pageSize, tick]);

  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(result.total / pageSize) - 1);
    if (page > maxPage) setPage(maxPage);
  }, [result.total, pageSize, page, setPage]);

  const setFilter = (key, value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(0); };

  if (!activeCompanyId) return <div className="page"><PageHeader title="Drawdowns" /><p className="muted">Choose a company first.</p></div>;
  if (!context.loaded) return <div className="page"><p className="muted">Loading Trade Finance…</p></div>;
  if (context.error) return <div className="page"><PageHeader title="Drawdowns" /><LoadError message={context.error} onRetry={() => window.location.reload()} /></div>;
  const canManage = context.permissions.canManage;

  if (editing) {
    return (
      <NewOrEditDrawdown
        key={editing.isNew ? 'new' : editing.id}
        drawdownId={editing.id}
        isNew={!!editing.isNew}
        facilities={context.facilities}
        today={context.today}
        onBack={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
    );
  }

  const pager = {
    total: result.total, currentPage: page,
    maxPage: Math.max(0, Math.ceil(result.total / pageSize) - 1),
    pageStart: page * pageSize,
    pageEnd: Math.min(page * pageSize + pageSize, result.total),
    pageSize,
  };

  return (
    <div className="page tf-page">
      <PageHeader
        title="Drawdowns"
        subtitle="What has been drawn on each facility, what is still owed, and what is due next."
        actions={canManage ? <Button variant="primary" onClick={() => setEditing({ isNew: true })} disabled={!context.facilities.length}>+ New drawdown</Button> : null}
      />

      <div className="toolbar">
        <div className="search-wrap">
          <Input aria-label="Search drawdowns" placeholder="Search reference or note" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select aria-label="Facility" value={filters.facilityId} onChange={(e) => setFilter('facilityId', e.target.value)}>
          <option value="">All facilities</option>
          {context.facilities.map((f) => <option key={f.id} value={f.id}>{f.bankName} — {f.name}</option>)}
        </Select>
        <Select aria-label="Status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="active">Active</option>
          <option value="closed">Closed</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All statuses</option>
        </Select>
      </div>

      {error ? <p className="field__error">Couldn't load the drawdowns: {error}</p> : null}

      {!loading && !result.rows.length ? (
        <EmptyState
          title={filters.q || filters.facilityId ? 'No drawdowns match these filters.' : 'No drawdowns yet.'}
          body="Record one when a facility is used — a TR, an RC draw. Its maturity date is what the reminders watch."
          action={canManage && context.facilities.length ? <Button variant="primary" onClick={() => setEditing({ isNew: true })}>+ New drawdown</Button> : null}
        />
      ) : (
        <div className="data-table-wrap">
          <table className="data-table tf-table">
            <thead>
              <tr>
                <th>Facility</th><th>Reference</th><th>Value date</th><th>Maturity</th>
                <th className="is-num">Outstanding</th><th className="is-num">Rate</th>
                <th className="is-num">Interest to date</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((d) => {
                const ccy = d.currency || 'USD';
                return (
                  <tr
                    key={d.id}
                    className={canManage ? 'is-clickable' : undefined}
                    data-testid={`trade-drawdown-row-${d.id}`}
                    tabIndex={canManage ? 0 : undefined}
                    onClick={canManage ? () => setEditing({ id: d.id }) : undefined}
                    onKeyDown={canManage ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing({ id: d.id }); } } : undefined}
                  >
                    <td><strong>{d.facilityName}</strong><div className="muted tf-sub">{d.bankName}</div></td>
                    <td>{d.reference || <span className="muted">No reference</span>}</td>
                    <td>{d.valueDate}</td>
                    <td>{d.maturityDate || <span className="muted">—</span>}<div className="muted tf-sub">{d.maturityDate ? daysLabel(d.daysToMaturity) : ''}</div></td>
                    <td className="is-num">{formatMinor(d.outstandingMinor, ccy)}</td>
                    <td className="is-num">{formatRate(d.rate)}</td>
                    <td className="is-num">{formatMinor(d.accruedMinor, ccy)}</td>
                    <td><Badge tone={statusTone(d.status)}>{statusLabel(d.status)}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination {...pager} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(0); }} />
        </div>
      )}

      {loading ? <p className="muted finance-loading">Loading drawdowns…</p> : null}
    </div>
  );
}
