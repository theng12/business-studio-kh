/**
 * Fixed Assets — Depreciation (docs/ASSETS_AND_BRANCHES_PLAN.md §5.5, §8.1):
 * the month list (posted / due / closed / not ended) with each run's total and
 * catch-up; Preview any month (by category, branch or asset), Post the next
 * month due, Reverse the latest run while its month is open; why months from
 * the register start are posted one by one ("catch-up"); and the integrity
 * check (every entry balances; the register equals the books).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Modal, Pagination, cx, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { formatDateTime } from '../../lib/format.js';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { ReasonModal } from '../Fuel/FuelShared.jsx';
import { openAssetPage, useAssetCaps, useAssetLookups, useAssetsTick } from './assetsHooks.js';
import { LoadError, Money, NeedsCapNote, Notice, Segments, openRowProps } from './AssetsShared.jsx';
import { catchUpExplanation, errText, fmtPeriod, fmtUsd, runStatusOf, runsView } from './assetsModel.js';

const TZ = { timeZone: 'Asia/Phnom_Penh' };

export function AssetDepreciation() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useAssetCaps();
  const lookups = useAssetLookups();
  const tick = useAssetsTick(['run', 'asset', 'period', 'settings']);
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState(null); // period
  const [reversing, setReversing] = useState(null); // period
  const [integrity, setIntegrity] = useState(null);
  const [checking, setChecking] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => { setRuns(null); setPreview(null); setReversing(null); setIntegrity(null); setPage(0); }, [activeCompanyId]);
  useEffect(() => {
    if (!activeCompanyId || !caps.canView) return undefined;
    let alive = true;
    window.api.assets.listRuns().then((r) => { if (alive) { setRuns(r); setError(null); } }).catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [activeCompanyId, caps.canView, tick, retry]);

  const view = useMemo(() => runsView(runs), [runs]);
  if (!activeCompanyId) return <div className="page"><PageHeader title="Depreciation" /><NoCompanyState purpose="post its monthly depreciation" /></div>;
  if (!caps.canView) return <div className="page"><PageHeader title="Depreciation" /><NeedsCapNote what="depreciation" /></div>;

  async function check() {
    setChecking(true);
    try { setIntegrity(await window.api.assets.checkIntegrity()); }
    catch (err) { addToast(`Couldn't check: ${errText(err)}`, 'error'); }
    finally { setChecking(false); }
  }
  const latest = view.rows.find((m) => m.status === 'posted' && m.run);
  const canReverse = (m) => caps.canManage && latest && m.period === latest.period && !m.locked;
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(view.rows.length, page, pageSize);
  const lines = catchUpExplanation({ start: lookups.settings?.registerStartDate, due: view.due, lastEnded: view.lastEnded });

  return (
    <div className="page page--assets">
      <PageHeader
        title="Depreciation"
        subtitle="Book depreciation, straight-line, posted month by month to the journal."
        actions={<Button onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check the books'}</Button>}
      />
      <Notice tone={view.due.length ? 'amber' : 'slate'} title={view.due.length ? `${view.due.length} month${view.due.length === 1 ? '' : 's'} to post` : 'How months are posted'}
        action={view.due.length ? <Button size="sm" variant={caps.canManage ? 'primary' : 'default'} onClick={() => setPreview(view.due[0])}>{caps.canManage ? `Preview ${fmtPeriod(view.due[0])}` : 'Preview'}</Button> : null}>
        {lines.map((l, i) => <p key={i} className="assets-notice__p">{l}</p>)}
        {lookups.settings?.autoPostDepreciation ? <p className="assets-notice__p muted">Automatic posting is on: the server Mac posts every ended month by itself (a minute after it starts, then twice a day).</p> : null}
      </Notice>

      {integrity ? <IntegrityResult result={integrity} onClose={() => setIntegrity(null)} /> : null}
      {error ? <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} /> : null}
      {!runs && !error ? <p className="muted">Loading…</p> : null}
      {runs && !view.rows.length ? <EmptyState title="Nothing to depreciate yet" body="Months appear here from the register start once assets are activated." /> : null}

      {view.rows.length ? (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Month</th><th>Status</th><th className="is-num">Total</th><th className="is-num">Catch-up</th><th className="is-num">Assets</th><th>Posted</th><th className="is-actions" aria-label="Actions" /></tr></thead>
              <tbody>
                {view.rows.slice(pageStart, pageEnd).map((m) => {
                  const st = runStatusOf(m.status);
                  const run = m.run;
                  const reversals = (m.history || []).filter((h) => h.status === 'reversed').length;
                  return (
                    <tr key={m.period} className={cx(m.isNext && 'is-selected')}>
                      <td><strong>{fmtPeriod(m.period)}</strong>{m.isNext ? <div className="muted">next to post</div> : null}</td>
                      <td>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {m.locked && m.status !== 'locked' ? <span className="muted"> · closed</span> : null}
                        {m.status === 'locked' ? <div className="muted">Caught up in the first open month</div> : null}
                      </td>
                      <td className="is-num">{run ? fmtUsd(run.totalMinor) : '—'}</td>
                      <td className="is-num">{run?.catchUpMinor ? fmtUsd(run.catchUpMinor) : run ? '—' : ''}</td>
                      <td className="is-num">{run ? run.assetCount : ''}</td>
                      <td>{run ? <>{run.kind === 'auto' ? 'Automatic' : 'By hand'} · {formatDateTime(run.runAt, TZ)}</> : null}{reversals ? <div className="muted">{reversals} earlier run{reversals === 1 ? '' : 's'} reversed</div> : null}</td>
                      <td className="is-actions">
                        <Button size="sm" variant="ghost" onClick={() => setPreview(m.period)}>Preview</Button>
                        {caps.canManage && m.isNext && m.status === 'due' ? <Button size="sm" variant="primary" onClick={() => setPreview(m.period)}>Post…</Button> : null}
                        {canReverse(m) ? <Button size="sm" variant="ghost" onClick={() => setReversing(m.period)}>Reverse…</Button> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination total={view.rows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      ) : null}

      {preview ? (
        <PreviewModal
          period={preview}
          lookups={lookups}
          canManage={caps.canManage}
          companyId={activeCompanyId}
          onClose={() => setPreview(null)}
          onPosted={(res) => { setPreview(null); addToast(`${fmtPeriod(res.run?.period || preview)} posted — ${fmtUsd(res.totalMinor)}${res.catchUpMinor ? ` (${fmtUsd(res.catchUpMinor)} catch-up)` : ''}`, 'success'); setRetry((n) => n + 1); }}
        />
      ) : null}
      <ReasonModal
        open={!!reversing}
        title={`Reverse the ${fmtPeriod(reversing)} run?`}
        message="A mirror entry is posted on the same date and the month is due again. Re-post it once the cause is fixed. Only the latest run can be reversed, while its month is open."
        confirmLabel="Reverse run"
        danger
        onCancel={() => setReversing(null)}
        onConfirm={async (reason) => { await window.api.assets.reverseRun(reversing, reason); addToast(`${fmtPeriod(reversing)} reversed`, 'success'); setReversing(null); setRetry((n) => n + 1); }}
      />
    </div>
  );
}

const GROUPS = [{ key: 'category', label: 'By category' }, { key: 'branch', label: 'By branch' }, { key: 'asset', label: 'By asset' }];

function PreviewModal({ period, lookups, canManage, companyId, onClose, onPosted }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [group, setGroup] = useState('category');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  useEffect(() => {
    let alive = true;
    window.api.assets.previewDepreciation(period).then((d) => { if (alive) setData(d); }).catch((err) => { if (alive) setError(errText(err)); });
    return () => { alive = false; };
  }, [period]);
  async function post() {
    setBusy(true); setError('');
    try { onPosted(await window.api.assets.runDepreciation(period)); }
    catch (err) { setError(errText(err)); setBusy(false); }
  }
  const rows = data ? (group === 'asset' ? (data.rows || []).filter((r) => r.dueMinor) : groupRows(data, group, lookups)) : [];
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(rows.length, page, pageSize);
  const postable = canManage && data?.canPost;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Depreciation for ${fmtPeriod(period)}`}
      size="xl"
      busy={busy}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>{postable ? 'Cancel' : 'Close'}</Button>
          {postable ? <Button variant="primary" onClick={post} disabled={busy}>{busy ? 'Posting…' : `Post ${fmtUsd(data.totalMinor)}`}</Button> : null}
        </>
      )}
    >
      {error ? <Notice tone="rose">{error}</Notice> : null}
      {!data && !error ? <p className="muted">Working it out…</p> : null}
      {data ? (
        <>
          {!data.canPost && data.reason ? <Notice tone="slate">{data.reason}</Notice> : null}
          {data.canPost && !canManage ? <Notice>Posting needs the “Manage fixed assets” permission.</Notice> : null}
          <div className="stat-grid assets-stats">
            <div className="stat-card"><div className="stat-card__label">This month</div><div className="stat-card__value"><Money minor={data.monthMinor} rate={lookups.houseRate} /></div></div>
            <div className="stat-card"><div className="stat-card__label">Catch-up</div><div className="stat-card__value"><Money minor={data.catchUpMinor} rate={lookups.houseRate} /></div><div className="stat-card__hint">{data.catchUpMinor ? 'Earlier months not posted yet (late entries, closed months)' : 'Nothing to catch up'}</div></div>
            <div className="stat-card"><div className="stat-card__label">Total</div><div className="stat-card__value"><Money minor={data.totalMinor} rate={lookups.houseRate} /></div></div>
            <div className="stat-card"><div className="stat-card__label">Assets</div><div className="stat-card__value">{(data.rows || []).filter((r) => r.dueMinor).length}</div></div>
          </div>
          <div className="toolbar">
            <Segments label="Group" value={group} onChange={(v) => { setGroup(v); setPage(0); }} options={GROUPS.map((g) => ({ value: g.key, label: g.label }))} />
          </div>
          {rows.length === 0 ? <p className="muted">Nothing is due for this month.</p> : (
            <>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      {group === 'asset' ? <><th>Tag</th><th>Name</th><th>Category</th></> : <th>{group === 'branch' ? 'Branch' : 'Category'}</th>}
                      <th className="is-num">This month</th><th className="is-num">Catch-up</th><th className="is-num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(pageStart, pageEnd).map((r) => (
                      <tr key={r.key || r.assetId} className={group === 'asset' ? 'is-clickable' : undefined} {...(group === 'asset' ? openRowProps(() => { onClose(); openAssetPage(r.assetId, companyId); }, `Open ${r.tagCode}`) : {})}>
                        {group === 'asset' ? <><td><strong>{r.tagCode}</strong></td><td>{r.name}</td><td>{r.categoryName}</td></> : <td>{r.label}</td>}
                        <td className="is-num">{fmtUsd(r.monthMinor)}</td>
                        <td className="is-num">{r.catchUpMinor ? fmtUsd(r.catchUpMinor) : '—'}</td>
                        <td className="is-num">{fmtUsd(r.dueMinor ?? r.totalMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={group === 'asset' ? 3 : 1}>Total</td><td className="is-num">{fmtUsd(data.monthMinor)}</td><td className="is-num">{fmtUsd(data.catchUpMinor)}</td><td className="is-num">{fmtUsd(data.totalMinor)}</td></tr></tfoot>
                </table>
              </div>
              <Pagination total={rows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
            </>
          )}
        </>
      ) : null}
    </Modal>
  );
}

/** Sum the preview's per-asset rows by category or branch. */
function groupRows(data, group, lookups) {
  const map = new Map();
  for (const r of data.rows || []) {
    if (!r.dueMinor) continue;
    const key = (group === 'branch' ? r.branchId : r.categoryId) || 'none';
    const b = group === 'branch' ? lookups.maps.branches.get(r.branchId) : null;
    const label = group === 'branch' ? (b ? `${b.code} · ${b.nameEn}` : 'No branch') : (r.categoryName || '—');
    const m = map.get(key) || { key, label, monthMinor: 0, catchUpMinor: 0, totalMinor: 0 };
    m.monthMinor += r.monthMinor || 0;
    m.catchUpMinor += r.catchUpMinor || 0;
    m.totalMinor += r.dueMinor || 0;
    map.set(key, m);
  }
  return [...map.values()].sort((a, b) => b.totalMinor - a.totalMinor);
}

