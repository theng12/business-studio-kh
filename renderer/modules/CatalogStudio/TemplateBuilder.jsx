import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Field, Input } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';
import { DesignControls } from './DesignControls.jsx';
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
 *  2. **A draft is just a shape.** `draft` is `{ id?, name, description, config }`
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
  const [sample, setSample] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const requestSeq = useRef(0);
  const isExisting = !!draft?.id;

  const refreshPreview = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const res = await window.api.catalogStudio.previewTemplate(config, name || 'Preview');
      if (seq !== requestSeq.current) return;
      setPreview(res.html);
      setSample({ count: res.sampleCount, total: res.total });
      setPreviewError('');
    } catch (e) {
      if (seq === requestSeq.current) setPreviewError(e.message);
    }
  }, [config, name]);

  // Debounced: every keystroke in a colour picker or gap box would otherwise
  // start a full page render.
  useEffect(() => {
    const id = setTimeout(refreshPreview, 320);
    return () => clearTimeout(id);
  }, [refreshPreview]);

  const theme = useMemo(
    () => CATALOG_THEMES.find((t) => t.id === (config.theme || 'modern')) ?? CATALOG_THEMES[0],
    [config.theme],
  );

  function patchConfig(patch) {
    setDirty(true);
    setConfig((c) => ({ ...c, ...patch }));
  }

  /* The builder does not autosave (a template is committed with its Save
   * button), so leaving it with changes asks first — "← Catalog templates" and
   * Cancel used to drop them without a word. */
  async function leave() {
    if (dirty && !(await confirm({
      title: 'Discard your changes to this template?',
      message: `You have changes that are not saved. Press ${isExisting ? 'Save template' : 'Create template'} to keep them.`,
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true,
    }))) return;
    onClose?.();
  }

  async function save({ asCopy = false } = {}) {
    const trimmed = name.trim();
    if (!trimmed) { addToast('Give the template a name', 'error'); return; }
    if (!activeCompanyId) { addToast('Select a company first', 'error'); return; }
    setSaving(true);
    try {
      let row;
      if (isExisting && !asCopy) {
        row = await window.api.catalogStudio.updateTemplate(draft.id, { name: trimmed, description, config });
      } else {
        row = await window.api.catalogStudio.saveTemplate({
          companyId: activeCompanyId,
          name: asCopy ? `${trimmed} copy` : trimmed,
          description,
          config,
        });
      }
      setDirty(false);
      addToast(isExisting && !asCopy ? `Template “${row.name}” saved` : `Template “${row.name}” created`, 'success');
      onSaved?.(row);
    } catch (e) {
      addToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

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
          <section className="catalog-sidebar__section">
            <h3 className="section-title">Template</h3>
            <Field label="Name" required>
              {({ id }) => <Input id={id} autoFocus value={name} onChange={(e) => { setDirty(true); setName(e.target.value); }} placeholder="e.g. 2026 Wholesale — 4 column" />}
            </Field>
            <Field label="Description">
              {({ id }) => <Input id={id} value={description} onChange={(e) => { setDirty(true); setDescription(e.target.value); }} placeholder="What is this layout for?" />}
            </Field>
          </section>
          <DesignControls config={config} onChange={patchConfig} priceGroups={priceGroups} />
        </aside>
        <main className="catalog-preview">
          <div className="catalog-preview__head">
            <span>
              Live preview — {theme.name}
              {sample ? ` · ${sample.count} of ${sample.total} product${sample.total === 1 ? '' : 's'} shown` : ''}
            </span>
            <Button size="sm" onClick={refreshPreview}>Refresh</Button>
          </div>
          {previewError
            ? <div className="preview-placeholder preview-placeholder--error">{previewError}</div>
            : preview
              ? <iframe title="Catalog template preview" srcDoc={preview} />
              : <div className="preview-placeholder">Building preview…</div>}
        </main>
      </div>
    </section>
  );
}
