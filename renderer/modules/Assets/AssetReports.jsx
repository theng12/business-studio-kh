/**
 * Fixed Assets — Reports (docs/ASSETS_AND_BRANCHES_PLAN.md §8.1): the eight
 * reports, each with its date / period / year picker and the branch and
 * category filters it takes, read from the POSTED ledger (so they agree with
 * the register's totals and the GL). "Excel workbook…" saves the 7-sheet
 * workbook for the chosen year / date. A row with an asset opens its page.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { EmptyState, Field, Input, Pagination, Select, Button, cx, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { openAssetPage, useAssetCaps, useAssetLookups, useAssetsTick } from './assetsHooks.js';
import { BranchSelect, CategorySelect, LoadError, NeedsCapNote, Notice, openRowProps } from './AssetsShared.jsx';
import { REPORTS, cellText, cellValue, defaultReportArgs, errText, reportArgs, reportDef, reportTable, taxYears, todayKey } from './assetsModel.js';

const NUMERIC = new Set(['usd', 'khr', 'int']);

export function AssetReports() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useAssetCaps();
  const lookups = useAssetLookups();
  const tick = useAssetsTick(['asset', 'run', 'tax', 'branch', 'category', 'period']);
  const [kind, setKind] = useState('register');
  const [values, setValues] = useState(() => defaultReportArgs());
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const def = reportDef(kind);
  const years = useMemo(() => taxYears(lookups.settings?.registerStartDate), [lookups.settings?.registerStartDate]);
  const argsKey = JSON.stringify(reportArgs(kind, values));

  useEffect(() => { setReport(null); setValues(defaultReportArgs()); }, [activeCompanyId]);
  useEffect(() => { setPage(0); }, [argsKey, pageSize]);
  useEffect(() => {
    if (!activeCompanyId || !caps.canView) return undefined;
    let alive = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      window.api.assets.getReport(JSON.parse(argsKey))
        .then((r) => { if (alive) setReport(r); })
        .catch((err) => { if (alive) { setReport(null); setError(errText(err)); } })
        .finally(() => { if (alive) setLoading(false); });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [activeCompanyId, caps.canView, argsKey, tick]);

  if (!activeCompanyId) return <div className="page"><PageHeader title="Reports" /><NoCompanyState purpose="see its asset reports" /></div>;
  if (!caps.canView) return <div className="page"><PageHeader title="Reports" /><NeedsCapNote what="the reports" /></div>;

  const set = (k) => (v) => setValues((s) => ({ ...s, [k]: v }));
  const table = report && report.kind === kind ? reportTable(report) : null;
  const rows = table?.rows || [];
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(rows.length, page, pageSize);

  async function saveWorkbook() {
    setSaving(true);
    try {
      const args = def.params === 'year' ? { year: Number(values.year) } : { year: Number((values.asOf || values.to || todayKey()).slice(0, 4)), asOf: def.params === 'asOf' ? values.asOf : values.to || undefined };
      const path = await window.api.assets.saveWorkbook(args);
      if (path) addToast(`Exported to ${path}`, 'success');
    } catch (err) { addToast(`Couldn't export: ${errText(err)}`, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <div className="page page--assets">
      <PageHeader
        title="Reports"
        subtitle="From what is posted to the books — the same figures as the register's totals."
        actions={<Button onClick={saveWorkbook} disabled={saving}>{saving ? 'Exporting…' : 'Excel workbook…'}</Button>}
      />
      <div className="assets-report-pick" role="tablist" aria-label="Report">
        {REPORTS.map((r) => (
          <button key={r.kind} type="button" role="tab" aria-selected={kind === r.kind} className={cx('assets-report-pick__item', kind === r.kind && 'is-active')} onClick={() => setKind(r.kind)}>
            {r.label}
          </button>
        ))}
      </div>
      <p className="muted assets-report-hint">{def.hint}</p>

      <div className="toolbar assets-toolbar">
        {def.params === 'asOf' ? <Field label="As at">{({ id }) => <Input id={id} type="date" value={values.asOf} onChange={(e) => set('asOf')(e.target.value)} />}</Field> : null}
        {def.params === 'range' ? (
          <>
            <Field label="From">{({ id }) => <Input id={id} type="date" value={values.from} onChange={(e) => set('from')(e.target.value)} />}</Field>
            <Field label="To">{({ id }) => <Input id={id} type="date" value={values.to} onChange={(e) => set('to')(e.target.value)} />}</Field>
          </>
        ) : null}
        {def.params === 'year' ? (
          <Field label="Year">{({ id }) => <Select id={id} value={String(values.year)} onChange={(e) => set('year')(Number(e.target.value))}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</Select>}</Field>
        ) : null}
        {def.branch ? <Field label="Branch">{({ id }) => <BranchSelect id={id} branches={lookups.branches} includeClosed value={values.branchId} onChange={set('branchId')} allLabel="All branches" />}</Field> : null}
        {def.category ? <Field label="Category">{({ id }) => <CategorySelect id={id} categories={lookups.categories} includeArchived value={values.categoryId} onChange={set('categoryId')} allLabel="All categories" />}</Field> : null}
        <div className="toolbar__spacer" />
        <span className="toolbar__count">{loading ? 'Loading…' : table ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : ''}</span>
      </div>

      {(kind === 'book_vs_tax' || kind === 'tax_pools') ? <Notice tone="amber" title="Estimate — confirm with an accountant.">Tax figures are worked out from published rates, and the first year's pools are the app's estimate.</Notice> : null}
      {error ? <LoadError message={error} /> : null}
      {table && !rows.length && !loading ? <EmptyState title="Nothing to show" body="Try another date or clear the filters." /> : null}
      {table && rows.length ? (
        <>
          <div className="data-table-wrap">
            <table className="data-table data-table--sticky assets-report">
              <thead><tr>{table.columns.map((c) => <th key={c.key} className={NUMERIC.has(c.type) ? 'is-num' : undefined}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.slice(pageStart, pageEnd).map((r, i) => (
                  <tr key={r.assetId ? `${r.assetId}-${r.eventId || r.reason || i}` : (r.key || `${r.period || ''}${r.categoryId || ''}${r.branchId || ''}${r.taxClass || ''}${i}`)}
                    className={r.assetId ? 'is-clickable' : undefined}
                    {...(r.assetId ? openRowProps(() => openAssetPage(r.assetId, activeCompanyId), `Open ${r.tagCode || 'asset'}`) : {})}>
                    {table.columns.map((c) => <td key={c.key} className={NUMERIC.has(c.type) ? 'is-num' : undefined}>{cellText(c, cellValue(c, r)) || (NUMERIC.has(c.type) ? '—' : '')}</td>)}
                  </tr>
                ))}
              </tbody>
              {table.totals ? (
                <tfoot><tr>{table.columns.map((c) => <td key={c.key} className={NUMERIC.has(c.type) ? 'is-num' : undefined}>{table.totals[c.key] == null ? '' : typeof table.totals[c.key] === 'string' ? table.totals[c.key] : cellText(c, table.totals[c.key])}</td>)}</tr></tfoot>
              ) : null}
            </table>
          </div>
          <Pagination total={rows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
          {kind === 'tax_pools' && report?.perAsset?.length ? <p className="muted">Class 1 and intangible assets are worked out one by one — see Tax year.</p> : null}
          {report?.notes?.length ? <ul className="assets-list muted">{report.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
          {kind === 'depreciation' ? <p className="muted">Each month's line carries the branch the asset was in on the month's last day.</p> : null}
        </>
      ) : null}
    </div>
  );
}
