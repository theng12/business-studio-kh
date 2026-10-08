/**
 * v0.1.25 — Social Grid.
 *
 * Turns a recipe ("this brand, sorted this way, square, with prices") into one
 * or more square images sized for a Facebook or Instagram post.
 *
 * The page has two screens, like Catalog Studio: a list of saved posts, and an
 * editor. The editor does NOT re-draw the grid in CSS to preview it — it asks
 * the main process for a small REAL render (socialGrid:preview) and shows that
 * image. Two layout implementations would drift apart, and the user would end
 * up approving a preview that does not match the file they post.
 *
 * On a client Mac everything here still works: the presets, the product list
 * and the preview all come from the server over RPC, and the export renders
 * there and ships the finished images back to be written on this Mac.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Input, Modal, Select } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { formatDate } from '../../lib/format.js';
import { GenerationExperience } from '../../components/GenerationExperience.jsx';
import { useAppStore } from '../../store/index.js';
import { CANVAS_PRESETS, GridControls } from './GridControls.jsx';
import { createLatestSaveQueue } from '../../lib/latestSaveQueue.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { parseConflictError, resolveSaveConflict } from '../../components/ConflictModal.jsx';

/** Config keys that change WHICH products are selected rather than merely how
 *  they are drawn. Editing one of these invalidates the page the user is on. */
const PAGE_AFFECTING_KEYS = ['source', 'brandId', 'categoryId', 'subcategory',
  'stockScope', 'stockMin', 'stockMax', 'lowStockAt', 'productIds', 'limit', 'excludeInactive'];

function editablePreset(preset, expectedUpdatedAt) {
  return {
    name: preset.name,
    config: preset.config,
    ...(expectedUpdatedAt == null ? {} : { expectedUpdatedAt }),
  };
}

/* The server's copy of a preset after a save. When its config is the one we
 * just sent, keep OUR config object: `config` identity drives the preview
 * effect, and adopting an equal-but-new object re-rendered the preview on the
 * server a second time (and flashed "Updating…") after every edit. */
function withLocalConfig(row, local) {
  if (!row || !local?.config) return row;
  const kept = JSON.stringify(row.config) === JSON.stringify(local.config) ? { ...row, config: local.config } : row;
  return withLocalName(kept, local);
}

/* v0.1.89: the server trims the name it stores, so a save that lands while the
 * user is mid-word ("Summer " → "Summer") used to put the trimmed name back in
 * the field and eat the space just typed — the next letter then joined the
 * previous word. When the only difference is that trim, the field keeps what
 * the user typed. */
export function withLocalName(row, local) {
  if (!row || typeof local?.name !== 'string') return row;
  return local.name !== row.name && local.name.trim() === row.name ? { ...row, name: local.name } : row;
}

function describeSize(config) {
  const preset = CANVAS_PRESETS.find((p) => p.width === config.width && p.height === config.height);
  return preset ? `${preset.name} · ${config.width} × ${config.height}` : `${config.width} × ${config.height}`;
}

function describeRecipe(config, brands, categories) {
  switch (config.source) {
    case 'brand': return `Brand: ${brands.find((b) => b.id === config.brandId)?.name || 'not chosen'}`;
    case 'category': return `Category: ${categories.find((x) => x.id === config.categoryId)?.name || 'not chosen'}`;
    case 'subcategory': return `Subcategory: ${config.subcategory || 'not set'}`;
    case 'picked': return `${(config.productIds || []).length} hand-picked products`;
    default: return 'All products';
  }
}

/* UI pass, 2026-10: posts and templates are the same house card
 * (docs/UI_GUIDE.md) — they used to be a solid card and a dashed one. The
 * eyebrow says which is which ("3 × 3 grid" / "Template"); the actions follow
 * the card pattern: primary first, outlined next, Delete (danger) last. */
function GridThumb({ config, onClick, label }) {
  return (
    <button type="button" className="card__media social-card__visual" onClick={onClick} aria-label={label}>
      <span className="social-card__frame" data-square={config.width === config.height ? 'yes' : 'no'}>
        {Array.from({ length: Math.min(config.columns * config.rows, 25) }, (_, i) => <i key={i} />)}
      </span>
    </button>
  );
}

function PresetCard({ preset, brands, categories, onOpen, onDuplicate, onDelete }) {
  const c = preset.config;
  return (
    <article className="card social-card">
      <GridThumb config={c} onClick={onOpen} label={`Open ${preset.name}`} />
      <div className="card__body">
        <span className="card__eyebrow">{c.columns} × {c.rows} grid</span>
        <h3 className="card__title">{preset.name}</h3>
        <p className="card__meta">{describeSize(c)} · {describeRecipe(c, brands, categories)}</p>
        <p className="card__meta social-card__status">
          {preset.lastExportedAt ? `Last exported ${formatDate(preset.lastExportedAt)}` : 'Not exported yet'}
        </p>
      </div>
      <div className="card__actions">
        <Button variant="primary" size="sm" onClick={onOpen}>Open</Button>
        <Button size="sm" onClick={onDuplicate}>Duplicate</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
      </div>
    </article>
  );
}

