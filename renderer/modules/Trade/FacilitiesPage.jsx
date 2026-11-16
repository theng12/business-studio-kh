/**
 * Trade Finance → Facilities: banks and the credit lines they give.
 *
 * A facility is a set of rules, not a fixed type: limit, currency, annual
 * rate, day count, revolving, maturity, commitment fee. The screen shows the
 * derived figures (drawn, undrawn, utilisation, the commitment fee for one
 * period) and never stores them.
 *
 * Phase A writes drawn-amount facilities. Running-balance (overdraft)
 * facilities are a later phase, so the form says that plainly instead of
 * offering a control that would do nothing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useTradeContext, useTradeTick } from './tradeHooks.js';
import {
  COMMITMENT_FREQS, KINDS, daysLabel, errText, formatMinor, formatPercent, formatRate,
  minorToInput, parseAmount,
} from './tradeModel.js';

const BLANK_FACILITY = {
  bankId: '', kind: 'RC', name: '', currency: 'USD', limit: '', rate: '',
  dayCount: '360', revolving: true, hasMaturity: true, commitmentRate: '',
  commitmentFreq: 'monthly', termDays: '', note: '',
};

function facilityToForm(f) {
  return {
    bankId: f.bankId, kind: f.kind, name: f.name, currency: f.currency,
    limit: minorToInput(f.limitMinor, f.currency), rate: String(f.rate ?? ''),
    dayCount: String(f.dayCount || 360), revolving: !!f.revolving, hasMaturity: !!f.hasMaturity,
    commitmentRate: f.commitmentRate ? String(f.commitmentRate) : '',
    commitmentFreq: f.commitmentFreq || 'monthly',
    termDays: f.termDays ? String(f.termDays) : '', note: f.note || '',
  };
}

function FacilityEditor({ facility, banks, onClose, onSaved }) {
  const isNew = !facility;
  const [form, setForm] = useState(isNew ? BLANK_FACILITY : facilityToForm(facility));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = useCallback((key, value) => setForm((f) => ({ ...f, [key]: value })), []);

  const limit = parseAmount(form.limit, form.currency);
  const rate = Number(form.rate || 0);
  const commitmentRate = Number(form.commitmentRate || 0);
  const termDays = form.termDays === '' ? null : Number(form.termDays);

  async function save() {
    setError('');
    if (!form.name.trim()) { setError('Enter the facility name.'); return; }
    if (!form.bankId) { setError('Choose the bank.'); return; }
    if (!limit.ok) { setError(limit.error); return; }
    if (!Number.isFinite(rate) || rate < 0) { setError('Enter the annual interest rate, like 7.5.'); return; }
    if (!Number.isFinite(commitmentRate) || commitmentRate < 0) { setError('The commitment rate cannot be negative.'); return; }
    if (termDays != null && (!Number.isSafeInteger(termDays) || termDays <= 0)) { setError('Term days must be a whole number of days.'); return; }
    setBusy(true);
    try {
      const payload = {
        bankId: form.bankId,
        kind: form.kind,
        name: form.name.trim(),
        currency: form.currency,
        limitMinor: limit.minor,
        rate,
        dayCount: Number(form.dayCount),
        revolving: form.revolving,
        hasMaturity: form.hasMaturity,
        interestBasis: 'drawn',
        interestBilling: 'at_repayment',
        commitmentRate,
        commitmentFreq: form.commitmentFreq,
        termDays,
        note: form.note.trim() || null,
      };
      const saved = isNew
        ? await window.api.trade.facilities.create(payload)
        : await window.api.trade.facilities.update(facility.id, payload);
      onSaved(saved);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    const ok = await confirm({
      title: 'Retire this facility?',
      message: `${facility.name} will leave the list. Its drawdowns and interest history stay.`,
      confirmLabel: 'Retire',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await window.api.trade.facilities.setActive(facility.id, false);
      onSaved(null);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title={isNew ? 'New facility' : `${facility.name} — ${facility.bankName}`}
      wide
      busy={busy}
      footer={(
        <div className="tf-actions">
          {!isNew ? <Button onClick={archive} disabled={busy}>Retire</Button> : null}
          <span className="tf-actions__spacer" />
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save facility'}</Button>
        </div>
      )}
    >
      {error ? <p className="field__error">{error}</p> : null}
      <div className="form-grid">
        <Field label="Bank" required>
          <Select value={form.bankId} onChange={(e) => set('bankId', e.target.value)} disabled={busy}>
            <option value="">Choose a bank…</option>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Name" required hint="As you and the bank call it, e.g. “TR line — tiles”.">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} disabled={busy} maxLength={120} />
        </Field>
        <Field label="Kind">
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value)} disabled={busy}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </Field>
        <Field label="Currency">
          <Select value={form.currency} onChange={(e) => set('currency', e.target.value)} disabled={busy}>
            <option value="USD">USD</option>
            <option value="KHR">KHR</option>
          </Select>
        </Field>
        <Field label={`Credit limit (${form.currency})`} required>
          <Input inputMode="decimal" value={form.limit} onChange={(e) => set('limit', e.target.value)} disabled={busy} placeholder={form.currency === 'KHR' ? '500000000' : '250000.00'} />
        </Field>
        <Field label="Annual interest rate (%)" required hint="The rate charged now. A later change is added to the rate history.">
          <Input inputMode="decimal" value={form.rate} onChange={(e) => set('rate', e.target.value)} disabled={busy} placeholder="7.50" />
        </Field>
        <Field label="Day count">
          <Select value={form.dayCount} onChange={(e) => set('dayCount', e.target.value)} disabled={busy}>
            <option value="360">360 days</option>
            <option value="365">365 days</option>
          </Select>
        </Field>
        <Field label="Term (days)" hint="Typical TR term, e.g. 180. Leave blank when the facility has none.">
          <Input inputMode="numeric" value={form.termDays} onChange={(e) => set('termDays', e.target.value)} disabled={busy} placeholder="180" />
        </Field>
        <Field label="Commitment fee rate (%)" hint="Charged on the undrawn part. 0 means the bank waived it.">
          <Input inputMode="decimal" value={form.commitmentRate} onChange={(e) => set('commitmentRate', e.target.value)} disabled={busy} placeholder="0.50" />
        </Field>
        <Field label="Commitment fee frequency">
          <Select value={form.commitmentFreq} onChange={(e) => set('commitmentFreq', e.target.value)} disabled={busy}>
            {COMMITMENT_FREQS.map((f) => <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>)}
          </Select>
        </Field>
        <Field label="Options">
          <div className="tf-checks">
            <label className="finance-check">
              <input type="checkbox" checked={form.revolving} onChange={(e) => set('revolving', e.target.checked)} disabled={busy} />
              Revolving — repaid money can be drawn again
            </label>
            <label className="finance-check">
              <input type="checkbox" checked={form.hasMaturity} onChange={(e) => set('hasMaturity', e.target.checked)} disabled={busy} />
              Every drawdown has a maturity date
            </label>
          </div>
        </Field>
        <Field label="Interest is charged on" hint="Drawn amount now. Running-balance overdrafts arrive in a later update.">
          <Input value="The drawn amount" disabled />
        </Field>
        <Field label="Note" span={2}>
          <Textarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} disabled={busy} maxLength={500} />
        </Field>
      </div>

      {!isNew && facility.rateHistory?.length ? (
        <section className="finance-section">
          <h3 className="section-title">Rate history</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Effective date</th><th className="is-num">Rate</th><th>Note</th></tr></thead>
              <tbody>
                {facility.rateHistory.map((r) => (
                  <tr key={r.id}>
                    <td>{r.effectiveDate}</td>
                    <td className="is-num">{formatRate(r.rate)}</td>
                    <td className="muted">{r.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </Modal>
  );
}

function BankEditor({ onClose, onSaved }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { setError('Enter the bank name.'); return; }
    setBusy(true);
    try {
      await window.api.trade.banks.create({ name: name.trim() });
      onSaved();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Add a bank"
      busy={busy}
      footer={<div className="tf-actions"><span className="tf-actions__spacer" /><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Add bank'}</Button></div>}
    >
      {error ? <p className="field__error">{error}</p> : null}
      <Field label="Bank name" required hint="The lender, e.g. ABA, ACLEDA, Canadia.">
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={120} autoFocus />
      </Field>
    </Modal>
  );
}

export function TradeFacilities() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const context = useTradeContext();
  const tick = useTradeTick();
  const [rows, setRows] = useState([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // facility object
  const [newOpen, setNewOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const addToast = useAppStore((s) => s.addToast);

  useEffect(() => {
    if (!activeCompanyId || !context.loaded || !context.permissions.canView) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    window.api.trade.facilities.list({ includeArchived })
      .then((res) => { if (alive) { setRows(Array.isArray(res) ? res : []); setError(''); } })
      .catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, context.loaded, context.permissions.canView, includeArchived, tick]);

  const totals = useMemo(() => {
    const out = {};
    for (const f of rows) {
      const r = (out[f.currency] ||= { limitMinor: 0, drawnMinor: 0 });
      r.limitMinor += f.limitMinor;
      r.drawnMinor += f.drawnMinor;
    }
    return out;
  }, [rows]);

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Facilities" /><p className="muted">Choose a company first — each company keeps its own facilities.</p></div>;
  }
  if (!context.loaded) return <div className="page"><p className="muted">Loading Trade Finance…</p></div>;
  if (context.error) return <div className="page"><PageHeader title="Facilities" /><LoadError message={context.error} onRetry={() => window.location.reload()} /></div>;

  const canManage = context.permissions.canManage;
  const activeBanks = context.banks || [];

  async function openFacility(row) {
    try {
      const full = await window.api.trade.facilities.get(row.id);
      setEditing(full || row);
    } catch (_) {
      setEditing(row); // the row still has every editable field; history is the only extra
    }
  }

  return (
    <div className="page tf-page">
      <PageHeader
        title="Facilities"
        subtitle="What each bank lends, on what terms, and how much is used."
        actions={canManage ? (
          <div className="tf-actions">
            <Button onClick={() => setBankOpen(true)} data-testid="trade-add-bank">Add bank</Button>
            <Button variant="primary" onClick={() => setNewOpen(true)} data-testid="trade-facility-new" disabled={!activeBanks.length}>+ New facility</Button>
          </div>
        ) : null}
      />

      {!activeBanks.length ? (
        <p className="muted finance-hint">Add a bank first, then its credit line.</p>
      ) : null}

      {Object.entries(totals).length ? (
        <div className="tf-cards">
          {Object.entries(totals).map(([currency, t]) => (
            <div className="tf-card" key={currency}>
              <span className="tf-card__label">Total {currency}</span>
              <span className="tf-card__value">{formatMinor(t.drawnMinor, currency)} used</span>
              <span className="muted">of {formatMinor(t.limitMinor, currency)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="field__error">Couldn't load the facilities: {error}</p> : null}

      {!loading && !rows.length ? (
        <EmptyState
          title="No facilities yet."
          body="Record each bank's credit line — its limit, rate and how interest is charged."
          action={canManage && activeBanks.length ? <Button variant="primary" onClick={() => setNewOpen(true)}>+ New facility</Button> : null}
        />
      ) : rows.length ? (
        <div className="data-table-wrap">
          <table className="data-table tf-table">
            <thead>
              <tr>
                <th>Bank</th>
                <th>Facility</th>
                <th>Kind</th>
                <th className="is-num">Limit</th>
                <th className="is-num">Drawn</th>
                <th>Used</th>
                <th className="is-num">Rate</th>
                <th className="is-num">Commitment</th>
                <th>Next maturity</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr
                  key={f.id}
                  className={canManage ? 'is-clickable' : undefined}
                  data-testid={`trade-facility-row-${f.id}`}
                  tabIndex={canManage ? 0 : undefined}
                  onClick={canManage ? () => openFacility(f) : undefined}
                  onKeyDown={canManage ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFacility(f); } } : undefined}
                >
                  <td>{f.bankName}</td>
                  <td>
                    <strong>{f.name}</strong>
                    <div className="muted tf-sub">{f.currency} · {f.dayCount}-day{Number(f.termDays) ? ` · ${f.termDays}d term` : ''}</div>
                  </td>
                  <td><Badge tone="slate">{f.kind}</Badge></td>
                  <td className="is-num">{formatMinor(f.limitMinor, f.currency)}</td>
                  <td className="is-num">{formatMinor(f.drawnMinor, f.currency)}</td>
                  <td>
                    <div className="tf-meter" title={`${formatMinor(f.drawnMinor, f.currency)} of ${formatMinor(f.limitMinor, f.currency)}`}>
                      <div className="tf-meter__track"><div className="tf-meter__fill" style={{ width: `${Math.min(100, f.utilisation * 100)}%` }} /></div>
                      <span className="tf-meter__label">{formatPercent(f.utilisation)}</span>
                    </div>
                  </td>
                  <td className="is-num">{formatRate(f.rate)}</td>
                  <td className="is-num">{f.commitmentPerPeriodMinor ? `${formatMinor(f.commitmentPerPeriodMinor, f.currency)}` : <span className="muted">Waived</span>}</td>
                  <td className="muted">{f.nextMaturity ? daysLabel(Math.round((Date.parse(`${f.nextMaturity}T00:00:00Z`) - Date.parse(`${context.today}T00:00:00Z`)) / 86400000)) : '—'}{f.nextMaturity ? <div className="tf-sub">{f.nextMaturity}</div> : null}</td>
                  <td>{f.active ? <Badge tone="emerald">Open</Badge> : <Badge tone="slate">Retired</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <label className="finance-check tf-archived-toggle">
        <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
        Show retired facilities
      </label>

      {newOpen ? (
        <FacilityEditor
          banks={activeBanks}
          onClose={() => setNewOpen(false)}
          onSaved={() => { setNewOpen(false); addToast('Facility saved', 'success'); }}
        />
      ) : null}
      {editing ? (
        <FacilityEditor
          facility={editing}
          banks={activeBanks}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); addToast('Facility saved', 'success'); }}
        />
      ) : null}
      {bankOpen ? (
        <BankEditor
          onClose={() => setBankOpen(false)}
          onSaved={() => { setBankOpen(false); addToast('Bank added', 'success'); }}
        />
      ) : null}
    </div>
  );
}
