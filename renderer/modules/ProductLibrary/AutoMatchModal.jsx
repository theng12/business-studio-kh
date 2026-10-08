import { useRef, useState } from 'react';
import { Button, Modal } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

/* 0.1.94: preview first, then import (owner's decision). The modal walks
 *   intro → scanning → preview → importing → results.
 * Scanning is a dry run of `images:autoMatchBySku` (nothing is written); the
 * preview lists which products would get photos, what did not match and what
 * is over the cap; Import then sends the planned files in small batches, which
 * gives a real progress bar and a Cancel that stops before the next batch.
 * New photos go AFTER a product's existing ones unless "Make the first matched
 * photo the main image" is ticked. */
const RULES = [
  ['Filename = SKU', '"abc-123.jpg" belongs to the product with SKU "abc-123". Case-insensitive.'],
  ['Numeric suffix → order', '"abc-123-1.jpg", "abc-123-2.jpg" are added in that order. -, _, or space work as separators.'],
  ['Per-SKU subfolder', 'A folder named "abc-123/" belongs to that SKU. "main.jpg" / "primary" / "cover" come first; "1.jpg", "2.jpg" set the order.'],
  ['You see the plan first', 'Nothing is imported until you have checked the preview and clicked Import.'],
  ['Added after existing photos', 'Matched photos join the END of each product\'s photos, so the current main image stays the main image — unless you tick "Make the first matched photo the main image".'],
  ['Duplicates are skipped', 'Every image is hashed by content. A photo already on the product is not added again.'],
  ['Up to 5 levels deep', 'Hidden folders (starting with ".") are skipped.'],
  ['Max 50 images per product', 'Photos beyond a product\'s 50 are skipped and listed in the preview.'],
];

/** Files sent per import call — small enough for a smooth bar and a prompt Cancel. */
const IMPORT_BATCH = 10;

