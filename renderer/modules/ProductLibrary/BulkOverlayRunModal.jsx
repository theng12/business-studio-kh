/**
 * v0.26.15: BulkOverlayRunModal — Overlay Studio's "apply template
 * to many products" surface, mirrored from BulkProductsAIRunModal.
 *
 * Three scopes (radio):
 *   - "Selected (N)"        — uses the productIds the caller passed in
 *   - "Current filter (M)"  — uses the Library's live filter via a
 *                             dry-run lookup on the backend so the
 *                             user sees the matched count BEFORE
 *                             committing. Showing the count is the
 *                             safety guard for "oops, fired on 800
 *                             products instead of 8".
 *
 * Three destinations (radio):
 *   - Append as new image — keeps the original, adds render at end
 *   - Replace main         — appends then setMain (non-destructive,
 *                            original demotes to position 1)
 *   - Save to folder       — writes the render to a folder on disk,
 *                            doesn't touch the product
 *
 * v0.1.69: "Apply to which images" gained a third mode — Specific
 * positions. Tick 1 2 3 4 5 … (or type "2, 4", "2 4", "2-4"). The list
 * is 1-based with position 1 = the main image; products that lack a
 * requested position are skipped (not failed) and the toast reports the
 * reason ("no 4th image").
 *
 * Calls `window.api.templates.applyBulk` or `applyByFilter`
 * depending on scope. Sync — blocks the modal until done (sharp
 * compose is fast, ~100-300ms/render, so 50 products = ~10s).
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal, Button, Field, Select } from '../../components/ui.jsx';
import { useAppStore } from '../../store/index.js';

/* 0.1.94: the server refuses more than this many products in one run
 * (main/ipc/templates.js, applyBulk and applyByFilter). The modal says so and
 * disables Apply instead of letting the run fail after the click. */
export const OVERLAY_MAX_PRODUCTS = 1000;
// v0.1.69: the "which images" control is shared — every image operation in
// the Library should offer main / all / specific positions with the same
// skip-and-report behaviour. See ImageScopeField.jsx for the value shape.
import { ImageScopeField, imageScopeIsMulti, useImageScope } from './ImageScopeField.jsx';

/** Human summary of the skipped products, grouped by reason. */
function skipSummary(skipped) {
  const counts = new Map();
  for (const s of skipped || []) {
    const reason = s?.reason || 'skipped';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, n]) => `${n} product${n === 1 ? '' : 's'} skipped: ${reason}`)
    .join('; ');
}

