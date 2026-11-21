/**
 * Trade Finance → Reminders: never miss a loan maturity.
 *
 * The due list is a live window computed from the drawdowns, overdrafts and
 * scheduled fees — nothing is queued, so a day the app was closed loses
 * nothing. Rules say how many days before maturity to remind; a facility's
 * own rules replace the global set for it. A drawdown can be snoozed until a
 * date and woken again. The log records what the app has already surfaced.
 *
 * Reminders are in-app only in v1: no email, Telegram or SMS. That is said
 * plainly under the title rather than implied.
 */

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../../components/PageHeader.jsx';
import { Badge, Button, EmptyState, Field, Input, Modal, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useTradeContext, useTradeTick } from './tradeHooks.js';
import { daysLabel, errText, formatMinor, todayISO } from './tradeModel.js';

const TONE = (daysTo) => (daysTo == null ? 'slate' : daysTo < 0 ? 'rose' : daysTo <= 3 ? 'amber' : 'slate');

function RuleEditor({ rule, facilities, onClose, onSaved }) {
  const isNew = !rule;
  const [form, setForm] = useState({
    facilityId: rule?.facilityId || '',
    leadDays: rule ? String(rule.leadDays) : '7',
    label: rule?.label || '',
    enabled: rule ? !!rule.enabled : true,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = useCallback((key, value) => setForm((f) => ({ ...f, [key]: value })), []);

  async function save() {
    setError('');
    const leadDays = Number(form.leadDays);
    if (!Number.isSafeInteger(leadDays) || leadDays < 0 || leadDays > 365) {
      setError('Lead days must be a whole number from 0 to 365.'); return;
    }
    setBusy(true);
    try {
      await window.api.trade.reminders.rules.save({
        id: rule?.id, facilityId: form.facilityId || null, leadDays,
        label: form.label.trim() || undefined, enabled: form.enabled,
      });
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
      title={isNew ? 'New reminder rule' : 'Edit reminder rule'}
      busy={busy}
      footer={(
        <div className="tf-actions">
          <span className="tf-actions__spacer" />
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</Button>
        </div>
      )}
    >
      {error ? <p className="field__error">{error}</p> : null}
      <div className="form-grid">
        <Field label="Applies to">
          <Select value={form.facilityId} onChange={(e) => set('facilityId', e.target.value)} disabled={busy}>
            <option value="">All facilities (global rule)</option>
            {facilities.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </Field>
        <Field label="Days before maturity" required hint="0 means the overdue rule, which reminds every day until it is repaid.">
          <Input inputMode="numeric" value={form.leadDays} onChange={(e) => set('leadDays', e.target.value)} disabled={busy} />
        </Field>
        <Field label="Label" hint="Leave blank to use a plain description." span>
          <Input value={form.label} onChange={(e) => set('label', e.target.value)} disabled={busy} maxLength={120} placeholder="e.g. Call the bank about the TR" />
        </Field>
        <Field label="Options" span>
          <label className="finance-check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} disabled={busy} />
            Rule is on
          </label>
        </Field>
      </div>
    </Modal>
  );
}

function SnoozeEditor({ reminder, onClose, onSaved }) {
  const [until, setUntil] = useState(reminder.snoozedUntil || todayISO());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(value) {
    setError('');
    setBusy(true);
    try {
      await window.api.trade.reminders.snooze(reminder.subjectId, value);
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
      title={reminder.snoozed ? 'Wake this reminder' : 'Snooze this reminder'}
      busy={busy}
      footer={(
        <div className="tf-actions">
          {reminder.snoozed ? <Button onClick={() => run(null)} disabled={busy}>Wake now</Button> : null}
          <span className="tf-actions__spacer" />
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => run(until)} disabled={busy || !until}>{busy ? 'Saving…' : 'Snooze until'}</Button>
        </div>
      )}
    >
      {error ? <p className="field__error">{error}</p> : null}
      <Field label="Snooze until" required hint="No reminder for this drawdown before that date. Its maturity date does not change.">
        <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} disabled={busy} />
      </Field>
    </Modal>
  );
}

export function TradeReminders() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const context = useTradeContext();
  const tick = useTradeTick();
  const [state, setState] = useState({ due: [], rules: [], log: [], autoPost: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingRule, setEditingRule] = useState(null); // {} for new
  const [snoozing, setSnoozing] = useState(null);
  const [busy, setBusy] = useState(false);

  const canView = context.permissions.canView;

  const reload = useCallback(() => {
    if (!activeCompanyId || !canView) return undefined;
    let alive = true;
    return Promise.all([
      window.api.trade.reminders.due(),
      window.api.trade.reminders.rules.list(),
      window.api.trade.reminders.log(50),
      window.api.trade.settings.get(),
    ]).then(([due, rules, log, settings]) => {
      if (!alive) return;
      setState({
        due: due?.reminders || [], rules: Array.isArray(rules) ? rules : [],
        log: Array.isArray(log) ? log : [], autoPost: !!settings?.autoPost,
      });
      setError('');
    }).catch((err) => { if (alive) setError(errText(err)); })
      .finally(() => { if (alive) setLoading(false); });
  }, [activeCompanyId, canView]);

  useEffect(() => {
    if (!context.loaded) return undefined;
    if (!activeCompanyId || !canView) { setLoading(false); return undefined; }
    setLoading(true);
    reload();
    // relay() already drops an answer for a company the user has left.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.loaded, reload, tick]);

  async function toggleAutoPost(on) {
    setBusy(true);
    try {
      await window.api.trade.settings.save({ autoPost: on });
      setState((s) => ({ ...s, autoPost: on }));
      addToast(on ? 'Month-end postings will run by themselves' : 'Month-end postings are manual again', 'success');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!activeCompanyId) return <div className="page"><PageHeader title="Reminders" /><p className="muted">Choose a company first.</p></div>;
  if (!context.loaded) return <div className="page"><p className="muted">Loading Trade Finance…</p></div>;
  if (context.error) return <div className="page"><PageHeader title="Reminders" /><LoadError message={context.error} onRetry={() => window.location.reload()} /></div>;

  const canManage = context.permissions.canManage;
  const live = state.due.filter((r) => !r.snoozed);
  const snoozed = state.due.filter((r) => r.snoozed);
  const overdue = live.filter((r) => r.daysTo < 0).length;

  return (
    <div className="page tf-page">
      <PageHeader
        title="Reminders"
        subtitle="Loan maturities, overdraft month-end and scheduled fees — reminded inside this app only."
        actions={canManage ? <Button variant="primary" onClick={() => setEditingRule({})} data-testid="trade-add-rule">+ New rule</Button> : null}
      />

      {error ? <LoadError message={error} onRetry={() => window.location.reload()} /> : null}
      {loading ? <p className="muted">Checking what is due…</p> : null}

      <p className="muted finance-hint">
        Nothing is emailed or messaged. If the app is closed on the day, everything still due appears the next time it opens.
      </p>

      {!loading && !live.length && !snoozed.length ? (
        <EmptyState
          title="Nothing is due."
          body="When a drawdown nears its maturity date, a fee is about to post or an overdraft reaches month-end, it appears here."
        />
      ) : null}

      {live.length ? (
        <section className="finance-section">
          <h2 className="section-title">Due now {overdue ? <Badge tone="rose">{overdue} overdue</Badge> : null}</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>What</th><th>Facility</th><th>Due</th><th>When</th><th className="is-num">Amount</th><th></th></tr>
              </thead>
              <tbody>
                {live.map((r) => (
                  <tr key={`${r.subjectKind}-${r.subjectId}-${r.ruleKey}`} data-testid={`trade-reminder-${r.subjectId}`}>
                    <td>
                      <strong>{r.kind === 'drawdown' ? (r.reference || 'Drawdown') : r.kind === 'od' ? 'Overdraft month-end' : (r.reference || 'Scheduled fee')}</strong>
                      <div className="muted tf-sub">{r.ruleLabel}</div>
                    </td>
                    <td>{r.facilityName}</td>
                    <td>{r.dueDate}</td>
                    <td><Badge tone={TONE(r.daysTo)}>{daysLabel(r.daysTo)}</Badge></td>
                    <td className="is-num">{formatMinor(r.amountMinor, r.currency)}</td>
                    <td>
                      {canManage && r.kind === 'drawdown'
                        ? <Button size="sm" onClick={() => setSnoozing(r)}>Snooze…</Button>
                        : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {snoozed.length ? (
        <section className="finance-section">
          <h2 className="section-title">Snoozed</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>What</th><th>Facility</th><th>Maturity</th><th>Snoozed until</th><th></th></tr></thead>
              <tbody>
                {snoozed.map((r) => (
                  <tr key={`${r.subjectKind}-${r.subjectId}`}>
                    <td>{r.reference || 'Drawdown'}</td>
                    <td>{r.facilityName}</td>
                    <td>{r.dueDate}</td>
                    <td>{r.snoozedUntil}</td>
                    <td>{canManage ? <Button size="sm" onClick={() => setSnoozing(r)}>Wake…</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="finance-section">
        <h2 className="section-title">Rules</h2>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th className="is-num">Days before</th><th>Applies to</th><th>Label</th><th>State</th><th></th></tr></thead>
            <tbody>
              {state.rules.map((r) => (
                <tr key={r.id}>
                  <td className="is-num">{r.leadDays === 0 ? 'Overdue' : r.leadDays}</td>
                  <td>{r.facilityId ? r.facilityName : <span className="muted">All facilities</span>}</td>
                  <td>{r.label}</td>
                  <td>{r.enabled ? <Badge tone="emerald">On</Badge> : <Badge tone="slate">Off</Badge>}</td>
                  <td>{canManage ? <Button size="sm" onClick={() => setEditingRule(r)}>Edit</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted finance-hint">
          A facility with its own rules uses them instead of the global set. Rules are switched off, never deleted — a past send stays in the log.
        </p>
      </section>

      <section className="finance-section">
        <h2 className="section-title">Month-end</h2>
        <label className="finance-check">
          <input type="checkbox" checked={state.autoPost} disabled={!canManage || busy} onChange={(e) => toggleAutoPost(e.target.checked)} />
          Post month-end overdraft interest and due scheduled fees automatically
        </label>
        <p className="muted finance-hint">
          Off by default. When on, the app posts the completed months and any fee that came due each time it starts and twice a day. The reminders themselves always run.
        </p>
      </section>

      {state.log.length ? (
        <section className="finance-section">
          <h2 className="section-title">Already surfaced</h2>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Date</th><th>What</th></tr></thead>
              <tbody>
                {state.log.map((r) => (
                  <tr key={r.id}><td>{r.sendDate}</td><td>{r.detail || r.subjectKind}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted finance-hint">A reminder before maturity is recorded once; an overdue one once a day. This is the duplicate guard.</p>
        </section>
      ) : null}

      {editingRule ? (
        <RuleEditor
          rule={editingRule.id ? editingRule : null}
          facilities={context.facilities || []}
          onClose={() => setEditingRule(null)}
          onSaved={() => { setEditingRule(null); addToast('Reminder rule saved', 'success'); reload(); }}
        />
      ) : null}
      {snoozing ? (
        <SnoozeEditor
          reminder={snoozing}
          onClose={() => setSnoozing(null)}
          onSaved={() => { setSnoozing(null); addToast('Reminder updated', 'success'); reload(); }}
        />
      ) : null}
    </div>
  );
}
