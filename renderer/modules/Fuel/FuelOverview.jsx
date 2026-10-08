/**
 * Fuel F1 — Fuel overview (docs/PEOPLE_AND_FUEL_PLAN.md §5.1): open flags by
 * severity in plain English, this month's excess riel, the last dip per tank
 * (warns when it is stale), and the fill-ups waiting for a reviewer. Each flag
 * can be answered here: Checked — OK / Theft confirmed / Error corrected.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Modal, Pagination, Textarea, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useFuelCaps, useFuelLookups, useFuelTick } from './fuelHooks.js';
import { ManageOnlyNote, SeverityBadge } from './FuelShared.jsx';
import { FuelPhoneSetupSlot } from './PhoneSetupSlot.jsx';
import {
  FLAG_ACTIONS, FLAG_STATUS_LABEL, dipAge, flagHeadline, flagReviewError, fmtDay, fmtLitres, fmtNumber, fmtRiel,
  fmtWhen, monthLabel, ruleTitle, sortFlags, staffName, errText,
} from './fuelModel.js';

const FLAG_VIEWS = [
  { value: 'open', label: 'Open' },
  { value: 'dismissed', label: 'Checked — OK' },
  { value: 'confirmed', label: 'Theft confirmed' },
  { value: 'explained', label: 'Error corrected' },
];

export function FuelOverview() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const openFuel = useAppStore((s) => s.openFuel);
  const { canManage } = useFuelCaps();
  const lookups = useFuelLookups({ includeRetired: true });
  const tick = useFuelTick(['fill', 'flag', 'dip', 'delivery', 'transfer', 'location', 'asset', 'settings', 'price', 'meterReset']);

  const [overview, setOverview] = useState(null);
  const [flags, setFlags] = useState({ items: [], total: 0 });
  const [view, setView] = useState('open');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(null);
  const [rechecking, setRechecking] = useState(false);
  const [phonesOpen, setPhonesOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const req = useRef(0);

  useEffect(() => { setPage(0); }, [view, pageSize, activeCompanyId]);

  useEffect(() => {
    if (!activeCompanyId || !canManage) { setLoading(false); return; }
    const r = ++req.current;
    setLoading(true);
    Promise.all([
      window.api.fuel.getOverview(),
      window.api.fuel.listFlags({ status: view, limit: pageSize, offset: page * pageSize }),
    ]).then(([ov, fl]) => {
      if (r !== req.current) return;
      setOverview(ov);
      setFlags(fl || { items: [], total: 0 });
    }).catch((err) => {
      if (r === req.current) addToast(`Couldn't load the fuel overview: ${err.message}`, 'error');
    }).finally(() => { if (r === req.current) setLoading(false); });
  }, [activeCompanyId, canManage, view, page, pageSize, tick, reload, addToast]);

  const sorted = useMemo(() => sortFlags(flags.items), [flags.items]);
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(flags.total, page, pageSize);
  // A flag answered here leaves the "Open" page; clamp when the page empties.
  useEffect(() => { if (page > maxPage) setPage(maxPage); }, [page, maxPage]);

  async function recheck() {
    setRechecking(true);
    try {
      const res = await window.api.fuel.recomputeFlags();
      addToast(res?.opened ? `Checked everything — ${res.opened} new flag${res.opened === 1 ? '' : 's'}.` : 'Checked everything — no new flags.', 'success');
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setRechecking(false); setReload((n) => n + 1); }
  }

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Fuel overview" /><NoCompanyState purpose="see its fuel" /></div>;
  }
  if (!canManage) {
    return <div className="page"><PageHeader title="Fuel overview" /><ManageOnlyNote /></div>;
  }

  const toReview = (overview?.fillsToReview?.new || 0) + (overview?.fillsToReview?.needs_review || 0);
  const missedDipDays = lookups.settings?.missedDipDays ?? 2;
  const emptySetup = lookups.loaded && lookups.assets.length === 0 && lookups.locations.length === 0;

  return (
    <div className="page page--fuel">
      <PageHeader
        title="Fuel overview"
        subtitle={overview?.month ? `What needs a look — ${monthLabel(overview.month)}.` : 'What needs a look this month.'}
        actions={(
          <>
            <Button onClick={() => setPhonesOpen(true)}>Set up a phone…</Button>
            <Button onClick={recheck} disabled={rechecking}>{rechecking ? 'Checking…' : 'Check everything again'}</Button>
            <Button variant="primary" onClick={() => openFuel('fuelfills', { review: true })} disabled={!toReview}>
              {toReview ? `Review ${toReview} fill-up${toReview === 1 ? '' : 's'}` : 'Nothing to review'}
            </Button>
          </>
        )}
      />

      {emptySetup ? (
        <EmptyState
          className="fuel-setup-empty"
          title="Fuel is not set up yet"
          body="Add your vehicles and machines, then your tanks, so fill-ups and dips have somewhere to go."
          action={<Button variant="primary" onClick={() => openFuel('fuelassets', { add: true })}>+ New vehicle or machine</Button>}
          secondaryAction={<Button onClick={() => openFuel('fueltanks', { add: true })}>+ New tank</Button>}
        />
      ) : null}

      <div className="stat-grid fuel-stats">
        <Stat label="Red flags" value={overview?.openFlags?.red ?? '—'} tone={overview?.openFlags?.red ? 'rose' : null} hint="Likely missing fuel — look first" />
        <Stat label="Amber flags" value={overview?.openFlags?.amber ?? '—'} tone={overview?.openFlags?.amber ? 'amber' : null} hint="Unusual — worth a check" />
        <Stat label="Fill-ups to review" value={overview ? toReview : '—'} hint={overview?.fillsToReview?.needs_review ? `${overview.fillsToReview.needs_review} marked "needs review"` : 'New entries from phones and slips'} />
        <Stat
          label="Excess this month"
          value={overview?.excessRiel == null ? '—' : fmtRiel(overview.excessRiel)}
          tone={overview?.excessRiel > 0 ? 'rose' : null}
          hint="Fuel used above each vehicle's normal, in riel"
        />
      </div>

      <section className="fuel-section">
        <div className="section-head">
          <h2 className="section-title">Flags</h2>
          <span className="section-hint">One flag is not proof — the pattern over a month is.</span>
          <div className="section-head__actions">
            <div className="segments" role="tablist" aria-label="Which flags">
              {FLAG_VIEWS.map((v) => (
                <button key={v.value} type="button" className={`segment${view === v.value ? ' is-active' : ''}`} onClick={() => setView(v.value)}>{v.label}</button>
              ))}
            </div>
          </div>
        </div>
        {loading && !sorted.length ? (
          <p className="muted">Loading…</p>
        ) : sorted.length === 0 ? (
          <EmptyState
            title={view === 'open' ? 'No open flags' : `Nothing marked “${FLAG_STATUS_LABEL[view]}”`}
            body={view === 'open' ? 'Every check passed, or every flag has been answered.' : 'Flags you answer this way are listed here.'}
          />
        ) : (
          <>
            <ul className="fuel-flag-list">
              {sorted.map((f) => (
                <FlagRow key={f.id} flag={f} lookups={lookups.maps} onReview={() => setReviewing(f)} onOpenFill={(id) => openFuel('fuelfills', { reviewFillId: id })} />
              ))}
            </ul>
            <Pagination
              total={flags.total}
              pageStart={pageStart}
              pageEnd={pageEnd}
              currentPage={currentPage}
              maxPage={maxPage}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </>
        )}
      </section>

      <section className="fuel-section">
        <div className="section-head">
          <h2 className="section-title">Tanks and farm stores</h2>
          <span className="section-hint">Last dip of each — dip every {missedDipDays} day{missedDipDays === 1 ? '' : 's'}.</span>
          <div className="section-head__actions">
            <Button size="sm" onClick={() => openFuel('fueltanks')}>Open Tanks &amp; dips</Button>
          </div>
        </div>
        {!overview?.tanks?.length ? (
          <p className="muted">No tanks yet.</p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Tank</th><th>Kind</th><th>Last dip</th><th className="is-num">Dip</th><th className="is-num">Litres</th><th className="is-num">Capacity</th></tr></thead>
              <tbody>
                {overview.tanks.map((t) => {
                  const age = dipAge(t.lastDip, missedDipDays);
                  return (
                    <tr key={t.locationId} className="is-clickable" onClick={() => openFuel('fueltanks', { locationId: t.locationId })}>
                      <td><strong>{t.name}</strong>{!t.hasChart && t.kind === 'tank' ? <span className="muted"> · no dip chart</span> : null}</td>
                      <td>{t.kind === 'farm_store' ? 'Farm store' : 'Tank'}{t.hasFlowMeter ? ' · flow meter' : ''}</td>
                      <td>
                        {t.lastDip ? fmtWhen(t.lastDip.takenAt) : 'Never dipped'}
                        {age.stale && t.kind === 'tank' ? <> <Badge tone="amber">{age.never ? 'Dip it' : `${age.days} days ago`}</Badge></> : null}
                      </td>
                      <td className="is-num">{t.lastDip?.dipCm != null ? `${fmtNumber(t.lastDip.dipCm, 1)} cm` : '—'}</td>
                      <td className="is-num">{fmtLitres(t.lastDip?.litres, 0)}</td>
                      <td className="is-num">{fmtLitres(t.capacityL, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {overview?.pendingTransfers ? (
          <p className="muted fuel-note">{overview.pendingTransfers} transfer{overview.pendingTransfers === 1 ? '' : 's'} to a farm store not yet received.</p>
        ) : null}
      </section>

      <FlagReviewModal flag={reviewing} lookups={lookups.maps} onClose={() => setReviewing(null)} />
      <Modal open={phonesOpen} onClose={() => setPhonesOpen(false)} title="Set up a phone" size="lg">
        <FuelPhoneSetupSlot onDone={() => setPhonesOpen(false)} />
      </Modal>
    </div>
  );
}

function Stat({ label, value, hint, tone }) {
  return (
    <div className={`stat-card${tone ? ` fuel-stat--${tone}` : ''}`}>
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value">{value}</div>
      {hint ? <div className="stat-card__hint">{hint}</div> : null}
    </div>
  );
}

export function FlagRow({ flag, lookups, onReview, onOpenFill }) {
  const who = flag.employeeId ? lookups.staff.get(flag.employeeId) : null;
  const fillId = flag.subjectKind === 'fill' ? flag.subjectId : null;
  return (
    <li className={`fuel-flag fuel-flag--${flag.severity}`}>
      <div className="fuel-flag__main">
        <div className="fuel-flag__title">
          <SeverityBadge severity={flag.severity} />
          <strong>{flagHeadline(flag, lookups)}</strong>
        </div>
        <p className="fuel-flag__why">{flag.explanation}</p>
        <p className="fuel-flag__meta muted">
          {ruleTitle(flag.ruleKey)} ({flag.ruleKey}) · {flag.at ? fmtDay(flag.at) : '—'}
          {who ? ` · ${staffName(who)}` : ''}
          {flag.status !== 'open' ? ` · ${FLAG_STATUS_LABEL[flag.status]}${flag.reviewNote ? `: ${flag.reviewNote}` : ''}` : ''}
          {flag.resolved ? ' · no longer fires' : ''}
        </p>
      </div>
      <div className="fuel-flag__actions">
        {fillId && onOpenFill ? <Button size="sm" onClick={() => onOpenFill(fillId)}>Open fill-up</Button> : null}
        {onReview ? <Button size="sm" onClick={onReview}>{flag.status === 'open' ? 'Answer…' : 'Change…'}</Button> : null}
      </div>
    </li>
  );
}

/** Checked — OK / Theft confirmed / Error corrected, with a note. Also re-opens. */
export function FlagReviewModal({ flag, lookups, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const [status, setStatus] = useState('dismissed');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!flag) return;
    setStatus(flag.status !== 'open' ? flag.status : 'dismissed');
    setNote(flag.reviewNote || '');
    setError('');
    setBusy(false);
  }, [flag]);
  async function save(nextStatus = status) {
    const err = nextStatus === 'open' ? null : flagReviewError(nextStatus, note);
    if (err) { setError(err); return; }
    setBusy(true);
    try {
      const saved = await window.api.fuel.reviewFlag(flag.id, nextStatus, note.trim() || null);
      addToast(nextStatus === 'open' ? 'Flag opened again.' : `Saved: ${FLAG_STATUS_LABEL[nextStatus]}.`, 'success');
      onDone?.(saved);
      onClose();
    } catch (e) { setError(errText(e)); setBusy(false); }
  }
  const unit = flag?.unit ? ` ${flag.unit}` : '';
  return (
    <Modal
      open={!!flag}
      onClose={onClose}
      busy={busy}
      title="Answer this flag"
      footer={(
        <>
          {flag && flag.status !== 'open' ? <Button variant="ghost" onClick={() => save('open')} disabled={busy}>Open it again</Button> : null}
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : 'Save answer'}</Button>
        </>
      )}
    >
      {flag ? (
        <div className="fuel-flag-review">
          <div className="fuel-flag__title"><SeverityBadge severity={flag.severity} /><strong>{flagHeadline(flag, lookups)}</strong></div>
          <p className="fuel-flag__why">{flag.explanation}</p>
          {flag.measured != null || flag.expected != null ? (
            <dl className="fuel-dl">
              {flag.measured != null ? <><dt>Measured</dt><dd>{fmtNumber(flag.measured, 2)}{unit}</dd></> : null}
              {flag.expected != null ? <><dt>Expected</dt><dd>{fmtNumber(flag.expected, 2)}{unit}</dd></> : null}
              {flag.threshold != null ? <><dt>Threshold</dt><dd>{fmtNumber(flag.threshold, 2)}{unit}</dd></> : null}
            </dl>
          ) : null}
          <fieldset className="fuel-choice">
            <legend className="field__label">What did you find?</legend>
            {FLAG_ACTIONS.map((a) => (
              <label key={a.status} className={`fuel-choice__opt${status === a.status ? ' is-active' : ''}`}>
                <input type="radio" name="flag-answer" value={a.status} checked={status === a.status} onChange={() => { setStatus(a.status); setError(''); }} />
                <span><strong>{a.label}</strong><span className="muted"> — {a.hint}</span></span>
              </label>
            ))}
          </fieldset>
          <Field label="Note" required={FLAG_ACTIONS.find((a) => a.status === status)?.needsNote} error={error}>
            {({ id }) => <Textarea id={id} rows={3} value={note} onChange={(e) => { setNote(e.target.value); setError(''); }} placeholder="e.g. Checked the receipt — the driver filled two jerry cans for the generator." />}
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}
