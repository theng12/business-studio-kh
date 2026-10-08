import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, EmptyState, Pagination, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useAppStore } from '../../store/index.js';
import { requestLabelRerun } from './labelRerun.js';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { formatDateTime, timeAgo } from '../../lib/format.js';
import { confirm } from '../../components/ConfirmModal.jsx';

/**
 * Label History.
 *
 * v0.1.22: the history lives with the DATA (on the server Mac, in client mode),
 * but the files a run produced land on whichever Mac ran the job. So an entry
 * made on the other Mac names a path that does not exist here, and Open used to
 * fail with a cryptic "file not found". Each run now records which Mac wrote its
 * files, and an entry from elsewhere says so instead of offering a button that
 * cannot work.
 */
export function LabelJobs() {
  const companyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const [runs, setRuns] = useState([]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [thisMac, setThisMac] = useState(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!companyId) { setRuns([]); return; }
    try {
      const rows = await window.api.labels.listRuns(companyId, 200);
      if (seq === requestSeq.current) setRuns(rows);
    } catch (e) { if (seq === requestSeq.current) addToast(e.message, 'error'); }
  }, [companyId, addToast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const offs = [];
    const refresh = (event) => { if (!event || event.kind === 'labels') void load(); };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => { void load(); }));
    return () => offs.forEach((off) => off?.());
  }, [load]);

  // Which Mac is this? Needed to tell "my file" from "the other Mac's file".
  useEffect(() => {
    let cancelled = false;
    window.api.app.getVersionInfo()
      .then((info) => { if (!cancelled) setThisMac(info?.hostname || null); })
      .catch(() => { /* stays null: then we never claim a file is elsewhere */ });
    return () => { cancelled = true; };
  }, []);

  // §10: up to 200 runs come back, so the list pages. A shrinking list (a
  // removed run, a company switch) clamps rather than showing an empty page.
  const pageInfo = useMemo(() => paginate(runs.length, page, pageSize), [runs.length, page, pageSize]);
  useEffect(() => { if (page !== pageInfo.currentPage) setPage(pageInfo.currentPage); }, [page, pageInfo.currentPage]);
  useEffect(() => { setPage(0); }, [companyId, pageSize]);
  const visibleRuns = runs.slice(pageInfo.pageStart, pageInfo.pageEnd);

  /** Open Generate & Print with this run's template, products and layout. */
  function runAgain(run) {
    const request = requestLabelRerun(run);
    if (!request) return;
    if (!request.productIds.length) addToast('This run did not record its products — pick them again on Generate & Print.', 'info');
    setActiveModule('labelgenerate');
  }

  /** Remove a run from the history — asked first, because it cannot be undone.
   *  The files the run wrote stay where they are. */
  async function removeRun(run) {
    const ok = await confirm({
      title: 'Remove this run from Label History?',
      message: `${run.templateName || 'This run'} · ${run.productCount} product${run.productCount === 1 ? '' : 's'} · ${formatDateTime(run.createdAt)}`,
      detail: 'Files it already made are not deleted. "Run again" will no longer be available for it.',
      danger: true,
      confirmLabel: 'Remove run',
    });
    if (!ok) return;
    try { await window.api.labels.deleteRun(run.id); void load(); } catch (e) { addToast(e.message, 'error'); }
  }

  /** The Mac that produced this run's files, or null when unknown / this one. */
  function otherMacFor(run) {
    const origin = run?.settings?.originHost;
    if (!origin || !thisMac || origin === thisMac) return null;
    return origin;
  }

  return (
    <section className="page">
      <PageHeader title="Label History" subtitle="Open generated files and repeat production with confidence." />
      {runs.length ? (
        <>
        <div className="data-table-wrap">
          <table className="data-table label-runs">
            <thead>
              <tr>
                <th>Format</th>
                <th>Template</th>
                <th className="is-num">Products</th>
                <th>Layout</th>
                <th>Made</th>
                <th>Output</th>
                <th className="is-actions" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visibleRuns.map((run) => {
                const otherMac = otherMacFor(run);
                return (
                  <tr key={run.id}>
                    <td><Badge tone="slate">{run.format === 'print' ? 'Print' : String(run.format || '').toUpperCase()}</Badge></td>
                    <td><strong>{run.templateName || 'Deleted template'}</strong></td>
                    <td className="is-num">{run.productCount}</td>
                    <td>{run.layoutMode === 'sheet' ? 'Sheet' : run.layoutMode === 'single' ? 'One per page' : run.layoutMode}</td>
                    <td title={timeAgo(run.createdAt)}>
                      {formatDateTime(run.createdAt)}
                      {otherMac ? <div className="muted label-runs__origin">made on {otherMac}</div> : null}
                    </td>
                    <td className="label-runs__path">{run.outputPath || <span className="muted">Sent directly to printer</span>}</td>
                    <td className="is-actions">
                      {run.outputPath && !otherMac ? (
                        <Button
                          size="sm"
                          onClick={() => window.api.labels.openOutput(run.outputPath).catch((e) => addToast(e.message, 'error'))}
                        >
                          Open
                        </Button>
                      ) : null}
                      {otherMac ? (
                        <Button
                          size="sm"
                          disabled
                          title={`These files are on ${otherMac}, not this Mac. Open them there, or run Generate & Print again from here.`}
                        >
                          On {otherMac}
                        </Button>
                      ) : null}
                      {run.templateId ? (
                        <Button size="sm" onClick={() => runAgain(run)} title="Open Generate & Print with this run's template, products and layout">Run again</Button>
                      ) : null}
                      <Button variant="danger" size="sm" onClick={() => { void removeRun(run); }}>Remove</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination total={runs.length} pageStart={pageInfo.pageStart} pageEnd={pageInfo.pageEnd} currentPage={pageInfo.currentPage} maxPage={pageInfo.maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      ) : !companyId ? (
        <NoCompanyState purpose="see its label runs" />
      ) : (
        <EmptyState
          title="No label runs yet"
          body="Files you generate and print jobs you send will be listed here."
          action={<Button variant="primary" onClick={() => setActiveModule('labelgenerate')}>Go to Generate & Print</Button>}
        />
      )}
    </section>
  );
}
