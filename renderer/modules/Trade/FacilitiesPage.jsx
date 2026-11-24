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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { useAppStore } from '../../store/index.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useTradeContext, useTradeTick } from './tradeHooks.js';
import {
  COMMITMENT_FREQS, KINDS, daysLabel, errText, formatCommitmentFee, formatMinor, formatPercent, formatRate,
  minorToInput, newClientId, parseAmount, todayISO,
} from './tradeModel.js';

const BLANK_FACILITY = {
  bankId: '', kind: 'RC', name: '', currency: 'USD', limit: '', rate: '',
  dayCount: '360', revolving: true, hasMaturity: true, commitmentRate: '',
  commitmentFreq: 'monthly', termDays: '', note: '', interestBasis: 'drawn',
};

function facilityToForm(f) {
  return {
    bankId: f.bankId, kind: f.kind, name: f.name, currency: f.currency,
    limit: minorToInput(f.limitMinor, f.currency), rate: String(f.rate ?? ''),
    dayCount: String(f.dayCount || 360), revolving: !!f.revolving, hasMaturity: !!f.hasMaturity,
    commitmentRate: f.commitmentRate ? String(f.commitmentRate) : '',
    commitmentFreq: f.commitmentFreq || 'monthly',
    termDays: f.termDays ? String(f.termDays) : '', note: f.note || '',
    interestBasis: f.interestBasis || 'drawn',
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
  const basisLocked = !isNew && ((facility.activeDrawdowns || 0) > 0 || (facility.movements || 0) > 0);

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
        hasMaturity: form.interestBasis === 'balance' ? false : form.hasMaturity,
        interestBasis: form.interestBasis,
        interestBilling: form.interestBasis === 'balance' ? 'month_end_capitalised' : 'at_repayment',
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
              <input type="checkbox" checked={form.hasMaturity && form.interestBasis !== 'balance'} onChange={(e) => set('hasMaturity', e.target.checked)} disabled={busy || form.interestBasis === 'balance'} />
              Every drawdown has a maturity date
            </label>
          </div>
        </Field>
        <Field label="Interest is charged on" hint={basisLocked ? 'This facility already has history, so its basis cannot change.' : 'The drawn amount for RC/TR. The running balance for an overdraft.'}>
          <Select value={form.interestBasis} onChange={(e) => set('interestBasis', e.target.value)} disabled={busy || basisLocked}>
            <option value="drawn">The drawn amount (RC / TR)</option>
            <option value="balance">The running balance (overdraft)</option>
          </Select>
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

const MOVEMENT_KINDS = [
  { value: 'draw', label: 'Draw — increases what is owed' },
  { value: 'repay', label: 'Repayment — reduces what is owed' },
  { value: 'opening', label: 'Opening balance' },
  { value: 'adjustment', label: 'Adjustment' },
];

function MovementsModal({ facility, onClose }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ kind: 'draw', entryDate: todayISO(), amount: '', direction: 'up', note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clientId = useRef(newClientId());
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const load = useCallback(async () => {
    const list = await window.api.trade.movements.list(facility.id);
    setRows(Array.isArray(list) ? list : []);
  }, [facility.id]);

  useEffect(() => { load().catch((err) => setError(errText(err))); }, [load]);

  async function add() {
    setError('');
    const parsed = parseAmount(form.amount, facility.currency);
    if (!parsed.ok || parsed.minor <= 0) { setError(parsed.ok ? 'Enter the amount.' : parsed.error); return; }
    const amountMinor = form.kind === 'adjustment' && form.direction === 'down' ? -parsed.minor : parsed.minor;
    setBusy(true);
    try {
      const list = await window.api.trade.movements.add({
        clientUuid: clientId.current,
        facilityId: facility.id,
        entryDate: form.entryDate,
        kind: form.kind,
        amountMinor,
        note: form.note.trim() || null,
      });
      setRows(Array.isArray(list) ? list : []);
      clientId.current = newClientId();
      setForm((f) => ({ ...f, amount: '', note: '' }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const balance = rows.length ? rows[rows.length - 1].balanceMinor : 0;

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title={`Movements — ${facility.name}`}
      wide
      busy={busy}
      footer={<div className="tf-actions"><span className="tf-actions__spacer" /><Button onClick={onClose} disabled={busy}>Close</Button></div>}
    >
      {error ? <p className="field__error">{error}</p> : null}
      <p className="tf-card__value">{formatMinor(balance, facility.currency)} <span className="muted">owed now</span></p>
      {rows.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Date</th><th>What</th><th className="is-num">Amount</th><th className="is-num">Balance</th><th>Note</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>{m.entryDate}</td>
                  <td>{m.kind === 'interest_capitalised' ? 'Interest capitalised' : m.kind[0].toUpperCase() + m.kind.slice(1)}</td>
                  <td className="is-num">{formatMinor(m.amountMinor, facility.currency)}</td>
                  <td className="is-num">{formatMinor(m.balanceMinor, facility.currency)}</td>
                  <td className="muted">{m.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No movements yet. Record the opening balance first.</p>}

      <div className="tf-repayment-form">
        <Field label="What">
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value)} disabled={busy}>
            {MOVEMENT_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </Field>
        <Field label={`Amount (${facility.currency})`}>
          <Input inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} disabled={busy} />
        </Field>
        <Field label="Date">
          <Input type="date" value={form.entryDate} onChange={(e) => set('entryDate', e.target.value)} disabled={busy} />
        </Field>
        <Field label={form.kind === 'adjustment' ? 'Direction' : 'Note'}>
          {form.kind === 'adjustment' ? (
            <Select value={form.direction} onChange={(e) => set('direction', e.target.value)} disabled={busy}>
              <option value="up">Increase</option>
              <option value="down">Reduce</option>
            </Select>
          ) : (
            <Input value={form.note} onChange={(e) => set('note', e.target.value)} disabled={busy} maxLength={500} />
          )}
        </Field>
        <Button variant="primary" onClick={add} disabled={busy}>{busy ? 'Saving…' : 'Add movement'}</Button>
      </div>
      {form.kind === 'adjustment' ? (
        <Field label="Note"><Input value={form.note} onChange={(e) => set('note', e.target.value)} disabled={busy} maxLength={500} /></Field>
      ) : null}
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
  const [movementsFor, setMovementsFor] = useState(null);
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
            {/* A dead primary in the header reads as broken; with no bank the
                empty card carries the one action. */}
            {activeBanks.length ? <Button variant="primary" onClick={() => setNewOpen(true)} data-testid="trade-facility-new">+ New facility</Button> : null}
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
          action={!canManage ? null : activeBanks.length
            ? <Button variant="primary" onClick={() => setNewOpen(true)}>+ New facility</Button>
            : <Button variant="primary" onClick={() => setBankOpen(true)}>Add a bank</Button>}
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
                <th>Tracking</th>
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
                  <td className="is-num">{f.commitmentPerPeriodMinor ? formatCommitmentFee(f.commitmentPerPeriodMinor, f.currency, f.commitmentFreq) : <span className="muted">Waived</span>}</td>
                  <td className="muted">{f.nextMaturity ? daysLabel(Math.round((Date.parse(`${f.nextMaturity}T00:00:00Z`) - Date.parse(`${context.today}T00:00:00Z`)) / 86400000)) : '—'}{f.nextMaturity ? <div className="tf-sub">{f.nextMaturity}</div> : null}</td>
                  <td>{f.active ? <Badge tone="emerald">Open</Badge> : <Badge tone="slate">Retired</Badge>}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {f.balanceBased
                      ? <Button size="sm" onClick={() => setMovementsFor(f)} title="Record overdraft deposits and withdrawals">Movements</Button>
                      : <span className="muted tf-sub" title="Tracked per drawdown on the Drawdowns screen">Via Drawdowns</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted tf-sub">
            Overdraft (running-balance) facilities track deposits and withdrawals under Movements; credit lines (RC / TR) are tracked per drawdown on the Drawdowns screen.
          </p>
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
      {movementsFor ? (
        <MovementsModal facility={movementsFor} onClose={() => setMovementsFor(null)} />
      ) : null}
    </div>
  );
}
