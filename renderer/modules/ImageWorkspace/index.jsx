import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { PageHeader } from '../../components/PageHeader.jsx';
import { SaveStatus } from '../../components/SaveStatus.jsx';
import { Button, EmptyState } from '../../components/ui.jsx';
import { Lightbox } from '../../components/Lightbox.jsx';
import { ImageStrip } from './ImageStrip.jsx';
import { CanvasView } from './CanvasView.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { parseAspectRatio, reshapeCropRect } from './cropGeometry.js';
import { defaultSettings, mergeSettings } from '../../lib/workspaceSettings.js';
import { removeBackground } from '../../lib/bgRemoval.js';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { createLatestSaveQueue } from '../../lib/latestSaveQueue.js';
import { confirm } from '../../components/ConfirmModal.jsx';
import { parseConflictError, resolveSaveConflict } from '../../components/ConflictModal.jsx';
import { shortcutBlocked } from '../../components/ShortcutsModal.jsx';
import { ProductCombobox } from '../AIStudio/ProductCombobox.jsx';

export function ImageWorkspace() {
  const activeProductId = useAppStore((s) => s.activeProductId);
  /** Mirrors activeProductId so work started before a switch can tell whether
   *  the user is still looking at the product it belongs to. */
  const activeProductIdRef = useRef(null);
  activeProductIdRef.current = activeProductId;
  const sku = useAppStore((s) => s.workspaceProductSku);
  const productName = useAppStore((s) => s.workspaceProductName);
  const images = useAppStore((s) => s.workspaceImages);
  const activeIdx = useAppStore((s) => s.workspaceImageIndex);
  const loading = useAppStore((s) => s.workspaceLoading);
  const processing = useAppStore((s) => s.workspaceProcessing);
  const progress = useAppStore((s) => s.workspaceProgress);
  const fillPreview = useAppStore((s) => s.workspaceFillPreview);
  const viewMode = useAppStore((s) => s.workspaceViewMode);
  const divider = useAppStore((s) => s.workspaceDivider);
  const zoom = useAppStore((s) => s.workspaceZoom);
  const guides = useAppStore((s) => s.workspaceGuides);
  const setWorkspaceZoom = useAppStore((s) => s.setWorkspaceZoom);
  const toggleWorkspaceGuides = useAppStore((s) => s.toggleWorkspaceGuides);
  const loadWorkspaceForProduct = useAppStore((s) => s.loadWorkspaceForProduct);
  const setWorkspaceImageIndex = useAppStore((s) => s.setWorkspaceImageIndex);
  const setWorkspaceFillPreview = useAppStore((s) => s.setWorkspaceFillPreview);
  const setWorkspaceViewMode = useAppStore((s) => s.setWorkspaceViewMode);
  const setWorkspaceDivider = useAppStore((s) => s.setWorkspaceDivider);
  const setWorkspaceProcessing = useAppStore((s) => s.setWorkspaceProcessing);
  const refreshWorkspaceImages = useAppStore((s) => s.refreshWorkspaceImages);
  const bumpProcessedTick = useAppStore((s) => s.bumpProcessedTick);
  const processedTick = useAppStore((s) => s.workspaceProcessedTick);
  const addToast = useAppStore((s) => s.addToast);
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  // v0.49.33: appConfig + refreshAppConfig were used to read/refresh
  // the bg-removal engine picker; both are gone now that there's only
  // one engine.
  // Product list + jump action used by the in-workspace product picker so
  // the user can move between products without bouncing back to Library.
  // 0.1.94: the full company list (lookup + the picker) and the frozen order
  // the Library handed over — see workspaceNavList below.
  const allProducts = useAppStore((s) => s.allProducts);
  const workspaceNavIds = useAppStore((s) => s.workspaceNavIds);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const openProductInWorkspace = useAppStore((s) => s.openProductInWorkspace);
  const frozenNavRef = useRef(null);
  const navProducts = useMemo(
    () => workspaceNavList({ navIds: workspaceNavIds, allProducts, activeProductId, companyId: activeCompanyId, frozen: frozenNavRef }),
    [workspaceNavIds, allProducts, activeProductId, activeCompanyId],
  );

  const [settings, setSettings] = useState(defaultSettings());
  const [processingLabel, setProcessingLabel] = useState(null);
  const [cropMode, setCropMode] = useState(false);
  const [cropPreviewState, setCropPreviewState] = useState(null);
  const [cropFrameReadyUrl, setCropFrameReadyUrl] = useState(null);
  // Lightbox state for previewing strip thumbnails. v0.26.8 — matches the
  // Product Library's "click a thumb to preview" UX. The strip's primary
  // click still SELECTS the image as the active workspace target; preview
  // is the secondary action (magnifier button or double-click).
  const [lightbox, setLightbox] = useState({ open: false, idx: 0 });
  // Auto-save status per AGENTS.md §6: every change persists via IPC on a
  // debounce, and the header's SaveStatus shows this state ('idle' | 'saving'
  // | 'saved' | 'error') beside the explicit Save button (handleSaveNow).
  const [saveStatus, setSaveStatus] = useState({ state: 'idle', lastSavedAt: null });
  // Debounce settings writes so a slider drag doesn't fire 50 IPC calls.
  // The actual latest drafts live in per-image editor contexts below so a
  // switch cannot separate a dirty key from the settings it represents.
  const saveDebounceRef = useRef(null);
  const editorContextsRef = useRef(new Map());
  const activeEditorKeyRef = useRef(null);
  const activeEditorGenerationRef = useRef(0);
  const flushPendingSaveRef = useRef(null);
  const workspaceImagesRef = useRef(images);
  const processingRunRef = useRef(false);
  const cropRunEditorKeyRef = useRef(null);
  const mountedRef = useRef(true);
  workspaceImagesRef.current = images;
  useEffect(() => {
    // React StrictMode runs effect cleanup/setup once during development;
    // reset this flag on setup so a remounted effect can still report state.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function handleCropChange(rect) {
    if (cropApplying && cropRunEditorKeyRef.current === activeEditorKeyRef.current) return;
    setSettings((s) => ({ ...s, sourceCropRect: rect, ...(!cropMode && !rect ? { cropRect: null } : {}) }));
  }
  function toggleCropMode() {
    if (cropApplying && cropRunEditorKeyRef.current === activeEditorKeyRef.current) return;
    setCropPreviewState(null);
    setCropMode((v) => !v);
  }
  // v0.49.15: aspect-ratio picker.
  // - 'free'              → no constraint
  // - '1:1' / '4:3' / ... → standard preset
  // - 'custom'            → opens the W:H input row (no constraint until typed)
  // - 'custom-3:2' / etc. → user-confirmed custom ratio
  // When the ratio changes AND a rect exists, re-shape it (keep center) so
  // the user sees their work re-proportioned instead of disappearing.
  function handleCropAspectChange(id) {
    if (cropApplying && cropRunEditorKeyRef.current === activeEditorKeyRef.current) return;
    // v0.49.16: the slider piggybacks on this channel via a `__straighten:N`
    // sentinel so we don\'t have to add yet another prop. Match it first;
    // anything else is a real aspect-ratio change.
    if (typeof id === 'string' && id.startsWith('__straighten:')) {
      const v = Number(id.slice('__straighten:'.length)) || 0;
      const clamped = Math.max(-45, Math.min(45, v));
      setSettings((s) => ({ ...s, cropStraighten: clamped }));
      return;
    }
    setSettings((s) => {
      const next = { ...s, cropAspectRatio: id };
      if (!s.sourceCropRect) return next;
      const ratio = parseAspectRatio(id);
      if (!ratio || !cropPreview) return next;
      return { ...next, sourceCropRect: reshapeCropRect(s.sourceCropRect, ratio, cropPreview.outW, cropPreview.outH) };
    });
  }
  function handleCancelCrop() {
    if (cropApplying && cropRunEditorKeyRef.current === activeEditorKeyRef.current) return;
    setSettings((s) => ({ ...s, sourceCropRect: null, cropStraighten: 0 }));
    setCropMode(false);
  }
  // v0.49.15: commit the crop via `images:cropImage`. Two destinations:
  // - 'newImage'  → appends a cropped copy as a new product image (default)
  // - 'overwrite' → writes back to the source file (destructive, confirms)
  const [cropApplying, setCropApplying] = useState(false);
  async function handleApplyCrop(destination) {
    if (!activeImage || !activeProductId || !settings.sourceCropRect || processing || processingRunRef.current) return;
    if (!cropMode || !cropPreview || cropFrameReadyUrl !== cropPreview.url) return;
    const image = activeImage;
    const productId = activeProductId;
    const context = ensureEditorContext(image, productId);
    const generation = activeEditorGenerationRef.current;
    const cropSettings = settings;
    if (destination === 'overwrite') {
      // Owner 2026-11-13: native window.confirm is a silent no-op in the
      // packaged webview; this is the in-app dialog.
      const ok = await confirm({
        title: 'Overwrite the source image?',
        message: 'This rewrites the original file on disk. There is no undo.',
        confirmLabel: 'Overwrite',
        danger: true,
      });
      if (!ok) return;
    }
    processingRunRef.current = true;
    cropRunEditorKeyRef.current = activeEditorKeyRef.current;
    setCropApplying(true);
    try {
      if (destination === 'overwrite') {
        /* Overwriting rewrites the source bytes and changes the content hash,
         * which orphans the current editor identity. Flush any pending settings
         * draft first — the same reason handleFlipActive flushes before it
         * flips. Without this, a slider changed inside the 500 ms debounce
         * window before "Apply crop → overwrite" was stranded in latestDraft
         * and never written. */
        if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
        try {
          await flushContext(context);
        } catch (err) {
          // A conflict has no queue toast of its own; translate it rather than
          // leaking the raw CONFLICT| sentinel.
          addToast(parseConflictError(err)
            ? 'This image changed elsewhere. Use Save to refresh or overwrite before cropping — the crop was not applied.'
            : `Save failed: ${err.message} — the crop was not applied.`, 'error');
          return;
        }
      }
      if (!isCurrentContext(context, generation)) return;
      const res = await window.api.images.cropImage({
        productId,
        filepath: image.filepath,
        imageId: image.id,
        expectedContentHash: image.contentHash,
        rect: cropSettings.sourceCropRect,
        rotation: Number(cropSettings.rotation || 0),
        // v0.49.16: pre-extract rotation. Server applies sharp.rotate(straighten,
        // {background: white}) before resolving the rect against the rotated
        // bbox. Zero = skip (one less sharp pass).
        straighten: Number(cropSettings.cropStraighten || 0),
        destination,
      });
      // Successful commit — clear the rect + straighten, exit crop mode, refresh.
      if (!isCurrentContext(context, generation)) return;
      setSettings((s) => ({ ...s, sourceCropRect: null, cropStraighten: 0, ...(destination === 'overwrite' ? { rotation: 0 } : {}) }));
      setCropMode(false);
      if (destination === 'overwrite') editorContextsRef.current.delete(context.identity);
      if (destination === 'overwrite') {
        addToast(`Cropped to ${res.outW}×${res.outH}px (source overwritten)`, 'success');
      } else if (res?.skipped) {
        addToast('Crop produced an identical image — no duplicate added', 'info');
      } else {
        addToast(`Cropped to ${res.outW}×${res.outH}px (added as new image)`, 'success');
      }
      // The pixels are committed already. A failed view refresh must never
      // invite retrying an overwrite against the newly cropped source.
      try {
        await refreshWorkspaceImages(productId);
        if (activeProductIdRef.current !== productId) return;
        bumpProcessedTick();
        await useAppStore.getState().refreshProducts();
      } catch (err) {
        if (mountedRef.current && activeProductIdRef.current === productId) addToast(`Cropped, but the image list did not refresh: ${err.message}`, 'error');
      }
    } catch (err) {
      addToast(`Crop failed: ${err.message}`, 'error');
    } finally {
      processingRunRef.current = false;
      cropRunEditorKeyRef.current = null;
      if (mountedRef.current) setCropApplying(false);
    }
  }

  // Load product images on activeProductId change.
  useEffect(() => {
    if (activeProductId) loadWorkspaceForProduct(activeProductId);
  }, [activeProductId, loadWorkspaceForProduct]);

  /* Identifies an image as "the same picture we were just looking at".
   *
   * v0.1.29: the filepath ALONE is not enough. Product image files are
   * renumbered positionally, so a delete or reorder elsewhere can put a
   * DIFFERENT picture behind the same path — the workspace would then keep the
   * previous image's crop and rotation on screen, and the next Save would write
   * those settings onto the wrong record. The content hash changes when the
   * bytes do, and the row id is a stable last resort.
   *
   * Note this is deliberately NOT the whole `activeImage` object: that
   * reference changes after every save, and using it as a dependency would loop
   * (save → store update → new object → re-seed → save again). */
  const imageIdentity = (img) => (img ? `${img.id}::${img.contentHash ?? ''}` : null);

  // When the active image changes, seed settings from its stored workspace_settings.
  const activeImage = images[activeIdx] ?? null;
  const activeImageRef = useRef(activeImage);
  activeImageRef.current = activeImage;
  const activeImageFilepath = activeImage?.filepath ?? null;
  const activeImageContentHash = activeImage?.contentHash ?? null;
  const activeImageId = activeImage?.id ?? null;
  const activeImageWorkspaceRevision = activeImage?.workspaceRevision ?? 0;
  const activeEditorKey = activeProductId && activeImage
    ? `${activeProductId}::${imageIdentity(activeImage)}`
    : null;
  if (activeEditorKeyRef.current !== activeEditorKey) {
    activeEditorKeyRef.current = activeEditorKey;
    activeEditorGenerationRef.current += 1;
  }

  const cropPreviewKey = `${activeEditorKey}::${activeEditorGenerationRef.current}::${settings.rotation || 0}::${settings.cropStraighten || 0}`;
  const cropPreview = cropMode && cropPreviewState?.key === cropPreviewKey ? cropPreviewState : null;
  useEffect(() => {
    if (!cropMode || !activeImage) return undefined;
    const context = ensureEditorContext(activeImage, activeProductId);
    const generation = activeEditorGenerationRef.current;
    let cancelled = false, url = null;
    const timer = setTimeout(async () => {
      try {
        const result = await window.api.images.cropPreview({
          productId: activeProductId, filepath: activeImage.filepath,
          imageId: activeImage.id, expectedContentHash: activeImage.contentHash,
          rotation: Number(settings.rotation || 0), straighten: Number(settings.cropStraighten || 0),
          previewMaxEdge: 1024,
          rect: { x: 0, y: 0, width: 1, height: 1 },
        });
        if (cancelled || !isCurrentContext(context, generation)) return;
        url = URL.createObjectURL(new Blob([result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes)], { type: 'image/png' }));
        setCropPreviewState({ key: cropPreviewKey, url, outW: result.outW, outH: result.outH });
        setSettings((s) => {
          const ratio = parseAspectRatio(s.cropAspectRatio);
          return ratio ? { ...s, sourceCropRect: reshapeCropRect(s.sourceCropRect, ratio, result.outW, result.outH) } : s;
        });
      } catch (err) {
        if (!cancelled && isCurrentContext(context, generation)) addToast(`Crop preview failed: ${err.message}`, 'error');
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
    // Context identity/generation and transforms fully identify these pixels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropMode, cropPreviewKey]);

  function findWorkspaceImage(result, imageId) {
    return (Array.isArray(result) ? result : result?.images ?? [])
      .find((image) => image.id === imageId) ?? null;
  }

  function isCurrentContext(context, generation = activeEditorGenerationRef.current) {
    return mountedRef.current
      && generation === activeEditorGenerationRef.current
      && activeProductIdRef.current === context.productId
      && imageIdentity(activeImageRef.current) === context.identity;
  }

  function acknowledgeContext(context, row) {
    const revision = row?.workspaceRevision ?? 0;
    if (!row || revision < context.acknowledgedRevision) return false;
    context.acknowledgedRevision = revision;
    context.acknowledgedSettings = mergeSettings(row.workspaceSettings);
    context.acknowledgedKey = `${context.identity}::${JSON.stringify(context.acknowledgedSettings)}`;
    context.lastSavedAt = Date.now();
    context.queue?.setRevision(revision);
    return true;
  }

  function ensureEditorContext(image, productId = activeProductIdRef.current) {
    const identity = imageIdentity(image);
    let context = editorContextsRef.current.get(identity);
    if (context) return context;
    const acknowledgedSettings = mergeSettings(image.workspaceSettings);
    context = {
      identity,
      productId,
      imageId: image.id,
      expectedContentHash: image.contentHash ?? null,
      acknowledgedRevision: image.workspaceRevision ?? 0,
      acknowledgedSettings,
      acknowledgedKey: `${identity}::${JSON.stringify(acknowledgedSettings)}`,
      lastSavedAt: image.workspaceSettings ? Date.now() : null,
      latestDraft: null,
      dirty: false,
      queue: null,
    };
    editorContextsRef.current.set(identity, context);
    return context;
  }

  function ensureSaveQueue(context) {
    if (context.queue) return context.queue;
    context.queue = createLatestSaveQueue({
      initialRevision: context.acknowledgedRevision,
      persist: async (draft, expectedWorkspaceRevision) => {
        const result = await window.api.workspace.saveSettings(
          draft.productId,
          draft.imageId,
          draft.expectedContentHash,
          draft.settings,
          expectedWorkspaceRevision,
        );
        const row = findWorkspaceImage(result, draft.imageId);
        if (!row) throw new Error('Saved image is no longer attached to this product');
        return { ...row, updatedAt: row.workspaceRevision ?? 0 };
      },
      onStart: () => {
        if (isCurrentContext(context)) setSaveStatus((status) => ({ ...status, state: 'saving' }));
      },
      onSuccess: (row, draft) => {
        acknowledgeContext(context, row);
        if (context.latestDraft !== draft) return;
        context.latestDraft = null;
        context.dirty = false;
        if (isCurrentContext(context)) {
          setSaveStatus({ state: 'saved', lastSavedAt: context.lastSavedAt });
        }
      },
      onError: (error) => {
        // Autosave and navigation flushes retain the draft but never open a
        // conflict dialog. Only the explicit Save action offers choices.
        context.dirty = !!context.latestDraft;
        if (!isCurrentContext(context)) return;
        setSaveStatus({ state: 'error', lastSavedAt: null });
        if (!parseConflictError(error)) addToast(`Save failed: ${error.message}`, 'error');
      },
    });
    return context.queue;
  }

  function setLatestDraft(context, nextSettings) {
    const draft = {
      productId: context.productId,
      imageId: context.imageId,
      expectedContentHash: context.expectedContentHash,
      settings: nextSettings,
      key: `${context.identity}::${JSON.stringify(nextSettings)}`,
      identity: context.identity,
    };
    context.latestDraft = draft;
    context.dirty = true;
    return draft;
  }

  function enqueueDirtyContext(context) {
    if (context?.dirty && context.latestDraft) ensureSaveQueue(context).enqueue(context.latestDraft);
  }

  function flushContext(context) {
    if (!context?.dirty && !context?.queue?.hasPending()) return Promise.resolve();
    return ensureSaveQueue(context).flush(() => context.dirty ? context.latestDraft : null);
  }

  async function flushPendingSave() {
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = null;
    const productId = activeProductIdRef.current;
    const reachableIdentities = new Set(workspaceImagesRef.current.map(imageIdentity));
    for (const context of editorContextsRef.current.values()) {
      if (context.productId !== productId || !reachableIdentities.has(context.identity)) continue;
      await flushContext(context);
    }
  }
  flushPendingSaveRef.current = flushPendingSave;

  const seededIdentityRef = useRef(null);
  const displayedIdentityRef = useRef(null);
  useEffect(() => {
    const image = activeImageRef.current;
    if (!image) return;
    const identity = imageIdentity(image);
    const context = ensureEditorContext(image, activeProductIdRef.current);
    const enteringIdentity = displayedIdentityRef.current !== identity;
    displayedIdentityRef.current = identity;
    // A remote refresh repaints an idle editor only when it is not older than
    // our last ACK. Dirty editors keep both the draft and its original base.
    if (context.dirty) {
      if (!enteringIdentity) return;
      seededIdentityRef.current = identity;
      setSettings(context.latestDraft.settings);
      // A write is scheduled for the restored draft, so 'saving' is accurate
      // here; if that retry fails the queue's onError downgrades this to
      // 'error' and the explicit Save / conflict recovery becomes available.
      setSaveStatus((status) => ({ ...status, state: 'saving' }));
      return;
    }
    if ((image.workspaceRevision ?? 0) >= context.acknowledgedRevision) {
      acknowledgeContext(context, image);
    }
    if (settings === context.acknowledgedSettings) {
      seededIdentityRef.current = null;
    } else {
      seededIdentityRef.current = identity;
      setSettings(context.acknowledgedSettings);
    }
    setSaveStatus({ state: 'idle', lastSavedAt: context.lastSavedAt });
    // Re-seed when the user navigates to a different image file, or when the
    // SAME path now holds different bytes (a renumber from another Mac).
    // `settings` and the ref-only helper are intentionally not triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeImageFilepath, activeImageContentHash, activeImageId, activeImageWorkspaceRevision]);

  // Auto-save: 500ms debounce after the last settings change. We compare a
  // serialised key per (image, settings) tuple to skip writes when nothing
  // actually differs from the last saved state (e.g. flip-and-flip-back).
  useEffect(() => {
    const image = activeImageRef.current;
    if (!image || !activeProductId) return undefined;
    const identity = imageIdentity(image);
    // The seed effect above runs before this effect when the image changes.
    // The settings value here is still for the previous image in that render;
    // never queue it against the newly selected image.
    if (seededIdentityRef.current === identity) {
      seededIdentityRef.current = null;
      return undefined;
    }
    const context = ensureEditorContext(image, activeProductId);
    const key = `${identity}::${JSON.stringify(settings)}`;
    if (!context.dirty && key === context.acknowledgedKey) return undefined;

    setSaveStatus((s) => ({ ...s, state: 'saving' }));
    const draft = setLatestDraft(context, settings);
    const handle = setTimeout(() => {
      saveDebounceRef.current = null;
      if (context.latestDraft === draft) enqueueDirtyContext(context);
    }, 500);
    saveDebounceRef.current = handle;
    return () => clearTimeout(handle);
    // Ref-only helpers are intentionally stable outside this debounce key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, activeImageFilepath, activeImageContentHash, activeImageId, activeProductId]);

  useEffect(() => registerCompanySwitchFlusher(() => flushPendingSaveRef.current()), []);

  /* Flush ONLY when the image or product being edited changes, or on unmount.
   *
   * Deliberately keyed on identity, not on `settings`: a settings change must
   * keep debouncing (clear + reschedule), which is what the effect above does.
   * When identity changes, though, the pending write belongs to the PREVIOUS
   * image and is still valid — so it is sent rather than cancelled. Splitting
   * the two concerns is what makes both behaviours correct. */
  useEffect(() => () => {
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = null;
    enqueueDirtyContext(editorContextsRef.current.get(imageIdentity(activeImage)));
    // Flush on immutable identity changes, not row-object refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeImageFilepath, activeImageContentHash, activeImageId, activeProductId]);

  // Compute a renderer-side watermark URL if one is set.
  const watermarkSrc = settings.watermark?.relativePath
    ? `app-image://local/${encodeURIComponent(settings.watermark.relativePath)}`
    : null;

  async function handleUploadWatermark() {
    try {
      const filePath = await window.api.files.pickImageFile();
      if (!filePath) return;
      const { relativePath } = await window.api.watermarks.upload(filePath);
      setSettings((s) => ({ ...s, watermark: { ...s.watermark, relativePath } }));
      addToast('Watermark uploaded', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
  }

  async function processOne(image, runSettings, expectedWorkspaceRevision, runProductId) {
    /* v0.1.29: pin the product this run belongs to.
     *
     * `activeProductId` is read again after the awaits below, and it is a
     * closure value — if the user switched product in the meantime, the refresh
     * would load the NEW product's images while the completed work belonged to
     * the old one, leaving the strip showing one product under another's
     * header. Capturing it once, and skipping the repaint when it no longer
     * matches, keeps the screen consistent. (The product switcher is also
     * disabled while a run is in flight; this is the belt to that braces.) */
    if (!image.contentHash) {
      throw new Error('Image identity unavailable; re-import the image and try again');
    }
    let foregroundBytes = null;
    if (runSettings.removeBackground) {
      // v0.49.33: only one engine remains — the bundled local @imgly
      // WASM. The remove.bg cloud path (and its upload/download progress
      // states) were removed.
      const { bytes, sourceHash } = await removeBackground(
        image.filepath,
        (stage, ratio) => {
          if (stage.startsWith('fetch:')) {
            setProcessingLabel(`Downloading bg-removal model… ${Math.round(ratio * 100)}%`);
          } else {
            setProcessingLabel(`Removing background… ${Math.round(ratio * 100)}%`);
          }
        },
        // v0.1.27: stamp the cutout cache so a flipped/cropped image
        // (same path, new bytes) cannot reuse the previous cutout.
        image.contentHash,
        {
          validateSource: async () => {
            const current = (await window.api.images.listByProduct(runProductId))
              .find((candidate) => candidate.id === image.id);
            if (!current || current.filepath !== image.filepath || current.contentHash !== image.contentHash) {
              throw new Error('Image changed; reload and try again');
            }
          },
        },
      );
      foregroundBytes = { bytes, sourceHash };
    }
    setProcessingLabel('Compositing…');
    const context = ensureEditorContext(image, runProductId);
    let res;
    try {
      res = await window.api.workspace.processImage(
        runProductId,
        image.id,
        image.contentHash ?? null,
        runSettings,
        foregroundBytes,
        expectedWorkspaceRevision,
      );
    } catch (error) {
      // A process conflict did not dirty the save queue, but the explicit Save
      // button must still be able to reopen the normal recovery choices.
      if (parseConflictError(error) && isCurrentContext(context)) {
        setSaveStatus({ state: 'error', lastSavedAt: null });
      }
      throw error;
    }
    const row = findWorkspaceImage(res, image.id);
    if (row) acknowledgeContext(context, row);
    // Only repaint if we are still looking at the product this run was for.
    if (activeProductIdRef.current === runProductId) {
      try {
        await refreshWorkspaceImages(runProductId);
        if (activeProductIdRef.current === runProductId) bumpProcessedTick();
      } catch (refreshError) {
        // The DB write and output attachment already succeeded, so a failed
        // list refresh must not be reported as a failed process.
        addToast(`Processed, but the image list did not refresh: ${refreshError.message}`, 'error');
      }
    }
    return res;
  }

  /**
   * Explicit Save: persist current settings *now*, bypassing the 500ms
   * debounce. Cancels the pending auto-save timer so we don't fire twice.
   * Idempotent — if no changes since last save, no IPC call is made.
   * Per AGENTS.md §6 (updated 2026-05-20): editors keep an explicit Save
   * button as the user's deliberate-commit affordance, on top of the
   * automatic debounced save.
   */
  async function handleSaveNow() {
    if (!activeImage || !activeProductId) return;
    const image = activeImage;
    const productId = activeProductId;
    const identity = imageIdentity(image);
    const key = `${identity}::${JSON.stringify(settings)}`;
    const context = ensureEditorContext(image, productId);
    if (!context.dirty && key === context.acknowledgedKey && saveStatus.state !== 'error') {
      // Already saved — give a friendly nudge so the click doesn't feel
      // ignored.
      addToast('Already saved', 'info');
      return true;
    }
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = null;
    if (!context.dirty || context.latestDraft?.key !== key) setLatestDraft(context, settings);
    const generation = activeEditorGenerationRef.current;
    setSaveStatus((s) => ({ ...s, state: 'saving' }));
    try {
      await flushContext(context);
      if (isCurrentContext(context, generation)) addToast('Saved', 'success');
      return true;
    } catch (err) {
      if (!isCurrentContext(context, generation)) return false;
      if (!parseConflictError(err)) return false;
      let overwrittenDraft = null;
      try {
        const result = await resolveSaveConflict(err, {
          refresh: async () => {
            if (!isCurrentContext(context, generation)) throw new Error('Editor changed before conflict resolution');
            const rows = await window.api.images.listByProduct(productId);
            const row = findWorkspaceImage(rows, context.imageId);
            if (!row || imageIdentity(row) !== identity) throw new Error('Image changed; reload and try again');
            return row;
          },
          overwrite: async () => {
            if (!isCurrentContext(context, generation)) throw new Error('Editor changed before conflict resolution');
            overwrittenDraft = context.latestDraft;
            if (!overwrittenDraft) throw new Error('No draft remains to overwrite');
            const rows = await window.api.workspace.saveSettings(
              productId,
              context.imageId,
              context.expectedContentHash,
              overwrittenDraft.settings,
            );
            const row = findWorkspaceImage(rows, context.imageId);
            if (!row) throw new Error('Saved image is no longer attached to this product');
            return row;
          },
        });
        if (!isCurrentContext(context, generation)) return false;
        if (result.choice === 'cancel') {
          setSaveStatus({ state: 'error', lastSavedAt: null });
          return false;
        }
        acknowledgeContext(context, result.row);
        if (result.choice === 'refresh') {
          context.latestDraft = null;
          context.dirty = false;
          seededIdentityRef.current = identity;
          setSettings(context.acknowledgedSettings);
          setSaveStatus({ state: 'saved', lastSavedAt: context.lastSavedAt });
        } else if (context.latestDraft === overwrittenDraft) {
          context.latestDraft = null;
          context.dirty = false;
          setSaveStatus({ state: 'saved', lastSavedAt: context.lastSavedAt });
        } else {
          await flushContext(context);
        }
        addToast('Saved', 'success');
        return true;
      } catch (nextError) {
        context.dirty = !!context.latestDraft;
        if (!isCurrentContext(context, generation)) return false;
        setSaveStatus({ state: 'error', lastSavedAt: null });
        addToast(`Save failed: ${nextError.message}`, 'error');
        return false;
      }
    }
  }

  async function handleApplyThis() {
    if (!activeImage || processing || processingRunRef.current || cropApplying) return false;
    const image = activeImage;
    const productId = activeProductId;
    processingRunRef.current = true;
    setWorkspaceProcessing(true);
    try {
      const context = ensureEditorContext(image, productId);
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
      await flushContext(context);
      await processOne(
        image,
        context.acknowledgedSettings,
        context.acknowledgedRevision,
        productId,
      );
      // Refresh the products list so the table reflects the new process status.
      useAppStore.getState().refreshProducts();
      addToast('Image processed', 'success');
      return true;
    } catch (err) {
      // A process conflict is not a failure — the image changed elsewhere.
      // Do not show the raw CONFLICT| sentinel; point at the Save recovery.
      if (parseConflictError(err)) {
        addToast('This image changed while processing. Use Save to refresh or overwrite, then process again.', 'error');
      } else {
        addToast(err.message, 'error');
      }
      return false;
    } finally {
      setProcessingLabel(null);
      setWorkspaceProcessing(false);
      processingRunRef.current = false;
    }
  }

  async function handleApplyAll() {
    if (images.length === 0 || processing || processingRunRef.current || cropApplying) return false;
    const runProductId = activeProductId;
    const runImages = [...images];
    processingRunRef.current = true;
    setWorkspaceProcessing(true, { current: 0, total: runImages.length });
    try {
      try {
        await flushPendingSave();
      } catch (err) {
        addToast(`Save failed: ${err.message}`, 'error');
        return false;
      }
      const sourceContext = ensureEditorContext(activeImage ?? runImages[0], runProductId);
      const batchSettings = sourceContext.acknowledgedSettings;
      let failures = 0;
      let conflicts = 0;
      for (let i = 0; i < runImages.length; i++) {
        const img = runImages[i];
        const context = ensureEditorContext(img, runProductId);
        setWorkspaceProcessing(true, { current: i, total: runImages.length });
        setProcessingLabel(`Processing ${i + 1} of ${runImages.length}…`);
        try {
          await flushContext(context);
          await processOne(
            img,
            batchSettings,
            context.acknowledgedRevision,
            runProductId,
          );
        } catch (err) {
          // A conflict means another editor changed this image, not that the
          // run failed — report it separately so the user knows to refresh.
          if (parseConflictError(err)) conflicts += 1;
          else failures += 1;
          // Continue with the rest, but record the issue.
          console.warn(`Failed to process ${img.filename}:`, err);
        }
      }
      useAppStore.getState().refreshProducts();
      const processed = runImages.length - failures - conflicts;
      if (failures === 0 && conflicts === 0) {
        addToast(`Processed ${runImages.length} image${runImages.length === 1 ? '' : 's'}`, 'success');
      } else {
        const parts = [];
        if (processed > 0) parts.push(`${processed} processed`);
        if (conflicts > 0) parts.push(`${conflicts} changed elsewhere (save or refresh, then retry)`);
        if (failures > 0) parts.push(`${failures} failed`);
        addToast(parts.join(', '), processed === 0 ? 'error' : 'info');
      }
      return failures === 0 && conflicts === 0;
    } finally {
      setProcessingLabel(null);
      setWorkspaceProcessing(false, null);
      processingRunRef.current = false;
    }
  }

  // v0.26.14: destructive flip of the active source image. Same IPC
  // the Library Lightbox uses. After it returns we refresh the
  // workspace image list + bump the processed-tick so the strip
  // thumb + canvas re-fetch with the new content hash. Errors land
  // in a toast rather than alert() since we have toast plumbing here.
  async function handleFlipActive(axis) {
    if (!activeImage || !activeProductId || processing || processingRunRef.current) return false;
    const image = activeImage;
    const productId = activeProductId;
    const context = ensureEditorContext(image, productId);
    const generation = activeEditorGenerationRef.current;
    processingRunRef.current = true;
    setWorkspaceProcessing(true);
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = null;
    try {
      try {
        await flushContext(context);
      } catch (_) {
        return false;
      }
      if (!isCurrentContext(context, generation)) return false;
      await window.api.images.flipSource(productId, image.filepath, axis);
      if (!isCurrentContext(context, generation)) return false;
      await refreshWorkspaceImages(productId);
      editorContextsRef.current.delete(context.identity);
      if (activeProductIdRef.current !== productId) return false;
      bumpProcessedTick();
      addToast(`Flipped ${axis === 'h' ? 'horizontally' : 'vertically'}`, 'success');
      return true;
    } catch (err) {
      addToast(`Flip failed: ${err.message}`, 'error');
      return false;
    } finally {
      setWorkspaceProcessing(false);
      processingRunRef.current = false;
    }
  }

  async function handleSelectImage(index) {
    const targetId = images[index]?.id;
    if (!targetId) return false;
    if (index === activeIdx) {
      setWorkspaceViewMode('single');
      return true;
    }
    const productId = activeProductId;
    const identity = imageIdentity(activeImage);
    /* Only the image being left can strand the user's on-screen edit, so only
     * that context blocks the switch. Other dirty contexts are retained in
     * memory and retried on a later flush; letting one of them lock the whole
     * strip (a save that keeps failing elsewhere) was the defect. */
    const leavingContext = activeImage ? ensureEditorContext(activeImage, productId) : null;
    if (leavingContext) {
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
      try {
        await flushContext(leavingContext);
      } catch (err) {
        // The queue's onError already surfaced a non-conflict failure for the
        // current context; a conflict is silent there, so name it here.
        if (parseConflictError(err)) {
          addToast('This image changed elsewhere. Use Save to refresh or overwrite before leaving it.', 'error');
        }
        return false;
      }
    }
    const reachable = new Set(workspaceImagesRef.current.map(imageIdentity));
    for (const context of editorContextsRef.current.values()) {
      if (context === leavingContext) continue;
      if (context.productId !== productId || !reachable.has(context.identity)) continue;
      // Best-effort: keep the draft, do not block this switch.
      flushContext(context).catch(() => {});
    }
    if (activeProductIdRef.current !== productId || imageIdentity(activeImageRef.current) !== identity) return false;
    const currentIndex = useAppStore.getState().workspaceImages.findIndex((image) => image.id === targetId);
    if (currentIndex < 0) return false;
    setWorkspaceImageIndex(currentIndex);
    setWorkspaceViewMode('single');
    return true;
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || shortcutBlocked(e.target, document)
        || e.target?.closest?.('input, select, [role="slider"], [role="radio"], [role="radiogroup"]')
        || loading || processing || processingRunRef.current || cropApplying || !activeProductId || !images.length) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (cropMode) return;
        const index = activeIdx + (e.key === 'ArrowLeft' ? -1 : 1);
        if (index < 0 || index >= images.length) return;
        e.preventDefault();
        if (!e.repeat) void handleSelectImage(index);
      } else if (e.key === '+' || e.key === '=' || e.key === '-') {
        e.preventDefault();
        setWorkspaceZoom(zoom + (e.key === '-' ? -0.25 : 0.25));
      } else if (e.key === '0') {
        e.preventDefault();
        setWorkspaceZoom(1);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  /* UI pass, 2026-10: the header carries only the §6 save status + Save (the
   * house order, docs/UI_GUIDE.md). Product navigation, the view switch and
   * flip used to share the header's action slot with it and crowded the title
   * and SKU chip off the row; they are the page's toolbar now. */
  const toolbar = (
    <div className="toolbar ws-toolbar">
      <ProductNav
        products={navProducts}
        pickerProducts={allProducts}
        activeProductId={activeProductId}
        // Stepping keeps the frozen list the Library handed over.
        onPick={(id) => { if (id) openProductInWorkspace(id, { navIds: workspaceNavIds }); }}
        busy={processing}
      />
      <span className="toolbar__spacer" />
      <div className="segments" role="group" aria-label="View">
        <button
          type="button"
          className={`segment${viewMode === 'single' ? ' is-active' : ''}`}
          onClick={() => setWorkspaceViewMode('single')}
        >Single</button>
        <button
          type="button"
          className={`segment${viewMode === 'beforeAfter' ? ' is-active' : ''}`}
          disabled={!activeImage?.processedFilepath}
          title={!activeImage?.processedFilepath ? 'Process the image first to enable compare' : ''}
          onClick={() => setWorkspaceViewMode('beforeAfter')}
        >Before / After</button>
      </div>
      {/* v0.26.14: flip the source file on disk. Destructive — same
          IPC the Library Lightbox calls. Disabled if no active image. */}
      <div className="segments" role="group" aria-label="Flip source image">
        <button
          type="button"
          className="segment ws-segment-icon"
          onClick={() => handleFlipActive('h')}
          disabled={!activeImage || processing || cropApplying}
          title="Flip horizontally (mirror left ↔ right). Rewrites the source file on disk."
          aria-label="Flip horizontally"
        ><FlipIcon axis="h" />Flip H</button>
        <button
          type="button"
          className="segment ws-segment-icon"
          onClick={() => handleFlipActive('v')}
          disabled={!activeImage || processing || cropApplying}
          title="Flip vertically (mirror top ↕ bottom). Rewrites the source file on disk."
          aria-label="Flip vertically"
        ><FlipIcon axis="v" />Flip V</button>
      </div>
    </div>
  );
  const productLabel = sku ? (productName ? `${sku} · ${productName}` : sku) : null;

  if (!activeProductId) {
    return (
      <div className="page page--workspace">
        <PageHeader
          title="Image Workspace"
          subtitle="Process images per product — background, canvas, enhance."
          backTo={{ module: 'library', label: 'Product Library' }}
        />
        <EmptyState
          title="No product selected"
          body="Open a product from the Product Library to start processing."
          action={<Button variant="primary" onClick={() => setActiveModule('library')}>Go to Product Library</Button>}
        />
      </div>
    );
  }

  return (
    <div className="page page--workspace">
      <PageHeader
        title="Image Workspace"
        backTo={{ module: 'library', label: 'Product Library' }}
        contextChip={productLabel ? <span className="ws-chip" title={productLabel}>{productLabel}</span> : null}
        actions={images.length ? <SaveStatus status={saveStatus} onSave={handleSaveNow} /> : null}
      />
      {toolbar}

      {loading ? (
        <EmptyState title="Loading…" />
      ) : images.length === 0 ? (
        <EmptyState
          title="No images on this product"
          body="Add some images from the Product Library, then come back here."
          action={<Button onClick={() => setActiveModule('library')}>Open Library</Button>}
        />
      ) : (
        <div className="ws-layout">
          <ImageStrip
            images={images}
            activeIndex={activeIdx}
            onSelect={handleSelectImage}
            onPreview={(idx) => setLightbox({ open: true, idx })}
          />
          <CanvasView
            image={activeImage}
            settings={settings}
            fillPreview={fillPreview}
            viewMode={viewMode}
            divider={divider}
            onDividerChange={setWorkspaceDivider}
            processing={processing}
            processingLabel={progress
              ? `${processingLabel ?? 'Processing'} (${progress.current + 1}/${progress.total})`
              : processingLabel}
            cacheBust={processedTick}
            zoom={zoom}
            onZoomChange={setWorkspaceZoom}
            guides={guides}
            onToggleGuides={toggleWorkspaceGuides}
            cropMode={cropMode}
            onToggleCropMode={toggleCropMode}
            onCropChange={handleCropChange}
            onCropAspectChange={handleCropAspectChange}
            onApplyCrop={handleApplyCrop}
            onCancelCrop={handleCancelCrop}
            cropApplying={cropApplying && cropRunEditorKeyRef.current === activeEditorKey}
            cropCommitBusy={cropApplying}
            cropPreview={cropPreview}
            onCropReady={setCropFrameReadyUrl}
            // v0.49.17: rotate buttons relocated from SettingsPanel.
            onRotationChange={(deg) => { if (!processingRunRef.current) setSettings((s) => ({ ...s, rotation: ((Math.round(Number(deg) / 90) * 90) % 360 + 360) % 360 })); }}
          />
          <SettingsPanel
            settings={settings}
            onChange={setSettings}
            onApplyThis={handleApplyThis}
            onApplyAll={handleApplyAll}
            totalImages={images.length}
            processing={processing || cropApplying}
            cropLocked={cropApplying && cropRunEditorKeyRef.current === activeEditorKey}
            hasImage={!!activeImage}
            watermarkSrc={watermarkSrc}
            onUploadWatermark={handleUploadWatermark}
            fillPreview={fillPreview}
            onToggleFillPreview={setWorkspaceFillPreview}
            // v0.49.20: bridge from Workspace watermark → Overlay templates.
            // The Save-as-Template button in the watermark section calls back
            // here so we can surface the success toast next to the bulk-apply
            // hint, instead of jamming an alert() into the panel.
            onWatermarkSavedAsTemplate={(name) => addToast(`Saved "${name}" as Overlay template — bulk-apply from Library`, 'success')}
          />
        </div>
      )}

      <Lightbox
        open={lightbox.open}
        onClose={() => setLightbox({ open: false, idx: 0 })}
        images={images}
        startIndex={lightbox.idx}
        title={productLabel}
        // v0.26.14: Workspace also gets the destructive flip control
        // inside the Lightbox. After the IPC returns, we refresh the
        // workspace's image list so the strip + canvas show the new
        // pixels too.
        productId={processing || cropApplying ? null : activeProductId}
        onImageMutated={() => {
          const productId = activeProductId;
          // v0.1.28: this refresh was uncaught, so a failure left the strip stale
          // and said nothing.
          refreshWorkspaceImages(productId)
            .then(() => {
              if (activeProductIdRef.current === productId) bumpProcessedTick();
            })
            .catch((err) => {
              if (activeProductIdRef.current === productId) addToast(err.message, 'error');
            });
        }}
      />
    </div>
  );
}

/**
 * In-workspace product navigation. Three controls compressed into one
 * compact group:
 *
 *  - ◀ / ▶  step to prev / next product in the company-wide product list
 *           (same order Library shows, with normal pagination skipped — we
 *           operate on the full list)
 *  - select dropdown: jump to any product. Plain native select for now;
 *           300+ companies probably want the typeahead pattern we built
 *           for AI Studio, but the dropdown is fine for typical sizes.
 *
 * Disabled when at the ends of the list. The label shows current index so
 * the user knows where they are ("12 / 344").
 */
/**
 * The list ◀ ▶ step through. 0.1.94: a FROZEN id list — the Library's filtered
 * and sorted ids when it opened the Workspace (`workspaceNavIds`), or, when the
 * Workspace was opened some other way, the whole company's order captured the
 * first time it is needed. Never the live store order: processing bumps
 * updated_at, which moved the product to the top of the live list, and an
 * "Unprocessed" filter dropped it out altogether (index -1, arrows disabled).
 * Pure apart from the `frozen` cache it is handed; exported for tests.
 */
export function workspaceNavList({ navIds, allProducts, activeProductId, companyId, frozen }) {
  const byId = new Map((allProducts || []).map((p) => [p.id, p]));
  let ids = Array.isArray(navIds) && navIds.includes(activeProductId) ? navIds : null;
  if (!ids) {
    const cached = frozen.current;
    if (!cached || cached.companyId !== companyId || !cached.ids.length || !cached.ids.includes(activeProductId)) {
      frozen.current = { companyId, ids: (allProducts || []).map((p) => p.id) };
    }
    ids = frozen.current.ids;
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function ProductNav({ products, pickerProducts, activeProductId, onPick, busy = false }) {
  const idx = products.findIndex((p) => p.id === activeProductId);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < products.length - 1;
  return (
    <div className="segments ws-prodnav" role="group" aria-label="Product">
      <button
        type="button"
        className="segment ws-segment-icon"
        disabled={!canPrev || busy}
        title="Previous product"
        aria-label="Previous product"
        onClick={() => onPick(products[idx - 1]?.id)}
      ><Chevron dir="left" /></button>
      {/* 0.1.94: a searchable picker instead of a 2,500-option native select,
          which cost an 89 ms forced layout on every ◀ / ▶ (measured).
          v0.1.29: switching product mid-run is blocked. The in-flight process
          is already writing to the previous product, and the refresh that
          follows it would paint THAT product's images under the new product's
          header — then the next Apply would fail with "Image not found on
          product". Finishing the current run first is a one-click wait. */}
      <fieldset className="ws-prodnav__picker" disabled={busy} title={busy ? 'Wait for the current run to finish' : 'Jump to product'}>
        <ProductCombobox
          products={pickerProducts}
          value={activeProductId}
          onChange={(id) => { if (id) onPick(id); }}
          allowClear={false}
          ariaLabel="Jump to product"
        />
      </fieldset>
      <button
        type="button"
        className="segment"
        disabled={!canNext || busy}
        title="Next product"
        aria-label="Next product"
        onClick={() => onPick(products[idx + 1]?.id)}
      ><Chevron dir="right" /></button>
      {idx >= 0 ? (
        <span className="ws-prodnav__counter muted">{idx + 1} / {products.length}</span>
      ) : null}
    </div>
  );
}

/* UI pass, 2026-10: the private SaveIndicator + formatAgo that lived here are
 * gone. The header uses the shared SaveStatus (components/SaveStatus.jsx),
 * which takes this page's `{ state, lastSavedAt }` shape as `status`, owns the
 * 30 s tick, and shows the error state as a retry instead of "Save failed". */

function Chevron({ dir }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d={dir === 'left' ? 'M7.5 2.5L4 6l3.5 3.5' : 'M4.5 2.5L8 6l-3.5 3.5'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mirror glyph: a dashed axis with a solid and an outlined half. */
function FlipIcon({ axis }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={axis === 'v' ? { transform: 'rotate(90deg)' } : undefined}>
      <path d="M7 1.5v11" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.6" strokeLinecap="round" />
      <path d="M5 3.5L1.5 10.5H5z" fill="currentColor" />
      <path d="M9 3.5l3.5 7H9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
