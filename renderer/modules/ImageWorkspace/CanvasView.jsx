import { useEffect, useRef, useState } from 'react';
import { appImageSrc } from '../../lib/imageUrl.js';
import { SliderField } from '../../components/ui.jsx';
import { shortcutBlocked } from '../../components/ShortcutsModal.jsx';
import { parseAspectRatio, rectAspectFromOutput, buildDragRect, resize, moveRect, containedImageBounds, keyboardCropRect } from './cropGeometry.js';

// v0.49.15: aspect-ratio presets exposed on the crop toolbar. The chip ids
// are also the value persisted in `settings.cropAspectRatio`. "free" is
// the no-constraint case (default behaviour, drag any rect).
const ASPECT_PRESETS = [
  { id: 'free',  label: 'Free' },
  { id: '1:1',   label: '1:1' },
  { id: '4:3',   label: '4:3' },
  { id: '3:4',   label: '3:4' },
  { id: '16:9',  label: '16:9' },
  { id: '9:16',  label: '9:16' },
];

// v0.49.17: rotate-arrow glyph used by the 90° buttons in the canvas tools
// row. Same shape used to live in SettingsPanel; moved here when the rotate
// controls relocated next to Crop. Drawn as a small curved arrow; the left
// variant just mirrors via CSS transform.
function RotateGlyph({ direction = 'right' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      style={{ transform: direction === 'left' ? 'scaleX(-1)' : 'none' }}
    >
      <path d="M3 7a4 4 0 1 1 1.2 2.85" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3 4.5V7h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CanvasView({
  image,
  settings,
  fillPreview,
  viewMode,
  divider,
  onDividerChange,
  processing,
  processingLabel,
  cacheBust = 0,
  zoom = 1,
  onZoomChange,
  guides = false,
  onToggleGuides,
  cropMode = false,
  onToggleCropMode,
  onCropChange,
  // v0.49.15: aspect-ratio crop additions.
  onCropAspectChange,         // (id: string) — picks a chip
  onApplyCrop,                // (destination: 'newImage' | 'overwrite') — commits
  onCancelCrop,               // () — clears rect + exits crop mode
  cropPreview = null,
  onCropReady,
  cropCommitBusy = false,
  cropApplying = false,       // disables Apply while IPC is in flight
  // v0.49.17: 90° rotate buttons relocated from SettingsPanel into the
  // canvas tools row. onRotationChange(deg) — parent updates settings.rotation.
  onRotationChange,
}) {
  const containerRef = useRef(null);
  const cropRef = useRef(null);
  const [boardSize, setBoardSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const board = containerRef.current;
    if (!board || !cropMode) return undefined;
    const measure = () => setBoardSize({ width: board.clientWidth, height: board.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    return () => observer.disconnect();
  }, [cropMode, image?.id]);
  const cropBounds = containedImageBounds(cropPreview?.outW, cropPreview?.outH, boardSize.width, boardSize.height);
  const [loadedCropUrl, setLoadedCropUrl] = useState(null);
  const hasCropSource = !!cropPreview && !!cropBounds;
  const cropReady = hasCropSource && loadedCropUrl === cropPreview.url;
  useEffect(() => { onCropReady?.(cropReady ? cropPreview.url : null); }, [cropReady, cropPreview?.url, onCropReady]);
  useEffect(() => { setCropDrag(null); }, [cropMode, image?.id, image?.contentHash, cropPreview?.url]);
  const [dragging, setDragging] = useState(false);
  // v0.49.15: cropDrag now tracks one of three modes:
  //   { mode: 'create', anchor: {x,y} }
  //   { mode: 'move',   anchor: {x,y}, origin: rect }       // dragging the rect interior
  //   { mode: 'resize', anchor: {x,y}, origin: rect, handle: 'nw'|'ne'|'sw'|'se' }
  // anchor = pointer at mousedown (normalised), origin = rect at mousedown.
  const [cropDrag, setCropDrag] = useState(null);
  // Local custom-ratio editor — only consumed when the ratio chip == 'custom'.
  // Persisted as the cropAspectRatio settings string ("3:2" etc) once valid.
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  // Destination chosen for the eventual Apply click. Persists locally to
  // the canvas so the user\'s choice survives them adjusting the rect.
  const [cropDestination, setCropDestination] = useState('newImage');

  /* v0.1.27: the RAW layer had no cache-busting stamp, while the processed one
   * right below it did. Product image files are rewritten in place — flip,
   * crop-to-source, or the renumbering that follows a delete — so the browser
   * kept showing the pre-edit pixels on the big canvas after such an edit even
   * though the thumbnail strip refreshed. AGENTS.md §12 requires every rendered
   * image URL to carry a stamp that changes when the bytes do. */
  const rawSrc = appImageSrc(image?.filepath, image?.contentHash || image?.id || cacheBust);
  const processedSrc = appImageSrc(image?.processedFilepath, cacheBust);

  useEffect(() => {
    if (!dragging) return undefined;
    function onMove(e) {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = (x / rect.width) * 100;
      onDividerChange(pct);
    }
    function onUp() { setDragging(false); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onDividerChange]);

  // Aspect lock uses the authoritative transformed-source pixel dimensions.
  // Recomputed on every render; cheap.
  const outputAspect = parseAspectRatio(settings.cropAspectRatio);
  const rectAspectLock = rectAspectFromOutput(
    outputAspect,
    cropPreview?.outW,
    cropPreview?.outH,
  );

  // v0.49.15: crop drag handles three modes — create / move / resize.
  // Mode is chosen at mousedown time based on the event target (see
  // handleCropMouseDown). Pointer coords are converted to normalised
  // 0..1 fractions of the displayed source, excluding letterboxing and zoom.
  useEffect(() => {
    if (!cropDrag) return undefined;
    function pointFromEvent(e) {
      const el = cropRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
      };
    }
    function onMove(e) {
      const p = pointFromEvent(e); if (!p) return;
      if (cropDrag.mode === 'create') {
        onCropChange(buildDragRect(cropDrag.anchor, p, rectAspectLock));
      } else if (cropDrag.mode === 'move') {
        const dx = p.x - cropDrag.anchor.x;
        const dy = p.y - cropDrag.anchor.y;
        onCropChange(moveRect(cropDrag.origin, dx, dy));
      } else if (cropDrag.mode === 'resize') {
        onCropChange(resize(cropDrag.origin, cropDrag.handle, p, rectAspectLock));
      }
    }
    function onUp() { setCropDrag(null); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [cropDrag, onCropChange, rectAspectLock]);

  // Mousedown on the .ws-crop overlay. Routing:
  //   - if target has data-crop-handle → resize that corner
  //   - else if target is inside .ws-crop__rect (and we have a rect) → move
  //   - else → create new rect from this point
  function handleCropMouseDown(e) {
    if (!cropMode || !cropRef.current || cropApplying || !cropReady) return;
    e.preventDefault();
    cropRef.current.focus?.();
    const r = cropRef.current.getBoundingClientRect();
    const p = {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top)  / r.height)),
    };
    const handle = e.target?.getAttribute?.('data-crop-handle');
    if (handle && settings.sourceCropRect) {
      setCropDrag({ mode: 'resize', anchor: p, origin: settings.sourceCropRect, handle });
      return;
    }
    const isMove = e.target?.classList?.contains('ws-crop__move-zone');
    if (isMove && settings.sourceCropRect) {
      setCropDrag({ mode: 'move', anchor: p, origin: settings.sourceCropRect });
      return;
    }
    // Create — snap to ratio if one is locked.
    const initial = buildDragRect(p, p, rectAspectLock);
    onCropChange(initial);
    setCropDrag({ mode: 'create', anchor: p });
  }

  function createKeyboardCrop() {
    if (cropApplying || cropCommitBusy || processing || !cropReady) return;
    if (!settings.sourceCropRect) onCropChange(keyboardCropRect(null, { key: 'Enter' }, cropPreview.outW, cropPreview.outH, outputAspect));
    cropRef.current?.focus?.();
  }

  function handleCropKeyDown(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || shortcutBlocked(e.target, document)
      || cropApplying || cropCommitBusy || processing || !cropReady) return;
    if (!['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = keyboardCropRect(settings.sourceCropRect, e, cropPreview.outW, cropPreview.outH, outputAspect);
    if (rect !== settings.sourceCropRect) onCropChange(rect);
  }

  const canvasStyle = fillPreview
    ? { background: settings.backgroundColor }
    : undefined;

  const aspect = `${settings.canvasWidth} / ${settings.canvasHeight}`;
  const isBeforeAfter = viewMode === 'beforeAfter' && processedSrc;

  const zoomPct = Math.round(zoom * 100);
  const canZoomOut = zoom > 0.25;
  const canZoomIn = zoom < 4;

  return (
    <div className="ws-canvas">
      <div className="ws-canvas__top">
        <div className="ws-canvas__size">
          {settings.canvasWidth} × {settings.canvasHeight}px · {settings.colorProfile}
        </div>
        <div className="ws-canvas__top-info">
          {cropMode ? <span className="ws-canvas__badge">Crop raw source</span> : image?.isProcessed
            ? <span className="ws-canvas__badge ws-canvas__badge--done">Processed</span>
            : <span className="ws-canvas__badge">Raw</span>}
        </div>
      </div>

      <div className="ws-canvas__frame">
        <div className="ws-canvas__zoom-wrap" style={{ transform: `scale(${zoom})` }}>
          <div
            ref={containerRef}
            className={`ws-canvas__board${fillPreview ? '' : ' is-checker'}`}
            style={{ aspectRatio: aspect, ...canvasStyle }}
          >
            {/* Rotation preview: applied via CSS transform to the raw image
                only — the processed thumbnail already bakes rotation into
                the file. Normalised to 0/90/180/270 in 90° steps.
                v0.49.16: when crop mode is active, also tilts by the
                straighten angle so the user sees what they\'re levelling. */}
            {(() => {
              const rotateDeg = ((Math.round(Number(settings?.rotation ?? 0) / 90) * 90) % 360 + 360) % 360;
              const straighten = cropMode ? Number(settings.cropStraighten || 0) : 0;
              const totalRotate = rotateDeg + straighten;
              const rawImgStyle = totalRotate !== 0
                ? { transform: `rotate(${totalRotate}deg)`, transformOrigin: 'center center' }
                : undefined;
              if (!image) {
                return <div className="ws-canvas__placeholder">No image selected.</div>;
              }
              if (cropMode) {
                return hasCropSource
                  ? <img className="ws-canvas__img" src={cropPreview.url} alt="Raw crop source" onLoad={() => setLoadedCropUrl(cropPreview.url)} style={{ position: 'absolute', ...cropBounds }} />
                  : <div className="ws-canvas__placeholder">Preparing crop preview…</div>;
              }
              if (isBeforeAfter) {
                return (
                  <>
                    <img className="ws-canvas__img" src={rawSrc} alt="raw" style={rawImgStyle} />
                    <div
                      className="ws-canvas__clip"
                      style={{ clipPath: `inset(0 0 0 ${divider}%)` }}
                    >
                      <img className="ws-canvas__img" src={processedSrc} alt="processed" />
                    </div>
                    <div
                      className="ws-canvas__divider"
                      aria-hidden="true"
                      style={{ left: `${divider}%` }}
                      onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
                    >
                      <span className="ws-canvas__divider-handle">⇆</span>
                    </div>
                    <div className="ws-canvas__compare-labels">
                      <span>Raw</span>
                      <span>Processed</span>
                    </div>
                  </>
                );
              }
              if (processedSrc) {
                return <img className="ws-canvas__img" src={processedSrc} alt="processed" />;
              }
              return <img className="ws-canvas__img ws-canvas__img--raw" src={rawSrc} alt="raw" style={rawImgStyle} />;
            })()}

            {guides && image ? (
              <div className="ws-canvas__guides" aria-hidden>
                <div className="ws-canvas__guide ws-canvas__guide--v" />
                <div className="ws-canvas__guide ws-canvas__guide--h" />
              </div>
            ) : null}

            {/* v0.49.16: horizontal level reference line — only shown while
                crop mode is on AND the straighten slider is non-zero. Helps
                the user align a horizon / product baseline as they tilt. */}
            {cropMode && Number(settings.cropStraighten || 0) !== 0 ? (
              <div className="ws-crop__level" aria-hidden />
            ) : null}
            {cropMode && image && cropReady ? (
              <div
                ref={cropRef}
                className="ws-crop"
                role="group"
                tabIndex={cropCommitBusy || processing ? -1 : 0}
                aria-label="Crop area"
                aria-describedby="workspace-crop-keys"
                onKeyDown={handleCropKeyDown}
                style={{ inset: 'auto', ...cropBounds }}
                onMouseDown={handleCropMouseDown}
              >
                {settings.sourceCropRect ? (
                  <div
                    className="ws-crop__rect"
                    style={{
                      left:   `${settings.sourceCropRect.x * 100}%`,
                      top:    `${settings.sourceCropRect.y * 100}%`,
                      width:  `${settings.sourceCropRect.width  * 100}%`,
                      height: `${settings.sourceCropRect.height * 100}%`,
                    }}
                  >
                    {/* v0.49.15: drag-anywhere-inside-the-rect-to-move zone.
                        Has to be pointer-events:auto (overriding the parent),
                        and sits beneath the corner handles in stacking order
                        so handles win when they overlap the corners. */}
                    <div className="ws-crop__move-zone" />
                    {/* v0.49.15: 4 corner handles + v0.49.16: 4 edge handles.
                        `data-crop-handle` is sniffed by handleCropMouseDown to
                        start a resize. Corners constrain to ratio; edges change
                        one dimension and recenter the other when ratio is locked. */}
                    <span className="ws-crop__handle ws-crop__handle--nw" data-crop-handle="nw" />
                    <span className="ws-crop__handle ws-crop__handle--ne" data-crop-handle="ne" />
                    <span className="ws-crop__handle ws-crop__handle--sw" data-crop-handle="sw" />
                    <span className="ws-crop__handle ws-crop__handle--se" data-crop-handle="se" />
                    <span className="ws-crop__handle ws-crop__handle--n"  data-crop-handle="n" />
                    <span className="ws-crop__handle ws-crop__handle--s"  data-crop-handle="s" />
                    <span className="ws-crop__handle ws-crop__handle--e"  data-crop-handle="e" />
                    <span className="ws-crop__handle ws-crop__handle--w"  data-crop-handle="w" />
                    <span className="ws-crop__hint">
                      {Math.round(settings.sourceCropRect.width * cropPreview.outW)}
                      ×
                      {Math.round(settings.sourceCropRect.height * cropPreview.outH)}
                    </span>
                  </div>
                ) : (
                  <div className="ws-crop__instr">
                    {settings.cropAspectRatio && settings.cropAspectRatio !== 'free'
                      ? `Drag on the image to set a ${settings.cropAspectRatio} crop`
                      : 'Drag on the image or press Enter here to create a crop'}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {processing ? (
          <div className="ws-canvas__overlay">
            <div className="ws-canvas__spinner" />
            <div className="ws-canvas__overlay-text">{processingLabel ?? 'Processing…'}</div>
          </div>
        ) : null}
      </div>

      <div className="ws-canvas__tools">
        <button
          type="button"
          className="ws-tool"
          disabled={!canZoomOut}
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => onZoomChange(Math.max(0.25, zoom - 0.25))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5 7h4M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <span className="ws-tool__label" title="Zoom level">{zoomPct}%</span>
        <button
          type="button"
          className="ws-tool"
          disabled={!canZoomIn}
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => onZoomChange(Math.min(4, zoom + 0.25))}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M5 7h4M7 5v4M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <div className="ws-tool__sep" />
        <button
          type="button"
          className="ws-tool ws-tool--text"
          title="Reset view (fit canvas to frame)"
          onClick={() => onZoomChange(1)}
        >Reset view</button>
        {isBeforeAfter ? (
          <label className="ws-compare-control">
            <span>Before / after</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={divider}
              aria-label="Before / after divider"
              aria-valuetext={`${Math.round(divider)}% raw, ${100 - Math.round(divider)}% processed`}
              onChange={(e) => onDividerChange(Number(e.target.value))}
            />
          <input type="number" className="input ws-compare-value" min="0" max="100" step="1" value={Math.round(divider)}
              aria-label="Before / after divider value" onChange={(e) => { const value = Number(e.target.value); if (Number.isFinite(value)) onDividerChange(Math.max(0, Math.min(100, value))); }} />
          </label>
        ) : null}
        <div className="ws-tool__sep" />
        <button
          type="button"
          className={`ws-tool ws-tool--text${guides ? ' is-active' : ''}`}
          title="Toggle alignment guides"
          onClick={onToggleGuides}
        >Guides</button>
        <div className="ws-tool__sep" />
        {/* v0.49.17: 90° rotate buttons (left / right / reset) — relocated
            from the SettingsPanel "Orient" block. Always visible because
            rotation is a workspace-wide setting, not a crop-mode toggle.
            Step is exactly 90° so the bake stays lossless in sharp. */}
        <button
          type="button"
          className="ws-tool"
          title="Rotate 90° left"
          aria-label="Rotate 90° left"
          disabled={cropCommitBusy || processing}
          onClick={() => onRotationChange?.(((Number(settings?.rotation ?? 0) - 90) + 360) % 360)}
        >
          <RotateGlyph direction="left" />
        </button>
        <button
          type="button"
          className="ws-tool"
          title="Rotate 90° right"
          aria-label="Rotate 90° right"
          disabled={cropCommitBusy || processing}
          onClick={() => onRotationChange?.((Number(settings?.rotation ?? 0) + 90) % 360)}
        >
          <RotateGlyph direction="right" />
        </button>
        {Number(settings?.rotation ?? 0) !== 0 ? (
          <button
            type="button"
            className="ws-tool ws-tool--text"
            title="Reset rotation to 0°"
            disabled={cropCommitBusy || processing}
          onClick={() => onRotationChange?.(0)}
          >Reset {(((Number(settings?.rotation ?? 0)) % 360) + 360) % 360}°</button>
        ) : null}
        <div className="ws-tool__sep" />
        <button
          type="button"
          className={`ws-tool ws-tool--text${cropMode ? ' is-active' : ''}`}
          title="Crop tool — draw or use the keyboard, then Apply crop"
          disabled={cropCommitBusy || processing}
          onClick={onToggleCropMode}
        >Crop</button>
        {(settings.sourceCropRect || settings.cropRect) && !cropMode ? (
          <button
            type="button"
            className="ws-tool ws-tool--text"
            title="Reset crop"
            onClick={() => onCropChange(null)}
          >Reset crop</button>
        ) : null}
      </div>

      {/* v0.49.15: aspect-ratio chip bar + Apply/Cancel. Only visible when
          cropMode is on so the rest of the workspace stays clean. */}
      {cropMode ? (
        <div className="ws-crop-bar">
          <p id="workspace-crop-keys" className="ws-crop-bar__keyboard ws-hint">
            Focus the crop area: Enter or Space creates a crop. Arrows move 1 source pixel; Shift uses 10. Alt + arrows resize the right or bottom edge.
          </p>
          <button type="button" className="ws-tool ws-tool--text" disabled={cropCommitBusy || processing || !cropReady} onClick={createKeyboardCrop} title="Focus the crop area for keyboard movement and resizing">{settings.sourceCropRect ? 'Adjust crop' : 'Create crop'}</button>
          <div className="ws-crop-bar__chips" role="radiogroup" aria-label="Crop aspect ratio">
            {ASPECT_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={(settings.cropAspectRatio || 'free') === p.id}
                className={`segment${(settings.cropAspectRatio || 'free') === p.id ? ' is-active' : ''}`}
                disabled={cropApplying}
                onClick={() => onCropAspectChange?.(p.id)}
                title={p.id === 'free' ? 'Free — no aspect lock' : `Lock to ${p.id}`}
              >{p.label}</button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={settings.cropAspectRatio === 'custom'}
              className={`segment${settings.cropAspectRatio === 'custom' ? ' is-active' : ''}`}
              disabled={cropApplying}
                onClick={() => onCropAspectChange?.('custom')}
              title="Custom — set a numeric W:H ratio below"
            >Custom</button>
          </div>
          {/* v0.49.16: straighten slider. Range -45..+45°. The image inside
              the canvas tilts with the slider so you can see what you\'re
              levelling against; the crop rect stays axis-aligned. On Apply,
              the server rotates the source by this angle before extracting
              the crop region. */}
          <div className="ws-crop-bar__straighten">
            <SliderField
              label="Straighten"
              value={Number(settings.cropStraighten || 0)}
              min={-45}
              max={45}
              step={0.1}
              suffix="°"
              onChange={(v) => onCropAspectChange?.(`__straighten:${v}`)}
            />
            {Number(settings.cropStraighten || 0) !== 0 ? (
              <button
                type="button"
                className="ws-tool ws-tool--text"
                disabled={cropApplying}
                onClick={() => onCropAspectChange?.('__straighten:0')}
                title="Reset to 0°"
              >Reset</button>
            ) : null}
          </div>

          {settings.cropAspectRatio === 'custom' || /^custom-/.test(settings.cropAspectRatio || '') ? (
            <div className="ws-crop-bar__custom">
              <input
                type="number"
                min="0.1"
                step="0.1"
                placeholder="W"
                value={customW}
                onChange={(e) => setCustomW(e.target.value)}
                aria-label="Custom ratio width"
              />
              <span>:</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                placeholder="H"
                value={customH}
                onChange={(e) => setCustomH(e.target.value)}
                aria-label="Custom ratio height"
              />
              <button
                type="button"
                className="ws-tool ws-tool--text"
                onClick={() => {
                  const w = Number(customW), h = Number(customH);
                  if (w > 0 && h > 0) onCropAspectChange?.(`custom-${w}:${h}`);
                }}
              >Apply ratio</button>
            </div>
          ) : null}

          <div className="ws-crop-bar__actions">
            <div className="ws-crop-bar__dest" role="radiogroup" aria-label="Crop output destination">
              <button
                type="button"
                role="radio"
                aria-checked={cropDestination === 'newImage'}
                className={`segment${cropDestination === 'newImage' ? ' is-active' : ''}`}
                onClick={() => setCropDestination('newImage')}
                title="Adds a cropped copy as a new product image — original raw is preserved."
              >Save as new</button>
              <button
                type="button"
                role="radio"
                aria-checked={cropDestination === 'overwrite'}
                className={`segment${cropDestination === 'overwrite' ? ' is-active' : ''}`}
                onClick={() => setCropDestination('overwrite')}
                title="Overwrites the source file on disk — no undo."
              >Overwrite source</button>
            </div>
            <button
              type="button"
              className="ws-tool ws-tool--text"
              onClick={onCancelCrop}
              disabled={cropApplying}
            >Cancel</button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onApplyCrop?.(cropDestination)}
              disabled={!settings.sourceCropRect || cropCommitBusy || !cropReady}
            >{cropApplying ? 'Cropping…' : 'Apply crop'}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
