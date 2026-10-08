/**
 * Fuel F1 — Fill-ups (docs/PEOPLE_AND_FUEL_PLAN.md §5.1).
 *
 *   List     paginated (server-side), photo thumbnails, filters: month,
 *            vehicle, driver, kind, review status; void records on request.
 *   Review   each photo beside the typed readings, one click: Checked,
 *            Needs review, Correct… (a new revision with a reason), Void….
 *   + Add    paper slips (FillForms.jsx).
 *
 * A fuel.record-only user (no fuel.manage) cannot list everyone's fills; they
 * see the fills they entered in the last 60 days and can add slips.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Field, Input, Modal, Pagination, Select, Textarea, cx, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useFuelCaps, useFuelIntent, useFuelLookups, useFuelTick } from './fuelHooks.js';
import { AssetSelect, FuelPhotoLarge, FuelPhotoThumb, LoadError, PhotoStrip, PhotoViewer, ReasonModal, SeverityBadge, StaffSelect } from './FuelShared.jsx';
import { AddFillModal, CorrectFillModal } from './FillForms.jsx';
import { FlagReviewModal } from './FuelOverview.jsx';
import {
  FILL_KINDS, FLAG_STATUS_LABEL, REVIEW_STATUSES, assetLabel, buildReviewQueue, errText, fillKindLabel, flagHeadline,
  fmtLitres, fmtMoney, fmtNumber, fmtWhen, litresSourceLabel, meterSincePrevious, meterWord, monthRange, parseNumber, ppMonthKey,
  recentMonths, reviewStatusOf, staffName, toMinor,
} from './fuelModel.js';

const FILL_EVENTS = ['fill', 'flag', 'asset', 'staff', 'location', 'station', 'settings', 'price', 'meterReset'];

export function FuelFills() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const { canManage, canRecord } = useFuelCaps();
  const lookups = useFuelLookups({ includeRetired: true });
  const intent = useFuelIntent('fuelfills');
  const [mode, setMode] = useState('list'); // 'list' | 'review'
  const [adding, setAdding] = useState(false);
  const [openFillId, setOpenFillId] = useState(null);

  useEffect(() => {
    if (!intent) return;
    if (intent.addFill) setAdding(true);
    if (intent.review && canManage) setMode('review');
    if (intent.reviewFillId && canManage) setOpenFillId(intent.reviewFillId);
  }, [intent, canManage]);
  useEffect(() => { setMode('list'); setOpenFillId(null); }, [activeCompanyId]);

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Fill-ups" /><NoCompanyState purpose="see its fill-ups" /></div>;
  }

  return (
    <div className="page page--fuel">
      <PageHeader
        title="Fill-ups"
        subtitle={mode === 'review' ? 'Check each photo against what was typed.' : 'Every litre that went into a vehicle or machine.'}
        backTo={mode === 'review' ? { label: 'All fill-ups', onClick: () => setMode('list') } : undefined}
        actions={(
          <>
            {canManage && mode === 'list' ? <Button onClick={() => setMode('review')}>Review mode</Button> : null}
            {canRecord ? <Button variant="primary" onClick={() => setAdding(true)}>+ Add fill-up</Button> : null}
          </>
        )}
      />
      {mode === 'review' && canManage
        ? <ReviewMode lookups={lookups} onExit={() => setMode('list')} />
        : canManage
          ? <FillList lookups={lookups} onOpen={setOpenFillId} onAdd={() => setAdding(true)} />
          : <MyFills lookups={lookups} onAdd={() => setAdding(true)} />}

      <AddFillModal open={adding} onClose={() => setAdding(false)} lookups={lookups} canManage={canManage} />
      <Modal open={!!openFillId} onClose={() => setOpenFillId(null)} title="Fill-up" size="xxl">
        {openFillId ? <FillPanel fillId={openFillId} lookups={lookups} onAfterReview={() => setOpenFillId(null)} /> : null}
      </Modal>
    </div>
  );
}

/* ─── list (fuel.manage) ──────────────────────────────────────────────── */

