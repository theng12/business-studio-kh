import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CSS_PX_PER_MM, MIN_SIZE_MM, PX_PER_MM_BASE, SNAP_GUIDE_MM, alignPatches, clampBox,
  distributePatches, elementLabel, fitScale, inPaintOrder, marqueeHits, ptToPx,
  resizeElement, rotatedBounds, scaleSelection, snapMm, smartGuides, toggleSelected,
} from './designerGeometry.js';
import { appImageSrc } from '../../lib/imageUrl.js';
import { priceEntry, formatPriceEntry } from '../../lib/prices.js';

/**
 * Keep a pointer gesture alive even when the finger/stylus leaves the element
 * it started on. Harmless when the engine does not support capture (and for
 * touch the browser already captures implicitly), so it is best-effort.
 */
function capturePointer(e) {
  try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch { /* unsupported */ }
}

/**
 * v0.1.64: the Label Studio designer canvas.
 *
 * WHY THIS FILE EXISTS. The label editor used to be a ~30-line `LabelCanvas`
 * inside LabelTemplates.jsx whose whole interaction model was "pointerdown on a
 * `<button>` starts a drag". That produced the complaint, and the code explains
 * it:
 *
 *   - the element's handler did NOT stop propagation, and the canvas's own
 *     pointerdown ran afterwards and set the selection to null — so a click
 *     selected an element and deselected it in the same tick, and the inspector
 *     never appeared;
 *   - there were no resize handles, no marquee, no multi-select, no snapping,
 *     no guides, no zoom, no undo;
 *   - the element's outline was 1px of border on a `<button>`, so the hit area
 *     was the box itself and thin elements (a divider, a colour bar) were
 *     almost impossible to grab.
 *
 * The original Label Studio KH designer (the app this was ported from) had all
 * of it, so this re-implements that model in this app's terms:
 *
 *   fit/zoom → ResizeObserver + ⌘/Ctrl+wheel
 *   select   → element pointerdown (stopPropagation), shift-click toggles,
 *              marquee on empty canvas, click-empty clears
 *   move     → drag with smart guides against sibling edges/centres, 1mm snap
 *              when snapping is on, multi-element move by a shared delta
 *   resize   → eight handles, aspect lock by element type, Shift inverts it,
 *              west/north handles keep the opposite edge still
 *   scale    → a multi-selection gets its own bounding box with handles
 *   pan      → Space or middle-button drag scrolls the stage
 *   keys     → arrows nudge (1mm, Shift 0.1mm), Delete, ⌘D, ⌘C/⌘V, ⌘Z/⇧⌘Z
 *   menu     → right-click for lock / front / back / duplicate / delete
 *   palette  → drag a type from the toolbar and drop it where you want it
 *
 * The preview rendering is high-fidelity on purpose: font sizes are converted
 * from POINTS (what the printer uses) rather than guessed in px, barcodes and
 * QR codes are real bwip-js images from the main process, and product/logo art
 * is shown through the app-image:// protocol. "Exact preview" swaps the whole
 * layer for the real `labels:previewDraft` document — the same HTML the printer
 * gets — so the user can always check the designer is not lying.
 */
