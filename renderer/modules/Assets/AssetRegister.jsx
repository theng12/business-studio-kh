/**
 * Fixed Assets — the Register (docs/ASSETS_AND_BRANCHES_PLAN.md §8.1): filters
 * (branch, category, status, custodian, "needs attention", search), a paginated
 * table with a totals row for EVERY matching asset (posted book figures, so
 * they equal the reports), + New asset, Import (§11) and the Excel workbook.
 * Clicking a row opens the asset's page (AssetPage.jsx) in place; Back keeps
 * the filters and the page.
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Pagination, Select, cx, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { useAssetCaps, useAssetIntent, useAssetLookups, useAssetsTick } from './assetsHooks.js';
import { BranchSelect, CategorySelect, LoadError, MainPhoto, Money, NeedsCapNote, Notice, StaffPicker, StateBadges, StatusBadge, FileViewer } from './AssetsShared.jsx';
import { AssetPage } from './AssetPage.jsx';
import { NewAssetModal } from './NewAssetModal.jsx';
import { AssetImportModal } from './AssetImportModal.jsx';
import {
  ATTENTION, EMPTY_FILTERS, STATUSES, errText, filtersActive, fmtMoneyIn, listArgs, rowCost, rowNbv, totalsCaption, todayKey,
} from './assetsModel.js';

const EMPTY_DATA = { items: [], total: 0, counts: {}, totals: null };

export function AssetRegister() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useAssetCaps();
  const lookups = useAssetLookups();
  const tick = useAssetsTick(['asset', 'run', 'branch', 'category', 'period']);
  const intent = useAssetIntent();
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [qText, setQText] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [viewPhoto, setViewPhoto] = useState(null);
  const [saving, setSaving] = useState(false);
  const req = useRef(0);

  // A company switch: nothing of the last company may show, or be opened.
  useEffect(() => { setData(EMPTY_DATA); setOpenId(null); setFilters(EMPTY_FILTERS); setQText(''); setCreating(false); setImporting(false); }, [activeCompanyId]);
  useEffect(() => { if (intent?.assetId) setOpenId(intent.assetId); }, [intent]);
  useEffect(() => { setPage(0); }, [filters, pageSize, activeCompanyId]);
  // Search is typed: wait a moment before asking.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === qText ? f : { ...f, q: qText })), 200);
    return () => clearTimeout(t);
  }, [qText]);

  useEffect(() => {
    if (!activeCompanyId || !caps.canView) return undefined;
    const r = ++req.current;
    setLoading(true);
    window.api.assets.list(listArgs(filters, page, pageSize))
      .then((res) => {
        if (r !== req.current) return;
        setData({ items: res?.items || [], total: res?.total || 0, counts: res?.counts || {}, totals: res?.totals || null });
        setError(null);
        // The list shrank below this page (filters, another Mac): clamp (§10).
        const maxPage = Math.max(0, Math.ceil((res?.total || 0) / pageSize) - 1);
        if (page > maxPage) setPage(maxPage);
      })
      .catch((err) => { if (r === req.current) { setData(EMPTY_DATA); setError(errText(err)); } })
      .finally(() => { if (r === req.current) setLoading(false); });
    return undefined;
  }, [activeCompanyId, caps.canView, filters, page, pageSize, tick, retry]);

  if (!activeCompanyId) {
    return <div className="page"><PageHeader title="Register" /><NoCompanyState purpose="see the assets it owns" /></div>;
  }
  if (!caps.canView) {
    return <div className="page"><PageHeader title="Register" /><NeedsCapNote /></div>;
  }
  if (openId) {
    return (
      <AssetPage
        key={openId}
        id={openId}
        lookups={lookups}
        onBack={() => setOpenId(null)}
        onOpenAsset={setOpenId}
      />
    );
  }

  const set = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(data.total, page, pageSize);
  const t = data.totals;
  const rate = lookups.houseRate;
  const anyFilter = filtersActive({ ...filters, q: qText });

  async function saveWorkbook() {
    setSaving(true);
    try {
      const path = await window.api.assets.saveWorkbook({ asOf: todayKey() });
      if (path) addToast(`Exported to ${path}`, 'success');
    } catch (err) { addToast(`Couldn't export: ${errText(err)}`, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <div className="page page--assets">
      <PageHeader
        title="Register"
        subtitle="Everything the business owns: where it is, who has it and what it is worth on the books."
        actions={(
          <>
            <Button onClick={saveWorkbook} disabled={saving}>{saving ? 'Exporting…' : 'Excel workbook…'}</Button>
            {caps.canManage ? <Button onClick={() => setImporting(true)}>Import…</Button> : null}
            {caps.canManage ? <Button variant="primary" onClick={() => setCreating(true)}>+ New asset</Button> : null}
          </>
        )}
      />

      {data.counts.fromFuelNeedsCost > 0 && filters.attention !== 'needs_cost' ? (
        <Notice
          tone="amber"
          title={`${data.counts.fromFuelNeedsCost} vehicle${data.counts.fromFuelNeedsCost === 1 ? '' : 's'} and machines came from Fuel.`}
          action={<Button size="sm" onClick={() => setFilters({ ...EMPTY_FILTERS, attention: 'needs_cost' })}>Show them</Button>}
        >
          Add their cost and purchase date (or an opening value) to start depreciating them.
        </Notice>
      ) : data.counts.needsCost > 0 && filters.attention !== 'needs_cost' ? (
        <Notice
          tone="amber"
          title={`${data.counts.needsCost} draft${data.counts.needsCost === 1 ? '' : 's'} still need${data.counts.needsCost === 1 ? 's' : ''} a cost.`}
          action={<Button size="sm" onClick={() => setFilters({ ...EMPTY_FILTERS, attention: 'needs_cost' })}>Show them</Button>}
        >
          A draft is not on the books and is never depreciated until it has a cost and is activated.
        </Notice>
      ) : null}

      <div className="toolbar assets-toolbar">
        <div className="search-wrap">
          <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input type="search" className="search-input" placeholder="Tag, name, serial or plate…" aria-label="Search assets" value={qText} onChange={(e) => setQText(e.target.value)} />
        </div>
        <BranchSelect aria-label="Branch" branches={lookups.branches} includeClosed value={filters.branchId} onChange={set('branchId')} allLabel="All branches" />
        <CategorySelect aria-label="Category" categories={lookups.categories} includeArchived value={filters.categoryId} onChange={set('categoryId')} allLabel="All categories" />
        <Select aria-label="Status" value={filters.status} onChange={(e) => set('status')(e.target.value)}>
          <option value="">Any status</option>
          {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
        <StaffPicker aria-label="Custodian" staff={lookups.staff} value={filters.custodianEmployeeId} onChange={set('custodianEmployeeId')} allLabel="Any custodian" />
        <Select aria-label="Needs attention" value={filters.attention} onChange={(e) => set('attention')(e.target.value)}>
          <option value="">Needs attention…</option>
          {ATTENTION.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
        <Select aria-label="Drafts and cancelled" value={filters.recordState} onChange={(e) => set('recordState')(e.target.value)}>
          <option value="">Active and drafts</option>
          <option value="active">Active only</option>
          <option value="draft">Drafts only</option>
          <option value="cancelled">Cancelled drafts</option>
          <option value="all">Everything</option>
        </Select>
        {anyFilter ? <Button variant="ghost" size="sm" onClick={() => { setQText(''); setFilters(EMPTY_FILTERS); }}>Clear</Button> : null}
        <div className="toolbar__spacer" />
        <span className="toolbar__count">{loading ? 'Loading…' : `${data.total} shown`}</span>
      </div>

      {error ? <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} /> : null}

      {!error && !loading && data.total === 0 ? (
        anyFilter ? (
          <EmptyState title="Nothing matches" body="Try a shorter search, or clear the filters." action={<Button onClick={() => { setQText(''); setFilters(EMPTY_FILTERS); }}>Clear filters</Button>} />
        ) : (
          <EmptyState
            title="No assets yet"
            body="Add the first one — a vehicle, a kiln, the shop shelving — or import a list from Excel."
            action={caps.canManage ? <Button variant="primary" onClick={() => setCreating(true)}>+ New asset</Button> : null}
            secondaryAction={caps.canManage ? <Button onClick={() => setImporting(true)}>Import from Excel</Button> : null}
          />
        )
      ) : null}

      {data.total > 0 ? (
        <>
          <div className="data-table-wrap">
            <table className="data-table data-table--sticky assets-register">
              <thead>
                <tr>
                  <th aria-label="Photo" />
                  <th>Tag</th><th>Name</th><th>Category</th><th>Branch</th><th>Custodian</th>
                  <th className="is-num">Cost</th><th className="is-num">Book value</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => {
                  const c = rowCost(a);
                  const nbv = rowNbv(a);
                  const gone = a.status === 'disposed' || a.status === 'lost' || a.recordState === 'cancelled';
                  return (
                    <tr key={a.id} className={cx('is-clickable', gone && 'is-muted')} onClick={() => setOpenId(a.id)}>
                      <td onClick={(e) => e.stopPropagation()}><MainPhoto asset={a} onOpen={() => setViewPhoto(a)} /></td>
                      <td className="assets-nowrap"><strong>{a.tagCode || '—'}</strong></td>
                      <td>
                        <div>{a.name}</div>
                        {a.nameKm ? <div className="muted assets-km">{a.nameKm}</div> : null}
                        {a.plateNo || a.serialNo ? <div className="muted">{a.plateNo || a.serialNo}</div> : null}
                        {a.quantity > 1 ? <div className="muted">Group of {a.quantity}</div> : null}
                      </td>
                      <td>{a.categoryName || '—'}</td>
                      <td>{a.branchCode ? <span title={a.branchName}>{a.branchCode}</span> : <span className="muted">—</span>}</td>
                      <td>{a.custodianName || <span className="muted">—</span>}</td>
                      <td className="is-num">
                        {c.minor == null ? <span className="muted">{c.note || '—'}</span>
                          : c.muted ? <span className="assets-money is-muted">{fmtMoneyIn(c.minor, c.currency)}<span className="assets-money__riel">{c.note}</span></span>
                            : <Money minor={c.minor} rate={rate} />}
                      </td>
                      <td className="is-num">{nbv == null ? <span className="muted">—</span> : <Money minor={nbv} rate={rate} />}</td>
                      <td>
                        <span className="assets-badges">
                          {a.recordState === 'active' ? <StatusBadge status={a.status} /> : null}
                          <StateBadges asset={a} />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {t ? (
                <tfoot>
                  <tr className="assets-totals">
                    <td />
                    <td colSpan={5}>
                      <strong>Totals</strong> <span className="muted">· {totalsCaption(t)}</span>
                      <div className="muted assets-totals__note">Posted book figures for every matching asset, not only this page. Drafts and tracked-only items are not in them.</div>
                    </td>
                    <td className="is-num"><Money minor={t.costMinor} rate={rate} strong /></td>
                    <td className="is-num"><Money minor={t.nbvMinor} rate={rate} strong /></td>
                    <td className="assets-nowrap">
                      {t.accumMinor ? <span className="muted">Depreciation <Money minor={t.accumMinor} /></span> : null}
                      {t.impairmentMinor ? <div className="muted">Impairment <Money minor={t.impairmentMinor} /></div> : null}
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
          <Pagination total={data.total} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
          {rate ? <p className="muted assets-foot">Riel is shown at today's house rate ({rate.toLocaleString('en-US')} ៛ per $1), for display only.</p> : null}
        </>
      ) : null}

      <NewAssetModal
        open={creating}
        lookups={lookups}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          if (created.length === 1) setOpenId(created[0].id);
          else setFilters({ ...EMPTY_FILTERS, recordState: 'draft' });
        }}
      />
      <AssetImportModal open={importing} onClose={() => setImporting(false)} onDone={() => setRetry((n) => n + 1)} />
      <FileViewer
        open={!!viewPhoto}
        files={viewPhoto ? [{ id: viewPhoto.mainPhotoId, kind: 'photo', uploadedAt: viewPhoto.updatedAt }] : []}
        title={viewPhoto ? `${viewPhoto.tagCode} · ${viewPhoto.name}` : 'Photo'}
        onClose={() => setViewPhoto(null)}
      />
      {data.counts.cancelled && filters.recordState !== 'cancelled' && filters.recordState !== 'all' ? (
        <p className="muted assets-foot">{data.counts.cancelled} cancelled draft{data.counts.cancelled === 1 ? '' : 's'} hidden. <Badge tone="slate">Tags are never reused</Badge></p>
      ) : null}
    </div>
  );
}