function IntegrityResult({ result, onClose }) {
  const t = result.totals || {};
  if (result.ok) {
    return (
      <Notice tone="slate" title="The books check out." action={<Button size="sm" variant="ghost" onClick={onClose}>Hide</Button>}>
        All {result.checked} entries balance in dollars and riel; every asset's figures match its journal lines; the register's book value ({fmtUsd(t.registerNbvMinor)}) equals the fixed-asset accounts ({fmtUsd(t.glNetMinor)}).
      </Notice>
    );
  }
  return (
    <Notice tone="rose" title="The books do not check out." action={<Button size="sm" variant="ghost" onClick={onClose}>Hide</Button>}>
      <ul className="assets-list">
        {result.unbalanced?.length ? <li>{result.unbalanced.length} entr{result.unbalanced.length === 1 ? 'y does' : 'ies do'} not balance.</li> : null}
        {result.assets?.length ? <li>{result.assets.length} asset{result.assets.length === 1 ? '' : 's'} differ from their journal lines: {result.assets.slice(0, 5).map((a) => a.tagCode || a.assetId).join(', ')}{result.assets.length > 5 ? '…' : ''}</li> : null}
        {result.accounts?.length ? <li>{result.accounts.length} account{result.accounts.length === 1 ? '' : 's'} differ from their asset lines.</li> : null}
        {!t.matches ? <li>Register book value {fmtUsd(t.registerNbvMinor)} vs the accounts {fmtUsd(t.glNetMinor)}.</li> : null}
      </ul>
      Nothing has been changed. Keep a backup and tell whoever looks after the app.
    </Notice>
  );
}