/**
 * v0.1.62: a reusable look. A template has no products of its own, so the card
 * shows the layout and the text it will draw, and its main action is "use this
 * in a new post". The other way to use one is from the Product Library, where
 * it is applied to whatever is selected.
 */
function TemplateCard({ template, onUse, onEdit, onDuplicate, onDelete }) {
  const c = template.config;
  return (
    <article className="card social-card">
      <GridThumb config={c} onClick={onUse} label={`Start a post from ${template.name}`} />
      <div className="card__body">
        <span className="card__eyebrow">Template</span>
        <h3 className="card__title">{template.name}</h3>
        <p className="card__meta">{describeSize(c)} · {c.columns} × {c.rows} grid</p>
        <p className="card__meta social-card__traits">
          {[
            c.showPhoto ? 'photos' : 'no photos',
            c.showName ? 'names' : null,
            c.showPrice ? 'prices' : null,
            c.showBrand ? 'brands' : null,
            c.title ? `title “${c.title}”` : null,
          ].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className="card__actions">
        <Button variant="primary" size="sm" onClick={onUse} title="Start a new post with this look">Use template</Button>
        <Button size="sm" onClick={onEdit}>Rename</Button>
        <Button size="sm" onClick={onDuplicate}>Duplicate</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
      </div>
    </article>
  );
}

/* UI pass, 2026-10: the pane no longer carries its own "Export images" — that
 * was the second copy of the header's primary action on one screen. */
function PreviewPane({ preview, loading, error, config, onPage }) {
  const summary = preview?.summary;
  const pageCount = preview?.pageCount ?? 0;
  const pageIndex = preview?.pageIndex ?? 0;

  return (
    <main className="social-preview">
      <div className="social-preview__bar">
        <span>Preview{pageCount > 1 ? ` — image ${pageIndex + 1} of ${pageCount}` : ''}</span>
        <div className="social-preview__nav">
          {pageCount > 1 ? (
            <>
              <Button size="sm" disabled={pageIndex <= 0} onClick={() => onPage(pageIndex - 1)} aria-label="Previous image" title="Previous image"><PagerIcon dir="left" /></Button>
              <Button size="sm" disabled={pageIndex >= pageCount - 1} onClick={() => onPage(pageIndex + 1)} aria-label="Next image" title="Next image"><PagerIcon dir="right" /></Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="social-preview__stage">
        {error ? <div className="preview-placeholder preview-placeholder--error">{error}</div>
          : !summary?.total ? <div className="preview-placeholder">No products match these filters yet. Widen the selection, or clear the stock filter.</div>
            : preview?.dataUrl ? <img className="social-preview__image" src={preview.dataUrl} alt="Grid preview" />
              : <div className="preview-placeholder">Building preview…</div>}
        {loading && preview?.dataUrl ? <span className="social-preview__busy">Updating…</span> : null}
      </div>

      {summary ? (
        <div className="social-preview__facts">
          <span><strong>{summary.total}</strong> product{summary.total === 1 ? '' : 's'}</span>
          <span><strong>{summary.pages}</strong> image{summary.pages === 1 ? '' : 's'}</span>
          <span><strong>{summary.perPage}</strong> per image</span>
          <span><strong>{config.width} × {config.height}</strong> px</span>
          {summary.withoutPhoto > 0 ? <span className="is-warning"><strong>{summary.withoutPhoto}</strong> without a photo</span> : null}
          {summary.noPrice > 0 ? <span className="is-warning"><strong>{summary.noPrice}</strong> with no {summary.priceLabel} price</span> : null}
          {summary.uncounted > 0 ? <span><strong>{summary.uncounted}</strong> with no stock count</span> : null}
        </div>
      ) : null}
    </main>
  );
}

function PagerIcon({ dir }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d={dir === 'left' ? 'M7.5 2.5L4 6l3.5 3.5' : 'M4.5 2.5L8 6l-3.5 3.5'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* The folder Social Grid images were last exported to, per company, on this
 * Mac. Wrapped: storage can be missing (tests, a locked-down profile). */
function exportFolderKey(companyId) { return `SocialGrid.exportFolder.${companyId || 'none'}`; }
export function loadExportFolder(companyId) {
  try { return globalThis.localStorage?.getItem(exportFolderKey(companyId)) || ''; } catch { return ''; }
}
function saveExportFolder(companyId, folder) {
  try { globalThis.localStorage?.setItem(exportFolderKey(companyId), folder || ''); } catch { /* storage unavailable */ }
}

/** Whether a progress event belongs to THIS screen's export run. Every
 *  export broadcasts on the same bus, so a second export (another window,
 *  another Mac on the server) used to move this bar too (audit 2026-10). */
export function isOwnSocialProgress(ev, runId) {
  return !!ev && ev.kind === 'socialGrid' && !ev.complete && !!runId && ev.id === runId;
}

/** Progress for the export overlay from the server's real per-image events:
 *  5% before the first image, then evenly up to 95%, 100% when it returns. */
export function socialExportProgress(ev) {
  const total = Number(ev?.total) || 0;
  const done = Math.max(0, Number(ev?.done) || 0);
  if (!total) return { progress: 5, detail: '' };
  return { progress: 5 + Math.min(1, done / total) * 90, detail: `Image ${Math.min(done + 1, total)} of ${total}` };
}

/** 0.1.95: the toast after an export, honest about a cancel — the images
 *  already written stay in the folder, so say how many there are. */
export function socialExportMessage(res, folder) {
  const written = Number(res?.written ?? res?.outputPaths?.length ?? res?.pageCount ?? 0) || 0;
  const plural = (n) => `${n} image${n === 1 ? '' : 's'}`;
  if (res?.cancelled) {
    return { text: written ? `Export cancelled — ${plural(written)} written to ${folder}` : 'Export cancelled — no images written', kind: 'info' };
  }
  const n = Number(res?.pageCount ?? written) || 0;
  return { text: `Saved ${plural(n)} to ${folder}`, kind: 'success' };
}

export function PresetEditor({ presetId, onBack }) {
  const companyId = useAppStore((s) => s.activeCompanyId);
  const companySwitching = useAppStore((s) => s.companySwitching);
  const addToast = useAppStore((s) => s.addToast);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);
  // The whole company — `products` is the Library's filtered view, and a
  // hand-picked post must be able to find any product.
  const products = useAppStore((s) => s.allProducts) ?? [];
  // v0.1.55: this company's named price groups — "which price" can pick one.
  // `?? []` because the component tests stub the store with only what a case
  // needs; a missing list must read as "no groups", not crash.
  const companies = useAppStore((s) => s.companies) ?? [];
  const priceGroups = (companies.find((c) => c.id === companyId)?.priceGroups) ?? [];
  const refreshBrands = useAppStore((s) => s.refreshBrands);
  const refreshCategories = useAppStore((s) => s.refreshCategories);

  const [preset, setPreset] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [saveState, setSaveState] = useState('saved');
  const [savedAt, setSavedAt] = useState(null);
  const [exporting, setExporting] = useState(false);
  const exportRunId = useRef('');   // this run's progress id (isOwnSocialProgress)
  const [cancellingExport, setCancellingExport] = useState(false);
  // Cancel pressed for this run — read after the pre-export flush, so a
  // Cancel during that wait never starts the export at all.
  const cancelRequested = useRef(false);
  const [progress, setProgress] = useState(0);
  const [progressDetail, setProgressDetail] = useState('');
  const [exportFolder, setExportFolder] = useState(() => loadExportFolder(companyId));
  useEffect(() => { setExportFolder(loadExportFolder(companyId)); }, [companyId]);
  // Real progress: the export sends one event per image it writes (kind
  // 'socialGrid'). It used to be a timer that crept to 88% whatever happened.
  // 0.1.95: a client Mac now gets them too — its run id travels to the
  // server's render, which broadcasts per image over the WebSocket.
  useEffect(() => {
    if (!exporting || !window.api?.events?.onProgress) return undefined;
    const off = window.api.events.onProgress((ev) => {
      if (!isOwnSocialProgress(ev, exportRunId.current)) return;
      const next = socialExportProgress(ev);
      setProgress(next.progress);
      if (next.detail) setProgressDetail(next.detail);
    });
    return () => { if (typeof off === 'function') off(); };
  }, [exporting]);
  // v0.1.62: save the look as a reusable template.
  const [templating, setTemplating] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  // v0.1.89: '' = a new template; otherwise the id of the template whose look
  // this post replaces — the way to EDIT a template's design.
  const [templateTarget, setTemplateTarget] = useState('');
  const [templateChoices, setTemplateChoices] = useState([]);
  const saveTimer = useRef(null);
  const previewTimer = useRef(null);
  const latest = useRef(null);
  /** True while an edit has not yet reached the server, so unmount can flush it. */
  const dirty = useRef(false);
  const saveQueue = useRef(null);
  const acknowledgedRevision = useRef(null);
  const editorGeneration = useRef(0);
  const remoteSeq = useRef(0);

  useEffect(() => { void refreshBrands(); void refreshCategories(); }, [refreshBrands, refreshCategories]);

  useEffect(() => {
    let cancelled = false;
    const generation = ++editorGeneration.current;
    saveQueue.current = null;
    latest.current = null;
    dirty.current = false;
    window.api.socialGrid.get(presetId)
      .then((row) => { if (!cancelled && generation === editorGeneration.current) { setPreset(row); setSavedAt(row.updatedAt); latest.current = row; acknowledgedRevision.current = row.updatedAt; dirty.current = false; } })
      .catch((e) => { if (!cancelled && generation === editorGeneration.current) addToast(e.message, 'error'); });
    return () => { cancelled = true; editorGeneration.current += 1; };
  }, [presetId, companyId, addToast]);

  useEffect(() => {
    const offs = [];
    const generation = editorGeneration.current;
    const refresh = (event) => {
      if (event?.kind !== 'socialGrid' || event.id !== presetId || dirty.current) return;
      if (event.op === 'delete') { onBack(); return; }
      const seq = ++remoteSeq.current;
      window.api.socialGrid.get(presetId).then((row) => {
        if (generation === editorGeneration.current && seq === remoteSeq.current && !dirty.current) { const kept = withLocalConfig(row, latest.current); setPreset(kept); latest.current = kept; acknowledgedRevision.current = row.updatedAt; saveQueue.current?.setRevision(row.updatedAt); setSavedAt(row.updatedAt); }
      }).catch((e) => { if (generation === editorGeneration.current && seq === remoteSeq.current) addToast(e.message, 'error'); });
    };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => refresh({ kind: 'socialGrid', id: presetId, op: 'update' })));
    return () => offs.forEach((off) => off?.());
  }, [presetId, onBack, addToast]);

  const config = preset?.config;

  // Preview is a real render, so it costs real time — debounce it, and drop a
  // request that a newer edit has already superseded.
  /* v0.1.27: only the newest preview may commit.
   *
   * A preview is a real render on the server, so two edits about half a second
   * apart can have their responses come back out of order — and `setPreview`
   * used to accept whichever arrived last, which could be the OLDER render. The
   * pane would then sit on a stale image that does not match the settings (or
   * the file the export produces). The comment here previously CLAIMED
   * superseded requests were dropped, which was not true; now it is. */
  const previewSeq = useRef(0);
  const refreshPreview = useCallback(async (cfg, page) => {
    if (!cfg) return;
    const seq = (previewSeq.current += 1);
    const fresh = () => seq === previewSeq.current;
    setLoading(true);
    try {
      const res = await window.api.socialGrid.preview(cfg, page);
      if (!fresh()) return;
      setPreview(res);
      setError('');
      // The server clamps the page index; follow it so the buttons agree.
      if (res?.pageIndex !== page) setPageIndex(res?.pageIndex ?? 0);
    } catch (e) {
      if (fresh()) setError(e.message);
    } finally {
      if (fresh()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!config) return undefined;
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => { void refreshPreview(config, pageIndex); }, 420);
    return () => clearTimeout(previewTimer.current);
  }, [config, pageIndex, refreshPreview]);

  const ensureSaveQueue = useCallback(() => {
    if (!saveQueue.current) {
      const generation = editorGeneration.current;
      saveQueue.current = createLatestSaveQueue({
        initialRevision: acknowledgedRevision.current,
        persist: (next, expectedUpdatedAt) => window.api.socialGrid.update(next.id, editablePreset(next, expectedUpdatedAt)),
        onStart: () => { if (generation === editorGeneration.current) setSaveState('saving'); },
        onSuccess: (row, value) => {
          if (generation !== editorGeneration.current) return;
          acknowledgedRevision.current = row.updatedAt;
          if (latest.current !== value) return;
          const kept = withLocalConfig(row, value);
          setPreset(kept); latest.current = kept; dirty.current = false; setSavedAt(Date.now()); setSaveState('saved');
        },
        onError: (e) => {
          if (generation !== editorGeneration.current) return;
          dirty.current = true; setSaveState('dirty');
          if (!parseConflictError(e)) addToast(e.message, 'error');
        },
      });
    }
    return saveQueue.current;
  }, [addToast]);
  const save = useCallback((value = latest.current) => {
    if (!value) return Promise.resolve();
    clearTimeout(saveTimer.current);
    ensureSaveQueue().enqueue(value);
    return Promise.resolve();
  }, [ensureSaveQueue]);
  const flushPending = useCallback(() => {
    if (!dirty.current || !latest.current) return Promise.resolve();
    clearTimeout(saveTimer.current);
    return ensureSaveQueue().flush(() => dirty.current ? latest.current : null);
  }, [ensureSaveQueue]);
  const saveNow = useCallback(async () => {
    const generation = editorGeneration.current;
    try {
      await flushPending();
      return true;
    } catch (error) {
      let overwrittenDraft = null;
      try {
        const result = await resolveSaveConflict(error, {
          refresh: () => window.api.socialGrid.get(presetId),
          overwrite: () => {
            if (generation !== editorGeneration.current || latest.current?.id !== presetId) return Promise.reject(new Error('Editor changed before conflict resolution'));
            overwrittenDraft = latest.current;
            return window.api.socialGrid.update(overwrittenDraft.id, editablePreset(overwrittenDraft));
          },
        });
        if (result.choice === 'cancel') return false;
        if (generation !== editorGeneration.current || latest.current?.id !== presetId) return false;
        const row = result.row;
        acknowledgedRevision.current = row.updatedAt;
        ensureSaveQueue().setRevision(row.updatedAt);
        if (result.choice === 'refresh' || latest.current === overwrittenDraft) {
          const kept = withLocalConfig(row, latest.current);
          setPreset(kept); latest.current = kept; dirty.current = false; setSavedAt(Date.now()); setSaveState('saved');
          return true;
        }
        await flushPending();
        return true;
      } catch (nextError) {
        dirty.current = true; setSaveState('dirty'); addToast(nextError.message, 'error');
        return false;
      }
    }
  }, [addToast, ensureSaveQueue, flushPending, presetId]);
  useEffect(() => registerCompanySwitchFlusher(flushPending), [flushPending]);

  /* One place applies a new preset value, mirrors it into `latest` for the
   * explicit Save button, marks the form dirty and schedules the autosave.
   *
   * Deliberately NOT done inside a setPreset() updater: React may call an
   * updater more than once, and scheduling timers or setting other state from
   * inside one is a side effect in what must be a pure function. `preset` is
   * the current render's value, which is fresh for every user keystroke. */
  function applyNext(next) {
    if (companySwitching) return;
    remoteSeq.current += 1;
    setPreset(next);
    latest.current = next;
    dirty.current = true;
    setSaveState('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(next), 600);
  }

  function change(patch) {
    applyNext({ ...preset, ...patch });
  }

  function changeConfig(patch) {
    applyNext({ ...preset, config: { ...preset.config, ...patch } });
    // A change to WHICH products are selected can leave the user looking at a
    // page number that no longer exists, so go back to the first image.
    for (const key of PAGE_AFFECTING_KEYS) {
      if (key in patch) { setPageIndex(0); break; }
    }
  }

  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    clearTimeout(previewTimer.current);
    /* Flush, do not discard. The autosave is debounced by 600ms, so "type a
     * name, click Back" would otherwise throw the edit away: the pending timer
     * is cancelled on unmount and the change never reaches the server. Saving
     * here is fire-and-forget — this component is already gone, and the toast
     * from a failure would be the only trace. */
    if (dirty.current && latest.current) void save(latest.current);
    editorGeneration.current += 1;
  }, [save]);

  async function leaveEditor() {
    try { await flushPending(); onBack(); }
    catch (saveError) { if (parseConflictError(saveError)) addToast('This post changed elsewhere. Use Save to review it before leaving.', 'error'); }
  }

  /* The design comes from what is on screen, not from the last saved row: if
   * the user has been dragging sliders and immediately saves a template, the
   * template must capture what they are looking at. The server strips the
   * product selection either way (see main/db/socialGridTemplates.js). */
  async function openTemplating() {
    setTemplateName(`${preset.name} template`);
    setTemplateTarget('');
    setTemplating(true);
    try { setTemplateChoices(await window.api.socialGrid.listTemplates(companyId)); }
    catch { setTemplateChoices([]); }
  }

  async function saveAsTemplate() {
    const name = templateName.trim();
    if (!name) { addToast('Give the template a name', 'error'); return; }
    setSavingTemplate(true);
    try {
      if (templateTarget) {
        const target = templateChoices.find((t) => t.id === templateTarget);
        await window.api.socialGrid.updateTemplate(templateTarget, {
          name,
          config: preset.config,
          ...(target?.updatedAt != null ? { expectedUpdatedAt: Number(target.updatedAt) } : {}),
        });
      } else {
        await window.api.socialGrid.saveTemplate({ companyId, name, config: preset.config });
      }
      setTemplating(false);
      setTemplateName('');
      setTemplateTarget('');
      addToast(templateTarget ? `Template “${name}” updated with this look` : `Template “${name}” saved`, 'success');
    } catch (e) {
      addToast(parseConflictError(e) ? 'That template changed elsewhere. Close this and try again.' : e.message, 'error');
    } finally {
      setSavingTemplate(false);
    }
  }

  async function pickExportFolder() {
    let folder;
    try { folder = await window.api.files.pickFolder(); } catch (e) { addToast(e.message, 'error'); return null; }
    if (!folder) return null;
    setExportFolder(folder);
    saveExportFolder(companyId, folder);
    return folder;
  }

  async function exportImages() {
    // The last folder is remembered per company; "Change folder…" picks another.
    let folder = exportFolder;
    if (!folder) {
      try { folder = await window.api.files.pickFolder(); } catch (e) { addToast(e.message, 'error'); return; }
      if (!folder) return;
      setExportFolder(folder);
      saveExportFolder(companyId, folder);
    }
    exportRunId.current = `social-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCancellingExport(false);
    cancelRequested.current = false;
    setExporting(true);
    setProgress(5);
    setProgressDetail('');
    try {
      if (dirty.current) await flushPending();
      if (cancelRequested.current) {
        const message = socialExportMessage({ cancelled: true, written: 0 }, folder);
        addToast(message.text, message.kind);
        return;
      }
      const generation = editorGeneration.current;
      const committed = latest.current || preset;
      const baselineRevision = acknowledgedRevision.current;
      const res = await window.api.socialGrid.exportImages(committed.config, folder, committed.id, exportRunId.current);
      setProgress(100);
      const message = socialExportMessage(res, folder);
      addToast(message.text, message.kind);
      if (res?.cancelled) return;
      const row = await window.api.socialGrid.get(committed.id);
      const ownsBaseline = generation === editorGeneration.current
        && latest.current?.id === committed.id
        && row.id === committed.id
        && acknowledgedRevision.current === baselineRevision
        && Number(row.updatedAt) >= Number(baselineRevision);
      if (ownsBaseline && latest.current === committed && !dirty.current) {
        acknowledgedRevision.current = row.updatedAt;
        saveQueue.current?.setRevision(row.updatedAt);
        setPreset(row);
        latest.current = row;
        dirty.current = false;
      } else if (ownsBaseline && dirty.current
        && JSON.stringify(editablePreset(row)) === JSON.stringify(editablePreset(committed))) {
        acknowledgedRevision.current = row.updatedAt;
        saveQueue.current?.setRevision(row.updatedAt);
      }
    } catch (e) {
      // A remembered folder that cannot be written any more (an unplugged
      // drive, a deleted folder) is forgotten, so the next Export asks again.
      if (/\b(ENOENT|EACCES|EPERM|EROFS)\b/.test(String(e?.message || ''))) {
        setExportFolder('');
        saveExportFolder(companyId, '');
      }
      addToast(parseConflictError(e) ? 'This post changed elsewhere. Use Save to review it before exporting.' : e.message, 'error');
    } finally {
      setExporting(false);
      setCancellingExport(false);
    }
  }

  async function cancelExport() {
    const runId = exportRunId.current;
    if (!runId || cancellingExport) return;
    cancelRequested.current = true;
    setCancellingExport(true);
    // The main process remembers a Cancel that arrives before the run is
    // registered (socialGrid.js earlyCancels), so this is safe at any point.
    if (!window.api?.socialGrid?.cancelExport) return;
    try {
      await window.api.socialGrid.cancelExport(runId);
    } catch (e) {
      setCancellingExport(false);
      addToast(e.message, 'error');
    }
  }

  if (!preset) return <div className="page-loading">Loading post…</div>;

  return (
    <section className="page social-editor-page">
      <PageHeader
        title={preset.name}
        subtitle="Social Grid post"
        backTo={{ label: 'Social Grid', onClick: leaveEditor }}
        actions={(
          <>
            <SaveStatus state={saveState} savedAt={savedAt} onSave={saveNow} />
            <Button
              onClick={() => { void openTemplating(); }}
              title="Save this look as a reusable template — the products it happens to be showing are not saved with it."
            >
              Save as template
            </Button>
            {exportFolder ? (
              <Button
                onClick={() => { void pickExportFolder(); }}
                disabled={exporting}
                title={`Images are saved to ${exportFolder}. Pick another folder.`}
              >
                Change folder…
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={exportImages}
              disabled={exporting || preview?.summary?.total === 0}
              title={preview?.summary?.total === 0 ? 'No products match these filters yet' : exportFolder ? `Save to ${exportFolder}` : 'Choose a folder, then save the images there'}
            >
              {exporting ? 'Exporting…' : 'Export images'}
            </Button>
          </>
        )}
      />
      <div className="social-editor">
        <div className="social-editor__left">
          <label className="field">
            <span className="field__label">Post name</span>
            <Input value={preset.name} onChange={(e) => change({ name: e.target.value })} placeholder="e.g. Nike — retail prices" />
            <span className="field__hint">Give it a name you will recognise next month.</span>
          </label>
          <GridControls
            config={config}
            onChange={changeConfig}
            brands={brands}
            categories={categories}
            products={products}
            priceGroups={priceGroups}
          />
        </div>
        <PreviewPane
          preview={preview}
          loading={loading}
          error={error}
          config={config}
          onPage={setPageIndex}
        />
      </div>
      <GenerationExperience
        open={exporting}
        title="Building your images"
        progress={progress}
        phase={progress <= 5 ? 0 : progress >= 95 ? 3 : 2}
        detail={progressDetail ? `${preset.name} · ${progressDetail}` : preset.name}
        onCancel={cancelExport}
        cancelling={cancellingExport}
      />

      <Modal
        open={templating}
        onClose={() => setTemplating(false)}
        title="Save as template"
        footer={(
          <>
            <Button onClick={() => setTemplating(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveAsTemplate} disabled={savingTemplate || !templateName.trim()}>
              {savingTemplate ? 'Saving…' : templateTarget ? 'Update template' : 'Save template'}
            </Button>
          </>
        )}
      >
        <p className="muted social-modal-intro">
          A template keeps the look — size, grid, text, what each tile shows — and
          nothing about which products are in it. Apply it to any selection from the
          Product Library, or start a new post from it here.
        </p>
        {templateChoices.length ? (
          <label className="field">
            <span className="field__label">Save to</span>
            <Select
              value={templateTarget}
              onChange={(e) => {
                const id = e.target.value;
                setTemplateTarget(id);
                const t = templateChoices.find((x) => x.id === id);
                setTemplateName(t ? t.name : `${preset.name} template`);
              }}
            >
              <option value="">A new template</option>
              {templateChoices.map((t) => <option key={t.id} value={t.id}>Replace the look of “{t.name}”</option>)}
            </Select>
            <span className="field__hint">
              {templateTarget
                ? 'That template takes this post’s look. Posts already made from it do not change.'
                : 'Keeps every existing template as it is.'}
            </span>
          </label>
        ) : null}
        <label className="field">
          <span className="field__label">Template name</span>
          <Input
            autoFocus
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveAsTemplate(); }}
            placeholder="e.g. Square 3 × 3 with prices"
          />
        </label>
      </Modal>
    </section>
  );
}

export function SocialGrid() {
  const companyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const brands = useAppStore((s) => s.brands);
  const categories = useAppStore((s) => s.categories);

  const [presets, setPresets] = useState([]);
  // v0.1.62: reusable looks, listed above the posts.
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [startSize, setStartSize] = useState('square');
  // '' = blank post, otherwise the template id to seed it from.
  const [startFrom, setStartFrom] = useState('');
  const [busy, setBusy] = useState(false);
  // v0.1.89: renaming a template — { id, name, updatedAt } while the dialog is open.
  const [renaming, setRenaming] = useState(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!companyId) { setPresets([]); setEditing(null); return; }
    try {
      const [rows, tpls] = await Promise.all([
        window.api.socialGrid.list(companyId),
        window.api.socialGrid.listTemplates(companyId),
      ]);
      if (seq === requestSeq.current) { setPresets(rows); setTemplates(tpls); }
    } catch (e) { if (seq === requestSeq.current) addToast(e.message, 'error'); }
  }, [companyId, addToast]);

  useEffect(() => { setEditing(null); void load(); }, [companyId, load]);
  useEffect(() => {
    const offs = [];
    const refresh = (event) => { if (!event || event.kind === 'socialGrid') void load(); };
    if (window.api?.events?.onCatalogChanged) offs.push(window.api.events.onCatalogChanged(refresh));
    if (window.api?.events?.onServerHello) offs.push(window.api.events.onServerHello(() => { void load(); }));
    return () => offs.forEach((off) => off?.());
  }, [load]);

  const canvas = useMemo(() => CANVAS_PRESETS.find((p) => p.id === startSize) ?? CANVAS_PRESETS[0], [startSize]);

  async function create() {
    if (!companyId) return;
    setBusy(true);
    try {
      const template = templates.find((t) => t.id === startFrom) || null;
      const row = await window.api.socialGrid.create({
        companyId,
        name: name.trim() || (template ? `${template.name} post` : 'Untitled post'),
        // Square is the default the customer asked for; the size is chosen up
        // front because it changes what fits, same reasoning as the Overlay
        // Studio's canvas-size prompt.
        //
        // v0.1.62: starting from a template takes the template's own size and
        // every other setting — the size picker is hidden in that case rather
        // than silently overriding the look the user just chose. The stored
        // template config already carries the default selection (the server
        // strips products out of it), so the new post starts on "all products"
        // and the user narrows it in the editor.
        config: template
          ? { ...template.config }
          : { width: canvas.width, height: canvas.height },
      });
      setCreating(false);
      setName('');
      setStartFrom('');
      setPresets((list) => [row, ...list]);
      setEditing(row.id);
    } catch (e) {
      addToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveRename() {
    const nextName = renaming?.name?.trim();
    if (!renaming || !nextName) return;
    setRenameBusy(true);
    try {
      await window.api.socialGrid.updateTemplate(renaming.id, {
        name: nextName,
        ...(renaming.updatedAt != null ? { expectedUpdatedAt: Number(renaming.updatedAt) } : {}),
      });
      setRenaming(null);
      addToast(`Renamed to “${nextName}”`, 'success');
      await load();
    } catch (e) {
      addToast(parseConflictError(e) ? 'That template changed elsewhere. Close this and try again.' : e.message, 'error');
    } finally {
      setRenameBusy(false);
    }
  }

  async function deleteTemplate(t) {
    const ok = await confirm({
      title: `Delete the template “${t.name}”?`,
      message: 'Posts made from it and images you already exported are not affected.',
      detail: 'A deleted template does not go to Recently deleted — to keep its look, start a post from it first.',
      danger: true,
      confirmLabel: 'Delete template',
    });
    if (!ok) return;
    try { await window.api.socialGrid.removeTemplate(t.id); await load(); }
    catch (e) { addToast(e.message, 'error'); }
  }

  async function deletePost(p) {
    const ok = await confirm({
      title: `Delete “${p.name}”?`,
      message: 'The saved post (its products, layout and text) is removed. Images you already exported are not affected.',
      detail: 'A deleted post does not go to Recently deleted.',
      danger: true,
      confirmLabel: 'Delete post',
    });
    if (!ok) return;
    try { await window.api.socialGrid.remove(p.id); await load(); }
    catch (e) { addToast(e.message, 'error'); }
  }

  /** "Use in a new post" from a template card: same modal, pre-seeded. */
  function startPostFromTemplate(template) {
    setStartFrom(template.id);
    setName(`${template.name} post`);
    setCreating(true);
  }

  if (editing) {
    return <PresetEditor key={editing} presetId={editing} onBack={() => { setEditing(null); void load(); }} />;
  }

  return (
    <section className="page">
      {/* UI pass, 2026-10: the "One post, many products" intro banner is gone;
          its one useful sentence is the subtitle. */}
      <PageHeader
        title="Social Grid"
        subtitle="Turn a brand, category or stock level into grid images for Facebook or Instagram. Extra products continue as a numbered series."
        actions={<Button variant="primary" onClick={() => setCreating(true)} disabled={!companyId}>+ New post</Button>}
      />

      <section className="social-section">
        <div className="section-head">
          <h2 className="section-title">Templates</h2>
          <p className="section-hint">
            A reusable look with no products in it. Apply one from the Product Library, or start a post from it here.
          </p>
        </div>
        {templates.length ? (
          <div className="card-grid social-card-grid">
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                onUse={() => startPostFromTemplate(t)}
                onEdit={() => setRenaming({ id: t.id, name: t.name, updatedAt: t.updatedAt })}
                onDuplicate={async () => {
                  try { await window.api.socialGrid.duplicateTemplate(t.id); await load(); }
                  catch (e) { addToast(e.message, 'error'); }
                }}
                onDelete={() => { void deleteTemplate(t); }}
              />
            ))}
          </div>
        ) : (
          <p className="social-section__empty">
            No templates yet. Open a post and choose Save as template to reuse its look.
          </p>
        )}
        {templates.length ? (
          <p className="section-hint social-section__tip">
            To change a template’s look, open a post, set it up the way you want, then choose Save as template and pick the template to replace.
          </p>
        ) : null}
      </section>

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename template"
        footer={(
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button variant="primary" onClick={saveRename} disabled={renameBusy || !renaming?.name?.trim()}>
              {renameBusy ? 'Saving…' : 'Rename'}
            </Button>
          </>
        )}
      >
        <label className="field">
          <span className="field__label">Template name</span>
          <Input
            autoFocus
            value={renaming?.name ?? ''}
            onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(); }}
          />
        </label>
      </Modal>

      <section className="social-section">
        <div className="section-head">
          <h2 className="section-title">Posts</h2>
          {presets.length ? <p className="section-hint">{presets.length} saved</p> : null}
        </div>
        {presets.length ? (
          <div className="card-grid social-card-grid">
            {presets.map((p) => (
              <PresetCard
                key={p.id}
                preset={p}
                brands={brands}
                categories={categories}
                onOpen={() => setEditing(p.id)}
                onDuplicate={async () => {
                  try { await window.api.socialGrid.duplicate(p.id); await load(); }
                  catch (e) { addToast(e.message, 'error'); }
                }}
                onDelete={() => { void deletePost(p); }}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No saved posts yet"
            body="Create one, choose which products belong in it, and reuse it every time you post."
            action={<Button variant="primary" onClick={() => setCreating(true)} disabled={!companyId}>+ New post</Button>}
          />
        )}
      </section>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New social post"
        footer={(
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create post'}</Button>
          </>
        )}
      >
        <label className="field">
          <span className="field__label">Post name</span>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nike — retail prices" onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
        </label>
        <label className="field">
          <span className="field__label">Start from</span>
          <Select value={startFrom} onChange={(e) => setStartFrom(e.target.value)}>
            <option value="">Blank — the default square grid</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name} — {describeSize(t.config)}</option>
            ))}
          </Select>
          <span className="field__hint">
            {startFrom
              ? 'The template supplies the size and every other setting. Change anything in the editor.'
              : 'A template can be applied later from the Product Library too.'}
          </span>
        </label>
        {startFrom ? null : (
          <label className="field">
            <span className="field__label">Image size</span>
            <Select value={startSize} onChange={(e) => setStartSize(e.target.value)}>
              {CANVAS_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.width} × {p.height}</option>)}
            </Select>
            <span className="field__hint">{canvas.hint}. You can change this later.</span>
          </label>
        )}
      </Modal>
    </section>
  );
}