export function BulkOverlayRunModal({ open, productIds, filters, onClose, onDone, initialTemplateId }) {
  const addToast = useAppStore((s) => s.addToast);
  const refreshProducts = useAppStore((s) => s.refreshProducts);
  const allProducts = useAppStore((s) => s.allProducts);

  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [scope, setScope] = useState('selection'); // 'selection' | 'filter'
  // v0.49.44: `appendAsMain` replaces `replaceMain` as the user-facing
  // choice for "render becomes main, original kept at position 1". The
  // backend accepts both kinds (alias), so any saved presets / older
  // sessions that hold `replaceMain` keep working.
  const [destination, setDestination] = useState('append'); // 'append' | 'appendAsMain' | 'overwrite' | 'saveToFolder'
  const [folder, setFolder] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // v0.49.52: which images of each product to overlay. 'main' = just the
  // main image (original behaviour); 'all' = every image of each product.
  // v0.1.69: the shared control adds 'positions' (1-based) and owns the
  // state; `imageChoice.value` is the { scope, positions } payload shape.
  const imageChoice = useImageScope();

  // When the user picks "Current filter", we ask the backend for
  // the match count via dryRun so the confirm button shows
  // "Apply to 47 products" rather than a vague "Apply".
  const [filterMatch, setFilterMatch] = useState(null); // { matchedCount, sampleSkus, maxImages } | null

  // v0.26.41 (audit pass): the dep array is intentionally `[open]`
  // only. Effect references `templateId` and `addToast` too, but:
  //   - `templateId` is local state we're about to reset; including
  //     it would cause the effect to re-fire when the user picks a
  //     different template, which would re-fetch the templates list
  //     and reset their scope choice — wrong behavior.
  //   - `addToast` is a stable zustand selector ref, but ESLint can't
  //     prove that; adding it has no functional cost but creates a
  //     misleading "the modal re-init depends on addToast" signal.
  // The disable is documented; the behavior we want is "reset state
  // whenever the modal opens, nothing else."
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Editor opens use their current template; Library opens keep their existing
    // remembered choice and first-template fallback.
    if (initialTemplateId) setTemplateId(initialTemplateId);
    window.api.templates.list().then((rows) => {
      if (cancelled) return;
      setTemplates(rows);
      if (rows.length > 0 && !templateId && !initialTemplateId) setTemplateId(rows[0].id);
    }).catch((err) => { if (!cancelled) addToast(err.message, 'error'); });
    setScope('selection');
    // 0.1.94: always start on Append — "Overwrite each image in place" is
    // destructive and must never carry over from the last run.
    setDestination('append');
    imageChoice.reset();
    setFilterMatch(null);
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dry-run lookup whenever the user picks "Current filter" so the
  // count is fresh. Also re-runs if the template changes (currently
  // the count doesn't depend on template but keeps the contract
  // honest if we ever filter eligibility per template).
  useEffect(() => {
    if (!open || scope !== 'filter' || !templateId) { setFilterMatch(null); return; }
    let cancelled = false;
    window.api.templates.applyByFilter({
      templateId,
      filters: filters ?? {},
      destination: { kind: 'append' }, // placeholder; ignored in dryRun
      dryRun: true,
    }).then((res) => { if (!cancelled) setFilterMatch(res); })
      .catch((err) => { if (!cancelled) addToast(err.message, 'error'); });
    return () => { cancelled = true; };
  }, [open, scope, templateId, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectionCount = productIds?.length ?? 0;
  const filterCount    = filterMatch?.matchedCount ?? 0;
  const finalCount     = scope === 'selection' ? selectionCount : filterCount;
  const overCap        = finalCount > OVERLAY_MAX_PRODUCTS;
  // Opened without a Library filter (Overlay Studio's own Apply), the
  // "filter" scope is the whole company.
  const filterScopeLabel = filters ? 'Current Library filter' : 'All products';

  /** Deepest gallery among the products this run will touch, so the ticks
   *  are sized to the real data. Selection uses the store's filter-agnostic
   *  `allProducts` (the Library's filtered page may be empty); filter mode
   *  uses the dry-run's maxImages. */
  const deepestGallery = useMemo(() => {
    if (scope === 'filter') return Number(filterMatch?.maxImages ?? 0);
    const wanted = new Set(productIds ?? []);
    let max = 0;
    for (const p of allProducts || []) {
      if (!wanted.has(p.id)) continue;
      max = Math.max(max, Number(p.imageCount ?? 0));
    }
    return max;
  }, [scope, filterMatch, allProducts, productIds]);

  // v0.1.69: the image-selection part of the IPC payload, straight from the
  // shared control's value shape ({ scope, positions }).
  const imageSelection = imageChoice.value;
  const multiImage = imageScopeIsMulti(imageSelection);
  const positionsMissing = imageSelection.scope === 'positions' && imageSelection.positions.length === 0;

  async function handlePickFolder() {
    try {
      const f = await window.api.files.pickFolder();
      if (f) setFolder(f);
    } catch (err) { addToast(err.message, 'error'); }
  }

  async function handleSubmit() {
    if (!templateId) { addToast('Pick a template first', 'error'); return; }
    if (destination === 'saveToFolder' && !folder) {
      addToast('Pick a folder to save into', 'error');
      return;
    }
    if (positionsMissing) {
      addToast('Pick at least one image position', 'info');
      return;
    }
    if (finalCount === 0) {
      addToast('No products match', 'info');
      return;
    }
    if (overCap) {
      addToast(`One run can apply to at most ${OVERLAY_MAX_PRODUCTS.toLocaleString()} products. Narrow the ${scope === 'selection' ? 'selection' : 'filter'}.`, 'info');
      return;
    }
    if (destination === 'overwrite') {
      // Loaded on demand: only this destination asks.
      const { confirm } = await import('../../components/ConfirmModal.jsx');
      const ok = await confirm({
        title: `Overwrite photos of ${finalCount} product${finalCount === 1 ? '' : 's'}?`,
        message: `The overlay is stamped into the image file${multiImage ? 's' : ''} themselves — the original${multiImage ? 's are' : ' is'} replaced, not kept.`,
        detail: 'This cannot be undone. Choose "Append as new image" instead to keep the originals.',
        danger: true,
        confirmLabel: `Overwrite ${finalCount}`,
      });
      if (!ok) return;
    }
    const dest = destination === 'saveToFolder'
      ? { kind: 'saveToFolder', folder }
      : { kind: destination };
    setSubmitting(true);
    try {
      let res;
      if (scope === 'selection') {
        res = await window.api.templates.applyBulk({
          templateId, productIds, destination: dest, ...imageSelection,
        });
      } else {
        res = await window.api.templates.applyByFilter({
          templateId, filters: filters ?? {}, destination: dest, ...imageSelection,
        });
      }
      if (res?.reconciled) {
        const products = res.summary?.productsCount ?? finalCount;
        const images = res.summary?.imagesCount ?? 0;
        const notCompleted = res.summary?.skippedCount ?? 0;
        const exceptions = notCompleted > 0 ? `, ${notCompleted} skipped or failed` : '';
        addToast(
          `Overlay completed on the server for ${products} product${products === 1 ? '' : 's'} ` +
            `(${images} image result${images === 1 ? '' : 's'}${exceptions}). Product data refreshed.`,
          notCompleted > 0 ? 'info' : 'success',
        );
      } else {
        const done = res?.done?.length ?? 0;
        const failed = res?.failed?.length ?? 0;
        const skipped = res?.skipped?.length ?? 0;
        const total = res?.total ?? finalCount;
        // Group done image results per product so the toast can say
        // "3 products (2 images each)" when every product got the same count.
        const perProduct = new Map();
        for (const d of res?.done ?? []) perProduct.set(d.productId, (perProduct.get(d.productId) || 0) + 1);
        const doneProducts = perProduct.size || done;
        const counts = [...new Set(perProduct.values())];
        const each = counts.length === 1 && counts[0] > 1 ? ` (${counts[0]} images each)` : '';
        const head = doneProducts === 0
          ? 'No products overlaid'
          : `Applied template to ${doneProducts} product${doneProducts === 1 ? '' : 's'}${each}`;
        if (failed + skipped === 0) {
          addToast(head, 'success');
        } else {
          const parts = [];
          if (skipped > 0) parts.push(skipSummary(res?.skipped) || `${skipped} skipped`);
          if (failed > 0) parts.push(`${failed} failed`);
          // Only spell out the attempted total when some product is neither
          // done, skipped nor failed (a shape the caller did not expect).
          const unaccounted = Math.max(0, total - doneProducts - skipped - failed);
          addToast(`${head}${unaccounted > 0 ? ` of ${total}` : ''} — ${parts.join('; ')}`, failed > 0 ? 'error' : 'info');
        }
      }
      // Refresh Library so new images are reflected in thumbs / counts.
      if (destination !== 'saveToFolder') refreshProducts();
      onDone?.(res);
      onClose?.();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <Modal open={open} title="Overlay Studio · apply template" onClose={onClose} busy={submitting}>
      <div className="bulk-overlay-run">
        <p className="bulk-overlay-run__intro">
          Render an Overlay Studio template against products and route the result.
          Source image used is each product&rsquo;s main image (processed wins over raw).
        </p>

        <Field label="Template" required>
          {({ id }) => (
            <Select id={id} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.length === 0 ? <option value="">— No templates available —</option> : null}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.canvasWidth ? ` · ${t.canvasWidth}×${t.canvasHeight}` : ''}</option>
              ))}
            </Select>
          )}
        </Field>

        <fieldset className="bulk-overlay-run__group">
          <legend>Scope</legend>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-scope"
              checked={scope === 'selection'}
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
              name="overlay-scope"
              checked={scope === 'filter'}
              onChange={() => setScope('filter')}
            />
            <span>
              <strong>{filterScopeLabel} ({filterCount})</strong>
              {filterMatch?.sampleSkus?.length ? (
                <span className="muted"> — e.g. {filterMatch.sampleSkus.join(', ')}{filterMatch.matchedCount > filterMatch.sampleSkus.length ? '…' : ''}</span>
              ) : null}
            </span>
          </label>
        </fieldset>

        {/* v0.49.52: which images of each product to overlay.
            v0.1.69: the shared ImageScopeField adds the positions mode; the
            same control is the wiring point for the other image operations. */}
        <ImageScopeField
          name="overlay-image-scope"
          value={imageSelection}
          onChange={imageChoice.set}
          galleryDepth={deepestGallery}
          disabled={submitting}
        />

        <fieldset className="bulk-overlay-run__group">
          <legend>Destination</legend>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-dest"
              checked={destination === 'append'}
              onChange={() => setDestination('append')}
            />
            <span>
              <strong>Append as new image{multiImage ? '(s)' : ''}</strong>
              <span className="muted"> — original images untouched, {multiImage ? 'an overlaid copy added per image' : 'render added to end'}</span>
            </span>
          </label>
          {/* v0.49.44: renamed from "Replace main" because that label
              sounded destructive. The behaviour was always to append
              the render then promote it to main, with the original
              kept at position 1 — nothing is deleted. New label says
              that plainly. Backend still accepts `replaceMain` as a
              kind alias for backward compat. */}
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-dest"
              checked={destination === 'appendAsMain' || destination === 'replaceMain'}
              onChange={() => setDestination('appendAsMain')}
            />
            <span>
              <strong>Append as main image</strong>
              <span className="muted"> — render becomes position 0 (the main), original demotes to position 1 (kept, not deleted)</span>
            </span>
          </label>
          {/* v0.49.52: stamp the overlay onto the image file itself. The
              natural choice when applying to all images (e.g. watermark
              every photo). Destructive — no undo. */}
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-dest"
              checked={destination === 'overwrite'}
              onChange={() => setDestination('overwrite')}
            />
            <span>
              <strong>Overwrite each image in place</strong>
              <span className="muted"> — stamp the overlay onto the image file{multiImage ? 's' : ''}. Destructive: replaces the original, no undo.</span>
            </span>
          </label>
          <label className="bulk-overlay-run__radio">
            <input
              type="radio"
              name="overlay-dest"
              checked={destination === 'saveToFolder'}
              onChange={() => setDestination('saveToFolder')}
            />
            <span>
              <strong>Save to folder only</strong>
              <span className="muted"> — write to disk, don&rsquo;t change the product&rsquo;s images</span>
            </span>
          </label>
          {destination === 'saveToFolder' ? (
            <div className="bulk-overlay-run__folder">
              <Button onClick={handlePickFolder} disabled={submitting}>Pick folder…</Button>
              <span className="bulk-overlay-run__folder-path">{folder || <em className="muted">(no folder picked)</em>}</span>
            </div>
          ) : null}
        </fieldset>

        {overCap ? (
          <p className="bulk-overlay-run__warn" role="status">
            {finalCount.toLocaleString()} products is more than one run can take (at most {OVERLAY_MAX_PRODUCTS.toLocaleString()}).
            Narrow the {scope === 'selection' ? 'selection' : 'filter'} and run it in parts.
          </p>
        ) : null}

        <footer className="bulk-overlay-run__footer">
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          <div style={{ flex: 1 }} />
          <Button
            variant="primary"
            disabled={submitting || !templateId || finalCount === 0 || overCap || positionsMissing || (destination === 'saveToFolder' && !folder)}
            onClick={handleSubmit}
          >
            {submitting
              ? 'Applying…'
              : `${destination === 'overwrite' ? 'Overwrite' : 'Apply to'} ${finalCount} product${finalCount === 1 ? '' : 's'}`}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