export function AutoMatchModal({ open, onClose }) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const refreshAllProducts = useAppStore((s) => s.refreshAllProducts);
  const refreshDashboard = useAppStore((s) => s.refreshDashboard);
  const addToast = useAppStore((s) => s.addToast);

  const [step, setStep] = useState('intro'); // 'intro' | 'scanning' | 'preview' | 'importing' | 'results'
  const [folder, setFolder] = useState(null);
  const [plan, setPlan] = useState(null);
  const [makeMain, setMakeMain] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [stopping, setStopping] = useState(false);
  const [stats, setStats] = useState(null);
  const cancelRef = useRef(false);
  const busy = step === 'scanning' || step === 'importing';

  function reset() {
    setStep('intro');
    setFolder(null);
    setPlan(null);
    setMakeMain(false);
    setProgress({ done: 0, total: 0 });
    setStopping(false);
    setStats(null);
    cancelRef.current = false;
  }

  function handleClose() {
    if (busy) return;
    reset();
    onClose();
  }

  async function handleChooseFolder() {
    try {
      const picked = await window.api.files.pickFolder();
      if (!picked) return;
      setFolder(picked);
      setStep('scanning');
      const result = await window.api.images.autoMatchBySku(activeCompanyId, picked, { dryRun: true });
      setPlan(result);
      setStep('preview');
    } catch (err) {
      addToast(err.message, 'error');
      setStep('intro');
    }
  }

  async function handleImport() {
    if (!plan || !folder) return;
    const entries = [];
    for (const p of plan.products ?? []) {
      p.files.forEach((f, i) => entries.push({
        productId: p.productId,
        sku: p.sku,
        sourcePath: f.sourcePath,
        makeMain: makeMain && i === 0,
      }));
    }
    cancelRef.current = false;
    setStopping(false);
    setProgress({ done: 0, total: entries.length });
    setStep('importing');
    let imported = 0;
    let skippedDup = 0;
    const failures = [];
    const touched = new Set();
    let done = 0;
    let cancelled = false;
    try {
      for (let i = 0; i < entries.length; i += IMPORT_BATCH) {
        if (cancelRef.current) { cancelled = true; break; }
        const batch = entries.slice(i, i + IMPORT_BATCH);
        const res = await window.api.images.autoMatchBySku(activeCompanyId, folder, { files: batch });
        imported += res?.imported ?? 0;
        skippedDup += res?.skippedDup ?? 0;
        for (const f of res?.failures ?? []) failures.push(f);
        for (const id of res?.productsTouched ?? []) touched.add(id);
        done += batch.length;
        setProgress({ done, total: entries.length });
      }
    } catch (err) {
      failures.push({ filepath: '', sku: '', error: err.message });
    }
    setStats({
      imported,
      skippedDup,
      failures,
      imagesFailed: failures.length,
      productsTouched: touched.size,
      cancelled,
      notAttempted: entries.length - done,
      capSkipped: plan.capSkipped ?? 0,
    });
    setStep('results');
    await Promise.all([refreshProducts(), refreshAllProducts?.(), refreshDashboard()]).catch(() => {});
  }

  const plannedProducts = plan?.products ?? [];
  const overCapProducts = plannedProducts.filter((p) => p.capSkipped.length > 0);

  const footer =
    step === 'intro' ? (
      <>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="primary" onClick={handleChooseFolder}>Choose folder…</Button>
      </>
    ) : step === 'preview' ? (
      <>
        <Button onClick={reset}>Choose another folder</Button>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="primary" onClick={handleImport} disabled={!plan?.files}>
          {plan?.files ? `Import ${plan.files} photo${plan.files === 1 ? '' : 's'}` : 'Nothing to import'}
        </Button>
      </>
    ) : step === 'importing' ? (
      <Button onClick={() => { cancelRef.current = true; setStopping(true); }} disabled={stopping}>
        {stopping ? 'Stopping…' : 'Cancel'}
      </Button>
    ) : step === 'results' ? (
      <Button variant="primary" onClick={handleClose}>Done</Button>
    ) : null;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Auto-match images"
      footer={footer}
      busy={busy}
      closeOnBackdrop={!busy}
    >
      {step === 'intro' ? (
        <>
          <p className="ws-hint">Pick a folder. The photos are matched to your SKUs, and you see the plan before anything is imported.</p>
          <h3 className="automatch__heading">Matching rules</h3>
          <ol className="automatch__rules">
            {RULES.map(([title, body], i) => (
              <li key={i}>
                <strong>{title}.</strong> {body}
              </li>
            ))}
          </ol>
        </>
      ) : step === 'scanning' ? (
        <div className="automatch__running">
          <div className="ws-canvas__spinner" style={{ borderTopColor: 'var(--c-text)', borderColor: 'rgba(20,20,28,0.15)' }} />
          <div>Scanning <code>{folder}</code>…</div>
        </div>
      ) : step === 'preview' && plan ? (
        <>
          <p className="ws-hint">Nothing has been imported yet. Check the plan, then Import.</p>
          <div className="automatch__stats">
            <Stat label="Image files scanned" value={plan.scannedFiles} />
            <Stat label="Products that get photos" value={`${plannedProducts.length} / ${plan.totalProducts}`} tone="emerald" />
            <Stat label="Photos to import" value={plan.files} tone="emerald" />
            <Stat label="Unmatched files" value={plan.unmatchedFiles} />
            {plan.capSkipped > 0 ? <Stat label="Over the 50-image cap" value={plan.capSkipped} tone="amber" /> : null}
          </div>
          <label className="automatch__option">
            <input type="checkbox" checked={makeMain} onChange={(e) => setMakeMain(e.target.checked)} />
            <span>
              Make the first matched photo the main image
              <span className="field__hint">Off: new photos are added after each product&rsquo;s existing ones and the current main image stays.</span>
            </span>
          </label>
          {plannedProducts.length > 0 ? (
            <DiagnosticList
              title={`Products that get photos (${plannedProducts.length})`}
              hint="SKU — photos to add (photos it has now). A photo already on the product is skipped during the import."
              items={plannedProducts.map((p) => `${p.sku}${p.name ? ` · ${p.name}` : ''} — +${p.files.length} (has ${p.existingCount})`)}
              defaultOpen
            />
          ) : null}
          {overCapProducts.length > 0 ? (
            <DiagnosticList
              title={`Over the 50-image cap (${plan.capSkipped} photo${plan.capSkipped === 1 ? '' : 's'} on ${overCapProducts.length} product${overCapProducts.length === 1 ? '' : 's'})`}
              hint="These photos would not fit; the rest of each product's photos are still imported."
              items={overCapProducts.flatMap((p) => p.capSkipped.map((rel) => `${p.sku} — ${rel}`))}
              mono
            />
          ) : null}
          {Array.isArray(plan.unmatchedSamples) && plan.unmatchedSamples.length > 0 ? (
            <DiagnosticList
              title={`Unmatched files (${plan.unmatchedFiles}${plan.unmatchedSamplesCapped ? `, showing first ${plan.unmatchedSamples.length}` : ''})`}
              hint={`Files that match no SKU in this company. Paths are relative to the folder you picked.${plan.unmatchedExtCounts && Object.keys(plan.unmatchedExtCounts).length ? ` By type: ${Object.entries(plan.unmatchedExtCounts).sort(([, a], [, b]) => b - a).map(([ext, n]) => `${n} ${ext}`).join(' · ')}.` : ''}`}
              items={plan.unmatchedSamples}
              mono
            />
          ) : null}
        </>
      ) : step === 'importing' ? (
        <div className="automatch__importing">
          <div className="automatch__progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <div className="automatch__progress-bar" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
          <div className="ws-hint">
            {stopping ? 'Stopping after this batch — ' : 'Importing — '}
            {progress.done} of {progress.total} photo{progress.total === 1 ? '' : 's'}
          </div>
        </div>
      ) : step === 'results' && stats ? (
        <>
          {stats.cancelled ? (
            <p className="automatch__warn">Cancelled — {stats.notAttempted} planned photo{stats.notAttempted === 1 ? ' was' : 's were'} not imported. Run the folder again to add them; photos already added are skipped as duplicates.</p>
          ) : null}
          <div className="automatch__stats">
            <Stat label="Images imported" value={stats.imported} tone="emerald" />
            <Stat label="Products updated" value={stats.productsTouched} />
            <Stat label="Duplicates skipped" value={stats.skippedDup} />
            {stats.imagesFailed > 0 ? <Stat label="Failed" value={stats.imagesFailed} tone="amber" /> : null}
            {stats.capSkipped > 0 ? <Stat label="Over the 50-image cap" value={stats.capSkipped} tone="amber" /> : null}
          </div>
          {stats.imagesFailed > 0 ? (
            <DiagnosticList
              title={`Failed imports (${stats.imagesFailed})`}
              hint="These files matched a SKU but could not be imported. Fix the reported problem and run the folder again."
              items={stats.failures.map((failure) => `${failure.sku ? `${failure.sku} — ` : ''}${failure.filepath ? `${failure.filepath} — ` : ''}${failure.error}`)}
              mono
            />
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`automatch__stat${tone ? ` automatch__stat--${tone}` : ''}`}>
      <div className="automatch__stat-label">{label}</div>
      <div className="automatch__stat-value">{value}</div>
    </div>
  );
}

/**
 * Collapsible list of diagnostic strings (unmatched filenames, the planned
 * products, etc.). Starts collapsed unless `defaultOpen`; the Copy button
 * puts the whole list on the clipboard for triage in a text editor.
 */
function DiagnosticList({ title, hint, items, mono = false, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const addToast = useAppStore((s) => s.addToast);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(items.join('\n'));
      addToast(`Copied ${items.length} line${items.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      addToast(err.message || 'Copy failed', 'error');
    }
  }

  return (
    <details
      className="automatch__diag"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="automatch__diag-summary">
        <span>{title}</span>
        <span className="automatch__diag-actions">
          <button
            type="button"
            className="row-action"
            onClick={(e) => { e.preventDefault(); copyAll(); }}
          >Copy all</button>
        </span>
      </summary>
      {hint ? <p className="automatch__diag-hint">{hint}</p> : null}
      <ul className={`automatch__diag-list${mono ? ' automatch__diag-list--mono' : ''}`}>
        {items.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </details>
  );
}
