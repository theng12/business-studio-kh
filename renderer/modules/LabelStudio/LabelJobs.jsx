import { useEffect, useState } from 'react';
import { Button, EmptyState } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { useAppStore } from '../../store/index.js';

export function LabelJobs() {
  const companyId = useAppStore((s) => s.activeCompanyId); const addToast = useAppStore((s) => s.addToast); const [runs, setRuns] = useState([]);
  const load = () => companyId && window.api.labels.listRuns(companyId, 200).then(setRuns).catch((e) => addToast(e.message, 'error'));
  useEffect(() => { void load(); }, [companyId]);
  return <section className="page"><PageHeader title="Label History" subtitle="Open generated files and repeat production with confidence." />{runs.length ? <div className="run-list">{runs.map((run) => <article key={run.id}><div className={`run-icon run-icon--${run.format}`}>{run.format === 'print' ? 'P' : run.format.toUpperCase().slice(0, 3)}</div><div><strong>{run.templateName || 'Deleted template'}</strong><span>{run.productCount} product{run.productCount === 1 ? '' : 's'} · {run.layoutMode} · {new Date(run.createdAt).toLocaleString()}</span><small>{run.outputPath || 'Sent directly to printer'}</small></div><div className="run-list__actions">{run.outputPath ? <Button variant="ghost" onClick={() => window.api.labels.openOutput(run.outputPath).catch((e) => addToast(e.message, 'error'))}>Open</Button> : null}<Button variant="ghost" onClick={async () => { await window.api.labels.deleteRun(run.id); load(); }}>Remove</Button></div></article>)}</div> : <EmptyState title="No label jobs yet" body="Generated files and print jobs will appear here." />}</section>;
}
