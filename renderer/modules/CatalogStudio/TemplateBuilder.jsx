import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Field, Input } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { useSaveShortcut } from '../../components/useSaveShortcut.js';
import { confirm } from '../../components/ConfirmModal.jsx';
import { DesignControls } from './DesignControls.jsx';
import { CatalogPreview } from './CatalogPreview.jsx';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { resolveSaveConflict } from '../../components/ConflictModal.jsx';
import { CATALOG_THEMES } from './catalogThemes.js';
import { blankCatalogDesign } from '../../lib/catalogDesign.js';
import { useAppStore } from '../../store/index.js';

/**
 * v0.1.63: the Catalog template builder.
 *
 * The complaint: "we can't build a template for the catalog too — it doesn't
 * have a builder at all". Before this the layout settings only existed inside a
 * project and the five named templates were a hard-coded array, so a layout
 * could be used once and never kept.
 *
 * Two things matter about how this works:
 *
 *  1. **The preview is a real page render.** It asks the main process
 *     (`catalogStudio:previewTemplate`) for the same HTML the PDF is built
 *     from, using this company's own products as samples. A CSS mock would
 *     drift from the print engine and the user would approve a preview that
 *     does not match the file — the same reasoning the Social Grid editor and
 *     the catalog project editor already follow.
 *
 *  2. **A draft is just a shape.** `draft` is `{ id?, name, description, config, updatedAt? }`
 *     — no id means "new", an id means "editing that template". That is what
 *     lets the same screen be opened from four places: New template, Edit on a
 *     card, Start from a proven layout, and Save-as-template from a project.
 */