export function DesignerCanvas({
  template, elements, selectedIds, setElements, commit, onSelect,
  zoom, onZoomChange, snap, onSnapChange, sample, onAction,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [fit, setFit] = useState(1);
  const [marquee, setMarquee] = useState(null);
  const [guides, setGuides] = useState([]);
  const [menu, setMenu] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [exact, setExact] = useState(false);
  const [exactHtml, setExactHtml] = useState('');
  const [exactBusy, setExactBusy] = useState(false);
  // Space held → the stage is a hand tool; `panning` is the live drag.
  const spaceRef = useRef(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);

  const scale = zoom === 'fit' ? fit : Number(zoom) || 1;
  const pxPerMm = PX_PER_MM_BASE * scale;
  const canvasW = template.widthMm * pxPerMm;
  const canvasH = template.heightMm * pxPerMm;
  const ordered = useMemo(() => inPaintOrder(elements), [elements]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setFit(fitScale(rect.width, rect.height, template.widthMm, template.heightMm));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [template.widthMm, template.heightMm]);

  // ⌘/Ctrl + wheel (or a trackpad pinch, which arrives as ctrlKey) zooms at the
  // cursor instead of scrolling the stage.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const current = zoom === 'fit' ? fit : Number(zoom) || 1;
      const next = Math.max(0.25, Math.min(8, current * Math.exp(-e.deltaY * 0.005)));
      onZoomChange(Math.round(next * 100) / 100);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, fit, onZoomChange]);

  // Space is the hand tool (as in every design app): hold it and drag anywhere
  // over the stage to pan. It must stay a plain space while a text field has
  // focus — typing "2 5" in the size box must not turn into a pan — so the key
  // is ignored there and only then re-armed on release/blur.
  useEffect(() => {
    const isField = (target) => /INPUT|TEXTAREA|SELECT/.test(target?.tagName || '') || !!target?.isContentEditable;
    const onKeyDown = (e) => {
      if (e.key !== ' ' && e.code !== 'Space') return;
      if (isField(e.target)) return;
      if (!spaceRef.current) { spaceRef.current = true; setSpaceDown(true); }
      e.preventDefault();               // do not scroll the stage with Space
    };
    const release = () => { spaceRef.current = false; setSpaceDown(false); };
    const onKeyUp = (e) => {
      if (e.key !== ' ' && e.code !== 'Space') return;
      release();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);   // alt-tab must not strand the hand tool
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
    };
  }, []);

  // Space/middle-button is a pan, never a select/move/marquee. Every gesture
  // starter asks this first, so a pan can never also move an element.
  const isPanGesture = useCallback((e) => e.button === 1 || spaceRef.current, []);

  const clientToMm = useCallback((clientX, clientY) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / pxPerMm, y: (clientY - rect.top) / pxPerMm };
  }, [pxPerMm]);

  /**
   * Replace one element's fields, clamped to the label.
   *
   * clampBox() returns ONLY { x, y, width, height }, so it has to be merged
   * over the element — spreading it as the whole element silently deleted the
   * type, bound field, colour and font of anything that was ever dragged. (The
   * UI crawl caught exactly that: elements became nameless boxes after a move.)
   */
  const patchElement = useCallback((id, patch) => {
    setElements((list) => list.map((el) => {
      if (el.id !== id) return el;
      const merged = { ...el, ...patch };
      return { ...merged, ...clampBox(merged, template.widthMm, template.heightMm) };
    }));
  }, [setElements, template.widthMm, template.heightMm]);

  const patchMany = useCallback((patches) => {
    const byId = new Map(patches.map((p) => [p.id, p.patch]));
    setElements((list) => list.map((el) => {
      const patch = byId.get(el.id);
      if (!patch) return el;
      const merged = { ...el, ...patch };
      return { ...merged, ...clampBox(merged, template.widthMm, template.heightMm) };
    }));
  }, [setElements, template.widthMm, template.heightMm]);

  /* ── move ─────────────────────────────────────────────────────────── */
  const startMove = useCallback((e, element) => {
    if (isPanGesture(e)) return;       // Space/middle drag pans the stage, not this
    e.stopPropagation();               // the canvas must not clear the selection
    if (e.button !== 0) return;
    capturePointer(e);
    const additive = e.shiftKey;
    const wasSelected = selectedIds.includes(element.id);
    if (additive && wasSelected) {
      // Shift-click TOGGLES, exactly like the Layers list: an already-selected
      // element comes out of the selection. There is nothing to drag — the
      // pointer is on the one box the click just removed, and seeding `movers`
      // from the old selection would move it anyway.
      onSelect(toggleSelected(selectedIds, element.id));
      return;
    }
    // What the gesture moves: the whole selection when this element is already
    // part of one (or is being shift-added to it), otherwise just this element.
    let moveIds;
    if (additive) {
      moveIds = [...selectedIds, element.id];   // shift-add and drag the group
      onSelect(moveIds);
    } else if (wasSelected && selectedIds.length > 1) {
      moveIds = selectedIds;                    // plain click keeps the group
    } else {
      moveIds = [element.id];                   // plain click on an unselected box
      onSelect(moveIds);
    }
    if (element.locked) return;
    const movers = elements.filter((el) => moveIds.includes(el.id) && !el.locked);
    const initials = new Map(movers.map((el) => [el.id, { x: el.x, y: el.y }]));
    const start = clientToMm(e.clientX, e.clientY);
    const others = elements.filter((el) => el.visible !== false && el.id !== element.id);
    let moved = false;

    const onMove = (ev) => {
      const mm = clientToMm(ev.clientX, ev.clientY);
      const dx = mm.x - start.x;
      const dy = mm.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.05) moved = true;

      if (movers.length === 1) {
        const init = initials.get(element.id);
        let x = Math.max(0, snapMm(init.x + dx, snap));
        let y = Math.max(0, snapMm(init.y + dy, snap));
        const guided = smartGuides({ x, y, width: element.width, height: element.height }, others);
        x = snapMm(guided.x, snap);
        y = snapMm(guided.y, snap);
        setGuides(guided.guides);
        patchElement(element.id, { x, y });
      } else {
        // Relative layout must survive a group drag, so no per-element snapping.
        setGuides([]);
        patchMany(movers.map((m) => {
          const init = initials.get(m.id);
          return { id: m.id, patch: { x: Math.max(0, snapMm(init.x + dx, snap)), y: Math.max(0, snapMm(init.y + dy, snap)) } };
        }));
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setGuides([]);
      if (moved) commit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [elements, selectedIds, onSelect, clientToMm, snap, patchElement, patchMany, commit, isPanGesture]);

  /* ── resize one element ───────────────────────────────────────────── */
  const startResize = useCallback((e, element, dir) => {
    if (isPanGesture(e)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    capturePointer(e);
    onSelect([element.id]);
    if (element.locked) return;
    const start = clientToMm(e.clientX, e.clientY);
    const aspectLocked = element.type === 'productImage' || element.type === 'logo'
      || element.type === 'image' || element.type === 'cert' || element.type === 'qr';
    let moved = false;

    const onMove = (ev) => {
      const mm = clientToMm(ev.clientX, ev.clientY);
      const dx = mm.x - start.x;
      const dy = mm.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.05) moved = true;
      const patch = resizeElement(element, dir, dx, dy, { aspectLocked, shiftKey: ev.shiftKey, snap });
      patchElement(element.id, patch);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) commit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [clientToMm, onSelect, snap, patchElement, commit, isPanGesture]);

  /* ── resize a whole selection ─────────────────────────────────────── */
  const selectedElements = useMemo(
    () => elements.filter((el) => selectedIds.includes(el.id) && el.visible !== false),
    [elements, selectedIds],
  );
  const selectionBounds = useMemo(() => {
    if (selectedElements.length < 2) return null;
    // The dashed box is drawn on screen, so it hugs each element's ROTATED
    // bounds — the raw box would leave a rotated element sticking out.
    const boxes = selectedElements.map((el) => rotatedBounds(el));
    const left = Math.min(...boxes.map((b) => b.x));
    const top = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, [selectedElements]);

  const startSelectionResize = useCallback((e, dir) => {
    if (isPanGesture(e)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0 || !selectionBounds) return;
    capturePointer(e);
    const snapshot = selectedElements.map((el) => ({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height }));
    const anchor = dir.includes('nw') ? 'bottom-right'
      : dir.includes('ne') ? 'bottom-left'
        : dir.includes('sw') ? 'top-right'
          : dir.includes('se') ? 'top-left'
            : dir === 'n' ? 'bottom' : dir === 's' ? 'top' : dir === 'w' ? 'right' : 'left';
    const start = clientToMm(e.clientX, e.clientY);
    const box = { ...selectionBounds };
    let moved = false;

    const onMove = (ev) => {
      const mm = clientToMm(ev.clientX, ev.clientY);
      const dx = mm.x - start.x;
      const dy = mm.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.05) moved = true;
      let width = box.width;
      let height = box.height;
      if (dir.includes('e')) width = box.width + dx;
      if (dir.includes('w')) width = box.width - dx;
      if (dir.includes('s')) height = box.height + dy;
      if (dir.includes('n')) height = box.height - dy;
      const min = 0.5;
      if (Math.abs(width) < min) width = width < 0 ? -min : min;
      if (Math.abs(height) < min) height = height < 0 ? -min : min;
      let scaleX = dir.includes('e') || dir.includes('w') ? width / box.width : 1;
      let scaleY = dir.includes('n') || dir.includes('s') ? height / box.height : 1;
      if (ev.shiftKey) {
        if (scaleX !== 1 && scaleY !== 1) {
          const mag = Math.max(Math.abs(scaleX), Math.abs(scaleY));
          scaleX = (scaleX < 0 ? -1 : 1) * mag;
          scaleY = (scaleY < 0 ? -1 : 1) * mag;
        } else if (scaleX !== 1) scaleY = scaleX;
        else if (scaleY !== 1) scaleX = scaleY;
      }
      patchMany(scaleSelection(snapshot, scaleX, scaleY, anchor));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) commit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [selectionBounds, selectedElements, clientToMm, patchMany, commit, isPanGesture]);

  /* ── marquee on empty canvas ──────────────────────────────────────── */
  const onCanvasPointerDown = useCallback((e) => {
    if (isPanGesture(e)) return;       // Space/middle drag pans, it does not marquee
    if (e.target !== e.currentTarget || e.button !== 0) return;
    capturePointer(e);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const additive = e.shiftKey;
    const base = additive ? selectedIds : [];
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    let dragged = false;
    setMarquee({ x0, y0, x1: x0, y1: y0 });

    const onMove = (ev) => {
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      if (!dragged && Math.abs(x1 - x0) + Math.abs(y1 - y0) > 2) dragged = true;
      setMarquee({ x0, y0, x1, y1 });
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setMarquee(null);
      if (!dragged) { if (!additive) onSelect([]); return; }
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      const hits = marqueeHits(elements, {
        x0: x0 / pxPerMm, y0: y0 / pxPerMm, x1: x1 / pxPerMm, y1: y1 / pxPerMm,
      });
      onSelect(additive ? Array.from(new Set([...base, ...hits])) : hits);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [selectedIds, elements, pxPerMm, onSelect, isPanGesture]);

  /* ── drag-to-pan the stage (Space or middle button) ───────────────── */
  const onStagePointerDown = useCallback((e) => {
    if (!isPanGesture(e)) return;
    e.preventDefault();                // no middle-click autoscroll / text select
    e.stopPropagation();
    capturePointer(e);
    const el = wrapRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    setPanning(true);
    const onMove = (ev) => {
      el.scrollLeft = startLeft - (ev.clientX - startX);
      el.scrollTop = startTop - (ev.clientY - startY);
    };
    const endPan = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endPan);
      window.removeEventListener('pointercancel', endPan);
      setPanning(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endPan);
    window.addEventListener('pointercancel', endPan);
  }, [isPanGesture]);

  /* ── drop a palette item ──────────────────────────────────────────── */
  const onDrop = useCallback((e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/x-mskh-label-element');
    if (!type) return;
    const mm = clientToMm(e.clientX, e.clientY);
    onAction({ kind: 'drop', type, x: mm.x, y: mm.y });
  }, [clientToMm, onAction]);

  /* ── exact preview (the real print render) ────────────────────────── */
  const loadExact = useCallback(async () => {
    setExactBusy(true);
    try {
      const res = await window.api.labels.previewDraft(template, sample?.id, { mode: 'single' });
      setExactHtml(res.html);
      return true;
    } catch {
      setExactHtml('');
      return false;
    } finally {
      setExactBusy(false);
    }
  }, [template, sample?.id]);

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const target = elements.find((el) => el.id === menu.elementId);
    if (!target) return [];
    return [
      { label: 'Bring to front', onClick: () => onAction({ kind: 'reorder', id: target.id, dir: 1 }) },
      { label: 'Send to back', onClick: () => onAction({ kind: 'reorder', id: target.id, dir: -1 }) },
      { divider: true },
      { label: target.locked ? 'Unlock' : 'Lock', onClick: () => onAction({ kind: 'lock', id: target.id, locked: !target.locked }) },
      { label: target.visible === false ? 'Show' : 'Hide', onClick: () => onAction({ kind: 'hide', id: target.id, visible: target.visible === false }) },
      { divider: true },
      { label: 'Duplicate', onClick: () => onAction({ kind: 'duplicate', id: target.id }) },
      { label: 'Delete', onClick: () => onAction({ kind: 'remove', id: target.id }) },
    ];
  }, [menu, elements, onAction]);

  return (
    <div className="ld-stage-wrap">
      <div className="ld-bar">
        <span className="ld-bar__coords">
          {cursor ? `${cursor.x.toFixed(1)} , ${cursor.y.toFixed(1)} mm` : `${template.widthMm} × ${template.heightMm} mm`}
        </span>
        <div className="ld-bar__tools">
          <button type="button" onClick={() => onZoomChange('fit')} className={zoom === 'fit' ? 'is-active' : ''} title="Fit the label in the window (⌘0)">Fit</button>
          <button type="button" onClick={() => onZoomChange(Math.max(0.25, Math.round(scale * 100 - 10) / 100))} title="Zoom out">−</button>
          <button type="button" onClick={() => onZoomChange(1)} className={scale === 1 && zoom !== 'fit' ? 'is-active' : ''} title="100%">100%</button>
          <button type="button" onClick={() => onZoomChange(Math.min(8, Math.round(scale * 100 + 10) / 100))} title="Zoom in">+</button>
          <span className="ld-bar__percent">{zoom === 'fit' ? 'fit' : `${Math.round(scale * 100)}%`}</span>
          <button type="button" onClick={() => onSnapChange(!snap)} className={snap ? 'is-active' : ''} title="Snap to whole millimetres and show the grid">Snap {snap ? 'on' : 'off'}</button>
          <button
            type="button"
            className={exact ? 'is-active' : ''}
            title="Show the real print render instead of the editable layer"
            onClick={async () => {
              if (exact) { setExact(false); return; }
              const ok = await loadExact();
              if (ok) setExact(true);
            }}
          >
            {exactBusy ? 'Rendering…' : exact ? 'Editing view' : 'Exact preview'}
          </button>
        </div>
      </div>

      <div
        ref={wrapRef}
        className={`ld-stage${spaceDown ? ' is-pan-ready' : ''}${panning ? ' is-panning' : ''}`}
        onPointerDown={onStagePointerDown}
        style={{ backgroundImage: 'repeating-conic-gradient(rgba(15,23,42,.05) 0% 25%, transparent 25% 50%)', backgroundSize: '16px 16px' }}
      >
        <div
          ref={canvasRef}
          className="ld-canvas"
          onPointerDown={onCanvasPointerDown}
          onMouseMove={(e) => {
            const mm = clientToMm(e.clientX, e.clientY);
            if (mm.x >= 0 && mm.y >= 0 && mm.x <= template.widthMm && mm.y <= template.heightMm) {
              setCursor({ x: Math.round(mm.x * 10) / 10, y: Math.round(mm.y * 10) / 10 });
            }
          }}
          onMouseLeave={() => setCursor(null)}
          onContextMenu={(e) => e.preventDefault()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          style={{
            width: canvasW,
            height: canvasH,
            background: template.backgroundColor || '#fff',
            backgroundImage: snap && !exact
              ? 'linear-gradient(to right, rgba(15,23,42,.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,.05) 1px, transparent 1px)'
              : undefined,
            backgroundSize: snap && !exact ? `${pxPerMm}px ${pxPerMm}px` : undefined,
          }}
        >
          {exact && exactHtml ? (
            <iframe
              title="Exact label preview"
              className="ld-exact"
              srcDoc={exactHtml}
              style={{
                width: template.widthMm * CSS_PX_PER_MM,
                height: template.heightMm * CSS_PX_PER_MM,
                transform: `scale(${pxPerMm / CSS_PX_PER_MM})`,
                transformOrigin: 'top left',
                pointerEvents: 'none',
              }}
            />
          ) : (
            ordered.map((el) => (
              el.visible === false ? null : (
                <ElementBox
                  key={el.id}
                  element={el}
                  pxPerMm={pxPerMm}
                  selected={selectedIds.includes(el.id)}
                  hideHandles={selectedIds.length >= 2}
                  onPointerDown={startMove}
                  onResize={startResize}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!selectedIds.includes(el.id)) onSelect([el.id]);
                    setMenu({ x: e.clientX, y: e.clientY, elementId: el.id });
                  }}
                  sample={sample}
                />
              )
            ))
          )}

          {selectionBounds ? (
            <div
              className="ld-bbox"
              style={{
                left: selectionBounds.x * pxPerMm,
                top: selectionBounds.y * pxPerMm,
                width: selectionBounds.width * pxPerMm,
                height: selectionBounds.height * pxPerMm,
              }}
            >
              {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((dir) => (
                <span
                  key={dir}
                  className={`ld-handle ld-handle--${dir} ld-handle--bbox`}
                  onPointerDown={(e) => startSelectionResize(e, dir)}
                />
              ))}
            </div>
          ) : null}

          {guides.map((g, i) => (
            <div
              key={`${g.axis}-${i}`}
              className="ld-guide"
              style={g.axis === 'x'
                ? { left: g.value * pxPerMm, top: 0, width: 1, height: canvasH }
                : { top: g.value * pxPerMm, left: 0, height: 1, width: canvasW }}
            />
          ))}

          {marquee ? (
            <div
              className="ld-marquee"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          ) : null}
        </div>
      </div>

      {menu ? (
        <div className="ld-menu" style={{ left: menu.x, top: menu.y }}>
          {menuItems.map((item, i) => (
            item.divider ? <div key={i} className="ld-menu__divider" /> : (
              <button
                key={i}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => { item.onClick?.(); setMenu(null); }}
              >
                {item.label}
              </button>
            )
          ))}
        </div>
      ) : null}
      {menu ? <div className="ld-menu-scrim" onPointerDown={() => setMenu(null)} /> : null}
    </div>
  );
}

