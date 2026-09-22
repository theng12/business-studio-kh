/**
 * v0.1.62: "Apply a Social Grid template to products" — the Product Library's
 * half of Social Grid templates.
 *
 * The customer's report was that Social Grid had no templates, and that there
 * was no way to pick one and apply it from the Library. This is the apply half.
 *
 * How it differs from BulkOverlayRunModal, and why:
 *
 *   - A Social Grid image holds MANY products, so the output is not one file per
 *     product. The footer therefore commits to a number of IMAGES, computed by
 *     the same selection code the renderer uses (`socialGrid:plan`) rather than
 *     guessed in the UI.
 *   - The template supplies only the look. Which products go in comes from the
 *     Library: the ticked selection, or everything the current filter matches.
 *     The template's own recipe is never used here — that is what makes it
 *     reusable, and it is why `social_grid_templates` strips selection keys on
 *     the way in.
 *   - The export writes finished images to a folder on this Mac (the same call
 *     the Social Grid editor's "Export images" makes, so it works in client mode
 *     too — the server renders, this Mac saves).
 *
 * The user can also keep the result as a Social Grid post, which is the bridge
 * to the editor: tweak the layout, then re-export. That post is created AFTER a
 * successful export, so a failed render never leaves a half-configured post
 * behind.
 */