function FillList({ lookups, onOpen, onAdd }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const tick = useFuelTick(FILL_EVENTS);
  const months = useMemo(() => recentMonths(24), []);
  const [filters, setFilters] = useState({ month: ppMonthKey(), assetId: '', driverEmployeeId: '', kind: '', reviewStatus: '', includeVoided: false });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState(null);
  const req = useRef(0);

  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { setPage(0); }, [filters, pageSize, activeCompanyId]);
  // L4: a company switch drops the old rows and the old company's vehicle/driver filters.
  const companyRef = useRef(activeCompanyId);
  useEffect(() => {
    if (companyRef.current === activeCompanyId) return;
    companyRef.current = activeCompanyId;
    setData({ items: [], total: 0 });
    setFilters((f) => ({ ...f, assetId: '', driverEmployeeId: '' }));
  }, [activeCompanyId]);
  useEffect(() => {
    const r = ++req.current;
    if (!activeCompanyId) return;
    setLoading(true);
    const range = filters.month ? monthRange(filters.month) : null;
    window.api.fuel.listFills({
      from: range?.from, to: range?.to,
      assetId: filters.assetId || undefined,
      driverEmployeeId: filters.driverEmployeeId || undefined,
      kind: filters.kind || undefined,
      reviewStatus: filters.reviewStatus || undefined,
      includeVoided: filters.includeVoided || undefined,
      limit: pageSize, offset: page * pageSize,
    }).then((res) => { if (r === req.current) { setData(res || { items: [], total: 0 }); setLoadError(''); } })
      .catch((err) => { if (r === req.current) { setData({ items: [], total: 0 }); setLoadError(errText(err)); } })
      .finally(() => { if (r === req.current) setLoading(false); });
  }, [filters, page, pageSize, tick, retry, activeCompanyId]);

  const { currentPage, maxPage, pageStart, pageEnd } = paginate(data.total, page, pageSize);
  useEffect(() => { if (page > maxPage) setPage(maxPage); }, [page, maxPage]);
  const setF = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered = filters.assetId || filters.driverEmployeeId || filters.kind || filters.reviewStatus;

  return (
    <>
      <div className="toolbar fuel-toolbar">
        <Select className="fuel-month-select" aria-label="Month" value={filters.month} onChange={(e) => setF('month')(e.target.value)}>
          <option value="">All months</option>
          {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <AssetSelect assets={lookups.assets} value={filters.assetId} onChange={setF('assetId')} includeAll />
        <StaffSelect staff={lookups.staff} value={filters.driverEmployeeId} onChange={setF('driverEmployeeId')} includeAll allLabel="All drivers" />
        <Select aria-label="Where from" value={filters.kind} onChange={(e) => setF('kind')(e.target.value)}>
          <option value="">Tank, farm and cash</option>
          {FILL_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </Select>
        <Select aria-label="Review status" value={filters.reviewStatus} onChange={(e) => setF('reviewStatus')(e.target.value)}>
          <option value="">Any review status</option>
          {REVIEW_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
        <label className="list-tools__all">
          <input type="checkbox" checked={filters.includeVoided} onChange={(e) => setF('includeVoided')(e.target.checked)} />
          <span>Show void</span>
        </label>
        <div className="toolbar__spacer" />
        <span className="toolbar__count">{data.total} fill-up{data.total === 1 ? '' : 's'}</span>
      </div>

      {loadError ? <LoadError message={loadError} onRetry={() => setRetry((n) => n + 1)} /> : loading && !data.items.length ? <p className="muted">Loading…</p> : data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No fill-ups match' : 'No fill-ups this month'}
          body={filtered ? 'Change a filter to see more.' : 'Fill-ups from the phones appear here as they are saved. Paper slips can be added by hand.'}
          action={filtered ? <Button onClick={() => setFilters((f) => ({ ...f, assetId: '', driverEmployeeId: '', kind: '', reviewStatus: '' }))}>Clear filters</Button> : <Button variant="primary" onClick={onAdd}>+ Add fill-up</Button>}
        />
      ) : (
        <>
          <div className="data-table-wrap" aria-busy={loading || undefined}>
            <table className="data-table">
              <thead>
                <tr><th>Photos</th><th>When</th><th>Vehicle or machine</th><th>From</th><th>Driver</th><th className="is-num">Litres</th><th className="is-num">Meter</th><th className="is-num">Paid</th><th>Flags</th><th>Review</th></tr>
              </thead>
              <tbody>
                {data.items.map((f) => (
                  <FillRow key={f.id} fill={f} lookups={lookups} onOpen={() => onOpen(f.id)} onPhoto={(i) => setViewer({ photos: f.photos, index: i })} />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={data.total} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      )}
      <PhotoViewer open={!!viewer} photos={viewer?.photos} index={viewer?.index || 0} onClose={() => setViewer(null)} />
    </>
  );
}

function fromLabel(f, lookups) {
  if (f.kind === 'cash_station') return lookups.maps.stations.get(f.stationId)?.name || 'Station';
  return lookups.maps.locations.get(f.locationId)?.name || fillKindLabel(f.kind);
}

function FillRow({ fill: f, lookups, onOpen, onPhoto }) {
  const asset = lookups.maps.assets.get(f.assetId);
  const driver = f.driverEmployeeId ? lookups.maps.staff.get(f.driverEmployeeId) : null;
  const rs = reviewStatusOf(f.reviewStatus);
  return (
    <tr className={cx('is-clickable', f.voided && 'is-muted')} onClick={onOpen}>
      <td><PhotoStrip photos={f.photos} size={40} max={3} onOpen={onPhoto} /></td>
      <td>{fmtWhen(f.at)}{f.source === 'phone' ? <div className="muted">phone</div> : null}</td>
      <td>{asset ? assetLabel(asset) : '—'}</td>
      <td>{fromLabel(f, lookups)}<div className="muted">{fillKindLabel(f.kind)}</div></td>
      <td>{driver ? staffName(driver) : <span className="muted">—</span>}</td>
      <td className="is-num">{fmtLitres(f.litres)}{f.fullTank ? <div className="muted">full</div> : null}</td>
      <td className="is-num">{f.meterReading != null ? fmtNumber(f.meterReading, 1) : '—'}</td>
      <td className="is-num">{f.amountPaidMinor != null ? fmtMoney(f.amountPaidMinor, f.currency) : '—'}</td>
      <td>{f.openFlags ? <Badge tone={f.hasRedFlag ? 'rose' : 'amber'}>{f.openFlags} open</Badge> : <span className="muted">—</span>}</td>
      <td>{f.voided ? <Badge tone="slate">Void</Badge> : <Badge tone={rs.tone}>{rs.label}</Badge>}{f.supersedesId ? <div className="muted">corrected</div> : null}</td>
    </tr>
  );
}

/* ─── a fuel.record-only user: their own entries ──────────────────────── */

function MyFills({ lookups, onAdd }) {
  const addToast = useAppStore((s) => s.addToast);
  const tick = useFuelTick(['fill']);
  const [fills, setFills] = useState([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [voiding, setVoiding] = useState(null);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  useEffect(() => {
    // L4: reload for the active company; a late answer for another one is dropped.
    let alive = true;
    setFills([]);
    if (!activeCompanyId) return undefined;
    window.api.fuel.listMyRecent({ days: 60 })
      .then((r) => { if (alive) setFills(r?.fills || []); })
      .catch((err) => { if (alive) addToast(errText(err), 'error'); });
    return () => { alive = false; };
  }, [activeCompanyId, tick, addToast]);
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(fills.length, page, pageSize);
  if (!fills.length) {
    return <EmptyState title="No fill-ups from you yet" body="Fill-ups you add from paper slips (or the phone) in the last 60 days are listed here." action={<Button variant="primary" onClick={onAdd}>+ Add fill-up</Button>} />;
  }
  return (
    <>
      <p className="muted fuel-note">Your own entries from the last 60 days. Reviewing everyone's fill-ups needs the “Manage fuel &amp; staff list” permission.</p>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th>When</th><th>Vehicle or machine</th><th>From</th><th className="is-num">Litres</th><th>Review</th><th className="is-actions" /></tr></thead>
          <tbody>
            {fills.slice(pageStart, pageEnd).map((f) => {
              const fresh = !f.voided && f.reviewStatus === 'new' && Date.now() - (f.recordedAt || f.createdAt) < 86_400_000;
              return (
                <tr key={f.id} className={f.voided ? 'is-muted' : ''}>
                  <td>{fmtWhen(f.at)}</td>
                  <td>{assetLabel(lookups.maps.assets.get(f.assetId))}</td>
                  <td>{fromLabel(f, lookups)}</td>
                  <td className="is-num">{fmtLitres(f.litres)}</td>
                  <td>{f.voided ? <Badge tone="slate">Void</Badge> : <Badge tone={reviewStatusOf(f.reviewStatus).tone}>{reviewStatusOf(f.reviewStatus).label}</Badge>}</td>
                  <td className="is-actions">{fresh ? <Button size="sm" variant="ghost" onClick={() => setVoiding(f)}>Void…</Button> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination total={fills.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
      <ReasonModal
        open={!!voiding}
        title="Void this fill-up?"
        message="It stays in the history, marked void. You can void your own entry within 24 hours, before it is reviewed."
        confirmLabel="Void fill-up"
        danger
        onCancel={() => setVoiding(null)}
        onConfirm={async (reason) => {
          await window.api.fuel.voidMyRecord('fill', voiding.id, reason);
          setVoiding(null);
          addToast('Fill-up voided.', 'success');
        }}
      />
    </>
  );
}

/* ─── review mode ─────────────────────────────────────────────────────── */

function ReviewMode({ lookups, onExit }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const tick = useFuelTick(['fill', 'flag']);
  const [queue, setQueue] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const req = useRef(0);

  useEffect(() => {
    const r = ++req.current;
    // L6: the OLDEST waiting fills first, and the server's true count — not
    // the newest 500 of each status, which left old ones waiting unseen.
    window.api.fuel.listFills({ reviewStatus: 'waiting', order: 'oldest', limit: 500 }).then((res) => {
      if (r !== req.current) return;
      const q = buildReviewQueue(res?.items || []);
      setQueue(q);
      setTotal(Math.max(res?.total || 0, q.length));
      // Keep the fill on screen when the queue refreshes under it (a phone upload).
      setCurrentId((cur) => (cur && q.some((f) => f.id === cur) ? cur : q[0]?.id ?? null));
    }).catch((err) => { if (r === req.current) addToast(`Couldn't load the review queue: ${errText(err)}`, 'error'); });
  }, [tick, activeCompanyId, addToast]);
  useEffect(() => { setQueue(null); setDone(0); setTotal(0); }, [activeCompanyId]); // L4

  const index = queue ? queue.findIndex((f) => f.id === currentId) : -1;
  const go = useCallback((delta) => {
    if (!queue?.length) return;
    const i = Math.min(queue.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
    setCurrentId(queue[i].id);
  }, [queue, index]);

  function afterReview(reviewedId) {
    setDone((n) => n + 1);
    setTotal((n) => Math.max(0, n - 1));
    if (!queue) return;
    const rest = queue.filter((f) => f.id !== reviewedId);
    const next = rest[Math.min(Math.max(index, 0), rest.length - 1)] || null;
    setQueue(rest);
    setCurrentId(next?.id ?? null);
  }

  if (!queue) return <p className="muted">Loading the review queue…</p>;
  if (!queue.length) {
    return (
      <EmptyState
        title={done ? `All done — ${done} reviewed` : 'Nothing to review'}
        body="New fill-ups from the phones and paper slips will wait here."
        action={<Button variant="primary" onClick={onExit}>Back to all fill-ups</Button>}
      />
    );
  }
  return (
    <div className="fuel-review">
      <div className="toolbar">
        <span className="toolbar__count">
          {index + 1} of {total} waiting, oldest first{done ? ` · ${done} reviewed` : ''}
          {total > queue.length ? ` · the oldest ${queue.length} are loaded; the rest follow` : ''}
        </span>
        <div className="toolbar__spacer" />
        <Button onClick={() => go(-1)} disabled={index <= 0}>← Previous</Button>
        <Button onClick={() => go(1)} disabled={index >= queue.length - 1}>Skip →</Button>
      </div>
      {currentId ? <FillPanel key={currentId} fillId={currentId} lookups={lookups} onAfterReview={() => afterReview(currentId)} /> : null}
    </div>
  );
}

/* ─── one fill: photos beside the readings ────────────────────────────── */

export function FillPanel({ fillId, lookups, onAfterReview }) {
  const addToast = useAppStore((s) => s.addToast);
  const tick = useFuelTick(['fill', 'flag']);
  const [fill, setFill] = useState(null);
  const [error, setError] = useState('');
  const [photoIndex, setPhotoIndex] = useState(0);
  const [note, setNote] = useState('');
  const [seenAmount, setSeenAmount] = useState('');
  const [seenLitres, setSeenLitres] = useState('');
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [flagReview, setFlagReview] = useState(null);

  useEffect(() => {
    let alive = true;
    window.api.fuel.getFill(fillId)
      .then((f) => { if (alive) { setFill(f); setError(''); } })
      .catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [fillId, tick]);
  useEffect(() => {
    setNote(''); setSeenAmount(''); setSeenLitres(''); setPhotoIndex(0);
  }, [fillId]);

  if (error) return <p className="muted">Couldn't open this fill-up: {error}</p>;
  if (!fill) return <p className="muted">Loading…</p>;

  const photos = (fill.photos || []).filter((p) => !p.retired);
  const asset = lookups.maps.assets.get(fill.assetId);
  const driver = fill.driverEmployeeId ? lookups.maps.staff.get(fill.driverEmployeeId) : null;
  const attendant = fill.attendantEmployeeId ? lookups.maps.staff.get(fill.attendantEmployeeId) : null;
  const cash = fill.kind === 'cash_station';
  const openFlags = (fill.flags || []).filter((f) => !f.resolved);
  const cur = fill.currency || 'KHR';
  const since = meterSincePrevious(fill, fill.previousMeterFill, fill.resetsSince);
  const impliedPerL = cash && fill.amountPaidMinor && fill.litresShownOnPump ? fill.amountPaidMinor / fill.litresShownOnPump : null;

  async function review(status) {
    if (status === 'needs_review' && !note.trim()) { addToast('Add a note saying what needs a second look.', 'error'); return; }
    const args = { id: fill.id, status, note: note.trim() || undefined };
    const amt = parseNumber(seenAmount);
    const lit = parseNumber(seenLitres);
    if (Number.isNaN(amt) || Number.isNaN(lit)) { addToast('What the photo shows must be numbers.', 'error'); return; }
    if (amt != null) args.reviewedAmountMinor = toMinor(amt, cur);
    if (lit != null) args.reviewedLitres = lit;
    setBusy(true);
    try {
      const res = await window.api.fuel.reviewFill(args);
      const c5 = (res?.flags || []).find((f) => f.ruleKey === 'C5' && !f.resolved);
      if (c5) addToast(`Saved — the photo disagrees with what was typed (C5 flag).`, 'info');
      else addToast(status === 'checked' ? 'Checked.' : 'Marked “needs review”.', 'success');
      onAfterReview?.();
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div className="fuel-panel">
      <div className="fuel-panel__photos">
        {photos.length ? (
          <>
            <FuelPhotoLarge photo={photos[Math.min(photoIndex, photos.length - 1)]} />
            {photos.length > 1 ? (
              <div className="fuel-photo-strip">
                {photos.map((p, i) => (
                  <span key={p.id} className={i === photoIndex ? 'is-active' : ''}><FuelPhotoThumb photo={p} size={56} onOpen={() => setPhotoIndex(i)} /></span>
                ))}
              </div>
            ) : null}
          </>
        ) : <div className="fuel-photo-large is-empty"><span className="muted">No photos with this fill-up.</span></div>}
      </div>

      <div className="fuel-panel__facts">
        <div className="fuel-panel__head">
          <h2 className="section-title">{asset ? assetLabel(asset) : 'Vehicle'} — {fmtLitres(fill.litres)}</h2>
          {fill.voided ? <Badge tone="slate">Void</Badge> : <Badge tone={reviewStatusOf(fill.reviewStatus).tone}>{reviewStatusOf(fill.reviewStatus).label}</Badge>}
        </div>
        {fill.voided ? <p className="muted">Void: {fill.voidReason}</p> : null}
        <dl className="fuel-dl">
          <dt>When</dt><dd>{fmtWhen(fill.at)} <span className="muted">· entered from {fill.source === 'phone' ? 'a phone' : fill.source === 'import' ? 'an import' : 'a Mac'}</span></dd>
          <dt>From</dt><dd>{fromLabel(fill, lookups)} <span className="muted">· {fillKindLabel(fill.kind)}</span></dd>
          <dt>Driver</dt><dd>{driver ? staffName(driver) : '—'}</dd>
          {!cash ? <><dt>Attendant</dt><dd>{attendant ? staffName(attendant) : '—'}</dd></> : null}
          <dt>Litres</dt><dd>{fmtLitres(fill.litres, 2)} <span className="muted">· {litresSourceLabel(fill.litresSource)}</span>{fill.typedLitres != null && fill.litresSource === 'pump_meter' ? <span className="muted"> · typed {fmtLitres(fill.typedLitres, 2)}</span> : null}</dd>
          {fill.cansCount ? <><dt>Cans</dt><dd>{fill.cansCount} × {fmtLitres(fill.canSizeL, 0)}</dd></> : null}
          {fill.pumpMeterBefore != null ? <><dt>Pump meter</dt><dd>{fmtNumber(fill.pumpMeterBefore, 2)} → {fmtNumber(fill.pumpMeterAfter, 2)}</dd></> : null}
          {asset?.meterUnit !== 'none' ? <><dt>{meterWord(asset?.meterUnit)}</dt><dd>{fill.meterReading != null ? fmtNumber(fill.meterReading, 1) : <span className="fuel-missing">not entered</span>}</dd></> : null}
          {asset?.meterUnit !== 'none' && fill.previousMeterFill ? (
            <>
              <dt>Previous reading</dt>
              <dd>
                {fmtNumber(fill.previousMeterFill.meterReading, 1)} <span className="muted">· {fmtWhen(fill.previousMeterFill.at)}</span>
                {since ? (since.backwards
                  ? <div className="fuel-missing">Lower than the previous reading{since.reset ? ' (after the meter reset)' : ''}</div>
                  : <div className="muted">+{fmtNumber(since.distance, 1)} {asset?.meterUnit === 'hours' ? 'h' : 'km'} since{since.reset ? ', counting the meter reset' : ''}</div>) : null}
              </dd>
            </>
          ) : null}
          {fill.previousFill ? (
            <>
              <dt>Previous fill</dt>
              <dd>
                {fmtWhen(fill.previousFill.at)} <span className="muted">· {fmtLitres(fill.previousFill.litres)} · {fromLabel(fill.previousFill, lookups)}{fill.previousFill.fullTank ? ' · full' : ''}</span>
              </dd>
            </>
          ) : null}
          <dt>Full tank</dt><dd>{fill.fullTank ? 'Yes' : 'No'}</dd>
          {cash ? (
            <>
              <dt>Paid</dt><dd>{fmtMoney(fill.amountPaidMinor, cur)}</dd>
              <dt>On the pump</dt><dd>{fill.litresShownOnPump != null ? fmtLitres(fill.litresShownOnPump, 2) : <span className="fuel-missing">not entered</span>}</dd>
              {impliedPerL ? <><dt>Price paid</dt><dd>{fmtMoney(Math.round(impliedPerL), cur)} per litre</dd></> : null}
            </>
          ) : null}
          {fill.note ? <><dt>Note</dt><dd>{fill.note}</dd></> : null}
          {fill.reviewNote ? <><dt>Review note</dt><dd>{fill.reviewNote}</dd></> : null}
        </dl>

        {openFlags.length ? (
          <div className="fuel-subsection">
            <h3 className="section-title">Flags</h3>
            <ul className="fuel-flag-list fuel-flag-list--compact">
              {openFlags.map((f) => (
                <li key={f.id} className={`fuel-flag fuel-flag--${f.severity}`}>
                  <div className="fuel-flag__main">
                    <div className="fuel-flag__title"><SeverityBadge severity={f.severity} /><strong>{flagHeadline(f, lookups.maps)}</strong></div>
                    <p className="fuel-flag__why">{f.explanation}</p>
                    {f.status !== 'open' ? <p className="muted fuel-flag__meta">{FLAG_STATUS_LABEL[f.status]}{f.reviewNote ? `: ${f.reviewNote}` : ''}</p> : null}
                  </div>
                  <div className="fuel-flag__actions"><Button size="sm" onClick={() => setFlagReview(f)}>{f.status === 'open' ? 'Answer…' : 'Change…'}</Button></div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {(fill.revisions || []).length > 1 ? (
          <div className="fuel-subsection">
            <h3 className="section-title">History</h3>
            <ul className="fuel-plain-list">
              {fill.revisions.map((r, i) => (
                <li key={r.id} className={r.id === fill.id ? '' : 'is-muted'}>
                  Version {i + 1} · {fmtWhen(r.createdAt)} · {fmtLitres(r.litres)}{r.meterReading != null ? ` · meter ${fmtNumber(r.meterReading, 1)}` : ''}
                  {r.correctionReason ? ` · “${r.correctionReason}”` : ' · as entered'}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!fill.voided ? (
          <div className="fuel-subsection fuel-review-box">
            {cash ? (
              <div className="form-grid">
                <Field label={`Amount the pump photo shows (${cur})`} hint="Fill in if it disagrees — that raises a flag.">
                  {({ id }) => <Input id={id} inputMode="decimal" value={seenAmount} onChange={(e) => setSeenAmount(e.target.value)} />}
                </Field>
                <Field label="Litres the pump photo shows">
                  {({ id }) => <Input id={id} inputMode="decimal" value={seenLitres} onChange={(e) => setSeenLitres(e.target.value)} />}
                </Field>
              </div>
            ) : null}
            <Field label="Review note" hint="Optional for Checked; needed for Needs review.">
              {({ id }) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <div className="fuel-review-box__actions">
              <Button variant="primary" onClick={() => review('checked')} disabled={busy}>Checked</Button>
              <Button onClick={() => review('needs_review')} disabled={busy}>Needs review</Button>
              <Button onClick={() => setCorrecting(true)} disabled={busy}>Correct…</Button>
              <Button variant="danger" onClick={() => setVoiding(true)} disabled={busy}>Void…</Button>
            </div>
          </div>
        ) : null}
      </div>

      <CorrectFillModal fill={correcting ? fill : null} lookups={lookups} onClose={() => setCorrecting(false)} onDone={() => onAfterReview?.()} />
      <ReasonModal
        open={voiding}
        title="Void this fill-up?"
        message="It stays in the history, marked void, and no longer counts in any total or check."
        confirmLabel="Void fill-up"
        danger
        onCancel={() => setVoiding(false)}
        onConfirm={async (reason) => {
          await window.api.fuel.voidRecord('fill', fill.id, reason);
          setVoiding(false);
          addToast('Fill-up voided.', 'success');
          onAfterReview?.();
        }}
      />
      <FlagReviewModal flag={flagReview} lookups={lookups.maps} onClose={() => setFlagReview(null)} />
    </div>
  );
}