/** One draggable element box with eight resize handles. */
function ElementBox({ element, pxPerMm, selected, hideHandles, onPointerDown, onResize, onContextMenu, sample }) {
  const style = {
    position: 'absolute',
    left: element.x * pxPerMm,
    top: element.y * pxPerMm,
    width: element.width * pxPerMm,
    height: element.height * pxPerMm,
    zIndex: Number(element.zIndex) || 1,
    transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
    transformOrigin: 'center center',
    opacity: element.opacity != null ? element.opacity : undefined,
    cursor: element.locked ? 'not-allowed' : 'move',
    // A thin element (divider, colour bar) needs a grab area bigger than itself.
    minHeight: element.height * pxPerMm < 6 ? 6 : undefined,
    outline: selected ? '1.5px solid #6366f1' : '1px solid transparent',
    outlineOffset: 1,
    boxSizing: 'border-box',
  };
  return (
    <div
      className={`ld-el${element.locked ? ' is-locked' : ''}`}
      style={style}
      onPointerDown={(e) => onPointerDown(e, element)}
      onContextMenu={onContextMenu}
      title={elementLabel(element)}
    >
      <div className="ld-el__content" style={{ pointerEvents: 'none' }}>
        <ElementPreview element={element} pxPerMm={pxPerMm} sample={sample} />
      </div>
      {selected && !element.locked && !hideHandles ? (
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((dir) => (
          <span
            key={dir}
            className={`ld-handle ld-handle--${dir}`}
            onPointerDown={(e) => onResize(e, element, dir)}
          />
        ))
      ) : null}
    </div>
  );
}