import { useEffect, useState } from 'react';
import { Modal, Button, Field, Input, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

export function BulkSocialRunModal({ open, productIds, onClose, onDone }) {
  const addToast = useAppStore((s) => s.addToast);
  const companyId = useAppStore((s) => s.activeCompanyId);
  const products = useAppStore((s) => s.products) ?? [];

  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [scope, setScope] = useState('selection'); // 'selection' | 'filter'
  const [folder, setFolder] = useState('');
  const [keepPost, setKeepPost] = useState(true);
  const [postName, setPostName] = useState('');
  const [plan, setPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  /* Reset whenever the modal opens. Deps stay `[open]` on purpose: including
   * templateId would re-run this (and reset the user's scope choice) every time
   * they picked a different template. Same reasoning as BulkOverlayRunModal. */
  useEffect(() => {
    if (!open) return;
    window.api.socialGrid.listTemplates(companyId)
      .then((rows) => {
        setTemplates(rows);
        setTemplateId(rows[0]?.id ?? '');
      })
      .catch((err) => addToast(err.message, 'error'));
    setScope('selection');
    setKeepPost(true);
    setPostName('');
    setPlan(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Everything the filter currently matches, in the Library's order. The
   * Library paginates in the renderer over the full filtered list, so this IS
   * the filter's result set — no second query that could disagree with it. */
  const selectionCount = productIds?.length ?? 0;
  const filterIds = products.map((p) => p.id);
  const chosenIds = scope === 'selection' ? (productIds ?? []) : filterIds;

  const template = templates.find((t) => t.id === templateId) || null;

  /* A plan is a count, not a render (socialGrid:plan calls the same selection
   * code the export does), so it is cheap enough to run on every change and the
   * footer can promise an exact number instead of "Apply". */
  useEffect(() => {
    if (!open || !template || chosenIds.length === 0) { setPlan(null); return undefined; }
    let cancelled = false;
    setPlanning(true);
    const handle = setTimeout(() => {
      // `plan(config)` — NOT plan({ config }). The preload helper already wraps
      // the argument, and double-wrapping made the count fall back to the
      // defaults ("all products"), so the modal promised a number that had
      // nothing to do with the selection. Caught by scripts/probe-ui-crawl.js,
      // which compares this count with what the export actually produced.
      window.api.socialGrid.plan({ ...template.config, source: 'picked', productIds: chosenIds })
        .then((res) => { if (!cancelled) setPlan(res); })
        .catch((err) => { if (!cancelled) addToast(err.message, 'error'); })
        .finally(() => { if (!cancelled) setPlanning(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(handle); };
    // `chosenIds` is rebuilt each render; keying on its length + first/last id
    // keeps the effect honest without firing on every unrelated re-render.
  }, [open, template, chosenIds.length, chosenIds[0], chosenIds[chosenIds.length - 1]]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handlePickFolder() {
    try {
      const f = await window.api.files.pickFolder();
      if (f) setFolder(f);
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function handleSubmit() {
    if (!template) { addToast('Pick a template first', 'error'); return; }
    if (!folder) { addToast('Pick a folder to save the images into', 'error'); return; }
    if (chosenIds.length === 0) { addToast('No products selected', 'info'); return; }
    setSubmitting(true);
    try {
      const config = { ...template.config, source: 'picked', productIds: chosenIds };
      const res = await window.api.socialGrid.exportImages(config, folder, null);
      const pages = res?.pageCount ?? res?.outputPaths?.length ?? 0;

      let postNote = '';
      if (keepPost) {
        try {
          const created = await window.api.socialGrid.create({
            companyId,
            name: (postName.trim() || `${template.name} — ${pages} image${pages === 1 ? '' : 's'}`),
            // The post keeps the products it was rendered from, so it opens in
            // the editor exactly as exported.
            config,
          });
          postNote = `, saved as the post “${created.name}”`;
        } catch (err) {
          // The images are on disk; say so rather than reporting the whole run
          // as failed.
          addToast(`Images saved, but the post could not be created: ${err.message}`, 'error');
        }
      }
      addToast(`Saved ${pages} image${pages === 1 ? '' : 's'} to ${folder}${postNote}`, 'success');
      onDone?.(res);
      onClose?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const willRender = plan?.productCount ?? chosenIds.length;
  const images = plan?.pageCount ?? 0;
  const usingSelection = scope === 'selection';

  return (
    <Modal open={open} title="Social Grid · apply template" onClose={onClose} size="md">
      <div className="bulk-overlay-run">
        <p className="bulk-overlay-run__intro">
          Turn products into a ready-to-post grid image. The template supplies the
          look; the products come from what you picked here. More products than fit
          on one image become a numbered series.
        </p>

        <Field label="Template" required>
          {({ id }) => (
            <Select id={id} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.length === 0 ? <option value="">— No templates yet —</option> : null}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.config.columns} × {t.config.rows} · {t.config.width} × {t.config.height}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {templates.length === 0 ? (
          <p className="bulk-overlay-run__empty">
            Create one first: Social Grid → open a post → <strong>Save as template</strong>.
          </p>
        ) : null}

        <fieldset className="bulk-overlay-run__group">
          <legend>Which products</legend>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="social-scope"
              checked={usingSelection}
              onChange={() => setScope('selection')}
              disabled={selectionCount === 0}
            />
            <span>
              <strong>Selected ({selectionCount})</strong>
              {selectionCount === 0 ? <span className="muted"> — none selected</span> : null}
            </span>
          </label>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="social-scope"
              checked={!usingSelection}
              onChange={() => setScope('filter')}
            />
            <span>
              <strong>Current Library filter ({filterIds.length})</strong>
              <span className="muted"> — everything the filters currently match</span>
            </span>
          </label>
        </fieldset>

        <div className="bulk-overlay-run__plan">
          {planning ? <span className="muted">Counting…</span> : plan ? (
            <>
              <strong>{willRender}</strong> product{willRender === 1 ? '' : 's'}
              {' → '}
              <strong>{images}</strong> image{images === 1 ? '' : 's'}
              {plan.perPage ? <span className="muted"> · {plan.perPage} per image · {plan.columns} × {plan.rows}</span> : null}
              {plan.sample?.length ? <span className="muted"> · e.g. {plan.sample.join(', ')}</span> : null}
            </>
          ) : <span className="muted">Nothing to count yet.</span>}
        </div>

        <Field label="Save images to" required>
          {() => (
            <div className="bulk-overlay-run__folder">
              <Button onClick={handlePickFolder} disabled={submitting}>Pick folder…</Button>
              <span className="bulk-overlay-run__folder-path">{folder || <em className="muted">(no folder picked)</em>}</span>
            </div>
          )}
        </Field>

        <label className="switch-row">
          <input type="checkbox" checked={keepPost} onChange={(e) => setKeepPost(e.target.checked)} />
          <span>Also keep it as a Social Grid post (opens in the editor later)</span>
        </label>
        {keepPost ? (
          <Field label="Post name">
            {({ id }) => (
              <Input
                id={id}
                value={postName}
                placeholder={template ? `${template.name} — ${images || '?'} image` : 'Post name'}
                onChange={(e) => setPostName(e.target.value)}
              />
            )}
          </Field>
        ) : null}

        <footer className="bulk-overlay-run__footer">
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            disabled={submitting || !template || !folder || willRender === 0}
            onClick={handleSubmit}
          >
            {submitting
              ? 'Rendering…'
              : `Render ${images || willRender} image${(images || willRender) === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