export function CatalogTemplateBuilder({ draft, onClose, onSaved, backLabel = 'Catalog templates' }) {
  const addToast = useAppStore((s) => s.addToast);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const companies = useAppStore((s) => s.companies) ?? [];
  const priceGroups = (companies.find((c) => c.id === activeCompanyId)?.priceGroups) ?? [];

  const [name, setName] = useState(draft?.name ?? '');
  const [description, setDescription] = useState(draft?.description ?? '');
  /* A blank draft must still be a COMPLETE design. Starting from `{}` gave a
   * template with no card fields at all, so the catalog it produced printed no
   * SKU, name or price — the builder looked fine and the output was empty. */
  const [config, setConfig] = useState(() => ({ ...blankCatalogDesign(), ...(draft?.config || {}) }));
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewState, setPreviewState] = useState('refreshing');
  const [sample, setSample] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const requestSeq = useRef(0);
  const mounted = useRef(true);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const revision = useRef(draft?.updatedAt);
  const latest = useRef({ name, description, config });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestSeq.current += 1; };
  }, []);
  const isExisting = !!draft?.id;

  const refreshPreview = useCallback(async () => {
    const seq = ++requestSeq.current;
    setPreviewState('refreshing');
    setPreviewError('');
    try {
      const value = latest.current;
      const res = await window.api.catalogStudio.previewTemplate(value.config, value.name || 'Preview');
      if (!mounted.current || seq !== requestSeq.current) return;
      setPreview(res.html);
      setSample({ count: res.sampleCount, total: res.total });
      setPreviewError('');
      setPreviewState('idle');
    } catch (e) {
      if (mounted.current && seq === requestSeq.current) { setPreviewError(e.message); setPreviewState('error'); }
    }
  }, []);

  // Debounced: every keystroke in a colour picker or gap box would otherwise
  // start a full page render.
  useEffect(() => {
    const id = setTimeout(refreshPreview, 320);
    return () => clearTimeout(id);
  }, [refreshPreview, config, name]);

  const theme = useMemo(
    () => CATALOG_THEMES.find((t) => t.id === (config.theme || 'modern')) ?? CATALOG_THEMES[0],
    [config.theme],
  );

  function edit(patch) {
    if (savingRef.current) return;
    latest.current = { ...latest.current, ...patch };
    dirtyRef.current = true;
    setDirty(true);
    // Invalidate now, before React renders or the preview debounce fires.
    if ('config' in patch || 'name' in patch) {
      requestSeq.current += 1;
      setPreviewState('refreshing');
      setPreviewError('');
    }
    if ('config' in patch) setConfig(patch.config);
    if ('name' in patch) setName(patch.name);
    if ('description' in patch) setDescription(patch.description);
  }

  function patchConfig(patch) {
    edit({ config: { ...latest.current.config, ...patch } });
  }

  // One guard covers Back/Cancel, sidebar navigation and company changes.
  const canLeave = useCallback(async () => {
    if (savingRef.current) throw new Error('Wait for the template to finish saving before leaving.');
    if (!dirtyRef.current) return;
    const discard = await confirm({
      title: 'Discard your changes to this template?',
      message: `You have changes that are not saved. Press ${isExisting ? 'Save template' : 'Create template'} to keep them.`,
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (!discard) throw new Error('Keep editing this template or save it before leaving.');
    if (savingRef.current) throw new Error('Wait for the template to finish saving before leaving.');
  }, [isExisting]);

  useEffect(() => registerCompanySwitchFlusher(canLeave), [canLeave]);

  async function leave() {
    try { await canLeave(); onClose?.(); }
    catch (_) { /* Cancel keeps the draft; sidebar navigation surfaces its own error. */ }
  }

  async function save({ asCopy = false } = {}) {
    if (savingRef.current) return;
    const value = latest.current;
    const trimmed = value.name.trim();
    if (!trimmed) { addToast('Give the template a name', 'error'); return; }
    if (!activeCompanyId) { addToast('Select a company first', 'error'); return; }
    savingRef.current = true;
    setSaving(true);
    try {
      let row;
      const patch = { name: trimmed, description: value.description, config: value.config };
      if (isExisting && !asCopy) {
        try {
          row = await window.api.catalogStudio.updateTemplate(draft.id, { ...patch, expectedUpdatedAt: revision.current });
        } catch (error) {
          const result = await resolveSaveConflict(error, {
            refresh: () => window.api.catalogStudio.getTemplate(draft.id),
            overwrite: () => window.api.catalogStudio.updateTemplate(draft.id, patch),
          });
          if (!mounted.current || result.choice === 'cancel') return;
          row = result.row;
          if (result.choice === 'refresh') {
            revision.current = row.updatedAt;
            latest.current = { name: row.name, description: row.description ?? '', config: { ...blankCatalogDesign(), ...row.config } };
            setName(latest.current.name); setDescription(latest.current.description); setConfig(latest.current.config);
            dirtyRef.current = false; setDirty(false);
            requestSeq.current += 1; setPreviewState('refreshing');
            addToast('Template reloaded with the latest changes', 'info');
            return;
          }
        }
      } else {
        row = await window.api.catalogStudio.saveTemplate({
          companyId: activeCompanyId,
          name: asCopy ? `${trimmed} copy` : trimmed,
          description: value.description,
          config: value.config,
        });
      }
      if (!mounted.current) return;
      revision.current = row.updatedAt;
      dirtyRef.current = false; setDirty(false);
      addToast(isExisting && !asCopy ? `Template “${row.name}” saved` : `Template “${row.name}” created`, 'success');
      onSaved?.(row);
    } catch (e) {
      if (mounted.current) addToast(e.message, 'error');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  // 0.1.95: ⌘S is the header's Save template / Create template button.
  useSaveShortcut(() => { if (!saving && name.trim()) void save(); }, true);

  /* The dirty state is the §6 pill in the header (slate "Unsaved changes"),
   * not a strip above the panel that pushed the whole editor down. */
  return (
    <section className="page catalog-editor-page">
      <PageHeader
        title={name.trim() || 'Untitled template'}
        subtitle="A template keeps the look only — each catalog picks its own products."
        backTo={{ label: backLabel, onClick: leave }}
        actions={(
          <>
            {dirty || saving ? <SaveStatus state={saving ? 'saving' : 'dirty'} /> : null}
            <Button onClick={leave} disabled={saving}>Cancel</Button>
            {isExisting ? <Button onClick={() => save({ asCopy: true })} disabled={saving}>Save as copy</Button> : null}
            <Button variant="primary" onClick={() => save()} disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : isExisting ? 'Save template' : 'Create template'}
            </Button>
          </>
        )}
      />
      <div className="catalog-editor">
        <aside className="catalog-sidebar">
          <fieldset className="catalog-template-form" disabled={saving}>
          <section className="catalog-sidebar__section">
            <h3 className="section-title">Template</h3>
            <Field label="Name" required>
              {({ id }) => <Input id={id} autoFocus value={name} onChange={(e) => edit({ name: e.target.value })} placeholder="e.g. 2026 Wholesale — 4 column" />}
            </Field>
            <Field label="Description">
              {({ id }) => <Input id={id} value={description} onChange={(e) => edit({ description: e.target.value })} placeholder="What is this layout for?" />}
            </Field>
          </section>
          <DesignControls config={config} onChange={patchConfig} priceGroups={priceGroups} />
          </fieldset>
        </aside>
        <CatalogPreview
          preview={preview}
          onRefresh={refreshPreview}
          config={config}
          state={previewState}
          error={previewError}
          title={`Template preview — ${theme.name}${sample ? ` · ${sample.count} of ${sample.total} product${sample.total === 1 ? '' : 's'} shown` : ''}`}
        />
      </div>
    </section>
  );
}