/**
 * The editable layer's drawing. Deliberately mirrors `renderLabel()` in
 * main/studioRenderer.js — pt-based type, the same alignment/fit/wrap rules,
 * the same prefix/suffix handling — because a designer that draws something
 * different from the printer is worse than no preview at all.
 */
function ElementPreview({ element, pxPerMm, sample }) {
  const [barcodeSrc, setBarcodeSrc] = useState('');

  const value = useMemo(() => {
    if (element.manualValue != null && element.manualValue !== '') return element.manualValue;
    const field = element.field || (element.type === 'qr' ? 'sku' : element.type === 'barcode' ? 'barcode' : 'name');
    /* v0.1.79: a `price.<group>` field is not a flat key on the product, so
       `sample[field]` was always undefined and every group price previewed as
       the hardcoded sample below — the canvas disagreed with the printed
       label. Resolve it exactly as main/studioRenderer.js productValue does. */
    const fromSample = field.startsWith('price.')
      ? formatPriceEntry(priceEntry(sample, field.slice(6)), '$')
      : sample?.[field];
    if (fromSample != null && fromSample !== '') return fromSample;
    if (element.type === 'date') return '2027-12-31';
    if (element.type === 'country') return 'Cambodia';
    if (element.type === 'price') return '9.99';
    if (element.type === 'sku') return 'SAMPLE-001';
    if (element.type === 'barcode') return '123456789012';
    return 'Sample product';
  }, [element.manualValue, element.field, element.type, sample]);

  // Real bwip-js barcode/QR from the main process — the old editor drew a fake
  // "|||| ||| ||" string, which is most of why the preview looked wrong.
  useEffect(() => {
    if (element.type !== 'barcode' && element.type !== 'qr') return undefined;
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await window.api.labels.barcodePreview(value, element.type === 'qr' ? 'qr' : (element.format || 'code128'));
        if (!cancelled) setBarcodeSrc(res?.dataUrl || '');
      } catch { if (!cancelled) setBarcodeSrc(''); }
    }, 120);
    return () => { cancelled = true; clearTimeout(id); };
  }, [element.type, element.format, value]);

  const text = `${element.prefix || ''}${value ?? ''}${element.suffix || ''}`;
  const common = {
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    display: 'flex',
    alignItems: element.verticalAlign === 'top' ? 'flex-start'
      : element.verticalAlign === 'bottom' ? 'flex-end' : 'center',
    justifyContent: element.align === 'center' ? 'center' : element.align === 'right' ? 'flex-end' : 'flex-start',
  };

  if (element.type === 'rect' || element.type === 'colorbar') {
    return (
      <div style={{ width: '100%', height: '100%', background: element.fill || '#eef2ff', border: `${Number(element.borderWidth) || 0}px solid ${element.borderColor || '#111827'}`, borderRadius: Number(element.radius) || 0 }} />
    );
  }
  if (element.type === 'divider') {
    return <div style={{ width: '100%', borderTop: `${Math.max(0.25, Number(element.thickness) || 1)}px solid ${element.color || '#111827'}` }} />;
  }
  if (element.type === 'barcode' || element.type === 'qr') {
    return barcodeSrc
      ? <img src={barcodeSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
      : <div className="ld-placeholder">{element.type === 'qr' ? 'QR code' : 'Barcode'}</div>;
  }
  if (element.type === 'productImage' || element.type === 'logo' || element.type === 'image' || element.type === 'cert') {
    const rel = element.type === 'productImage' ? sample?.mainImagePath : element.src;
    const src = rel ? appImageSrc(rel, sample?.contentHash || sample?.updatedAt) : '';
    if (src) return <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: element.fit || 'contain' }} />;
    return <div className="ld-placeholder">{
      element.type === 'productImage' ? 'Product image' : element.type === 'logo' ? 'Brand logo' : 'Choose image'
    }</div>;
  }
  return (
    <div
      style={{
        ...common,
        color: element.color || '#111827',
        fontSize: `${Math.max(1, ptToPx(Number(element.fontSize) || 10, pxPerMm))}px`,
        fontWeight: Number(element.fontWeight) || 400,
        fontStyle: element.italic ? 'italic' : 'normal',
        lineHeight: Number(element.lineHeight) || 1.15,
        textAlign: element.align || 'left',
        whiteSpace: element.wrap === false ? 'nowrap' : 'normal',
        wordBreak: element.wrap === false ? 'normal' : 'break-word',
      }}
    >
      {text}
    </div>
  );
}

export { MIN_SIZE_MM, SNAP_GUIDE_MM, alignPatches, distributePatches };
