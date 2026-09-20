import { useEffect, useState } from 'react';
import { Button, EmptyState } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useAppStore } from '../../store/index.js';

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
  const [runs, setRuns] = useState([]);
  const [thisMac, setThisMac] = useState(null);

  const load = () => companyId
    && window.api.labels.listRuns(companyId, 200).then(setRuns).catch((e) => addToast(e.message, 'error'));

  useEffect(() => { void load(); }, [companyId]);

  // Which Mac is this? Needed to tell "my file" from "the other Mac's file".
  useEffect(() => {
    let cancelled = false;
    window.api.app.getVersionInfo()
      .then((info) => { if (!cancelled) setThisMac(info?.hostname || null); })
      .catch(() => { /* stays null: then we never claim a file is elsewhere */ });
    return () => { cancelled = true; };
  }, []);

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
        <div className="run-list">
          {runs.map((run) => {
            const otherMac = otherMacFor(run);
            return (
              <article key={run.id}>
                <div className={`run-icon run-icon--${run.format}`}>
                  {run.format === 'print' ? 'P' : run.format.toUpperCase().slice(0, 3)}
                </div>
                <div>
                  <strong>{run.templateName || 'Deleted template'}</strong>
                  <span>
                    {run.productCount} product{run.productCount === 1 ? '' : 's'} · {run.layoutMode} · {new Date(run.createdAt).toLocaleString()}
                    {otherMac ? <> · <em>made on {otherMac}</em></> : null}
                  </span>
                  <small>{run.outputPath || 'Sent directly to printer'}</small>
                </div>
                <div className="run-list__actions">
                  {run.outputPath && !otherMac ? (
                    <Button
                      variant="ghost"
                      onClick={() => window.api.labels.openOutput(run.outputPath).catch((e) => addToast(e.message, 'error'))}
                    >
                      Open
                    </Button>
                  ) : null}
                  {otherMac ? (
                    <Button
                      variant="ghost"
                      disabled
                      title={`These files are on ${otherMac}, not this Mac. Open them there, or run Generate & Print again from here.`}
                    >
                      On {otherMac}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={async () => { try { await window.api.labels.deleteRun(run.id); load(); } catch (e) { addToast(e.message, 'error'); } }}>Remove</Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No label jobs yet" body="Generated files and print jobs will appear here." />
      )}
    </section>
  );
}
