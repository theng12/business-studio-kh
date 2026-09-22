/**
 * v0.1.64: Label designer geometry — the pure half of the canvas.
 *
 * Ported from the original Label Studio KH designer
 * (~/Developer/label-studio-kh/src/renderer/designer/Canvas.tsx and
 * stores/designerStore.ts), which is the editor the customer wants this one to
 * feel like. The old app had a real designer: fit-to-view zoom, marquee
 * selection, multi-element drag, eight resize handles, smart alignment guides,
 * snapping and undo. This app's label editor had none of it — you clicked an
 * element and the parent's mousedown handler cleared the selection in the same
 * tick, which is why "it is hard to pick or select elements, hard to drag and
 * drop around".
 *
 * Everything here is arithmetic on mm/px, with no React and no DOM, so the
 * rules that users argue about ("why did it snap there?", "why can't I make it
 * 2mm wide?") are unit-testable in plain `node --test`.
 *
 * UNITS
 *   - element x/y/width/height are millimetres (the print truth)
 *   - fontSize is points (also the print truth — main/studioRenderer.js writes
 *     `font-size: Npt`, so the designer must convert, not guess)
 *   - the canvas measures in px: `pxPerMm = PX_PER_MM_BASE * zoom`
 */

/** 1mm = 4px at 1× zoom in the designer (the original app's constant). */
export const PX_PER_MM_BASE = 4;

/** CSS's own mm→px ratio at 96dpi. Used to convert pt to px the way print does. */
export const CSS_PX_PER_MM = 96 / 25.4;

/** 1pt = 1/72in. At a given px-per-mm, this is how many px a point is. */
export function ptToPx(pt, pxPerMm) {
  return (Number(pt) || 0) * (25.4 / 72) * pxPerMm;
}

/** How close two edges must be, in mm, before they snap together. */
export const SNAP_GUIDE_MM = 1;

/** A box never gets smaller than this, so it can't be lost. */
export const MIN_SIZE_MM = 1;

/**
 * Scale that fits a label of wMm×hMm inside a container, with padding.
 * Clamped to the original app's 0.3–10 range so a tiny label does not fill the
 * screen and a huge one does not vanish.
 */
export function fitScale(containerW, containerH, wMm, hMm, padding = 64) {
  if (!containerW || !containerH || !wMm || !hMm) return 1;
  const sx = (containerW - padding) / (wMm * PX_PER_MM_BASE);
  const sy = (containerH - padding) / (hMm * PX_PER_MM_BASE);
  return Math.max(0.3, Math.min(10, Math.min(sx, sy)));
}

/** Round to whole mm when snapping is on; otherwise leave the free value. */
export function snapMm(value, on) {
  return on ? Math.round(value) : value;
}

/** Clamp a box so it stays inside the label. */
export function clampBox({ x, y, width, height }, labelW, labelH) {
  const w = Math.max(MIN_SIZE_MM, Math.min(Number(width) || 0, labelW));
  const h = Math.max(MIN_SIZE_MM, Math.min(Number(height) || 0, labelH));
  return {
    x: Math.max(0, Math.min(Number(x) || 0, Math.max(0, labelW - w))),
    y: Math.max(0, Math.min(Number(y) || 0, Math.max(0, labelH - h))),
    width: w,
    height: h,
  };
}

/** The bounding box of any set of elements, in mm. */
export function unionBounds(elements) {
  const list = (elements || []).filter(Boolean);
  if (!list.length) return null;
  const left = Math.min(...list.map((el) => el.x));
  const top = Math.min(...list.map((el) => el.y));
  const right = Math.max(...list.map((el) => el.x + el.width));
  const bottom = Math.max(...list.map((el) => el.y + el.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Repair a stored element list: every element needs a unique id and a type.
 *
 * Templates written by an older build (or edited by hand in the database) can
 * carry an element with no `id` or a duplicated one. That is not cosmetic:
 * selection is by id, so two elements sharing one id move together and the
 * inspector edits the wrong box. A missing `type` draws nothing at all. This
 * runs when a template is opened, so the designer can never be handed a list it
 * cannot address — and the next autosave writes the repaired version back.
 */
export function normalizeElements(elements, now = Date.now) {
  const seen = new Set();
  return (Array.isArray(elements) ? elements : []).map((raw, index) => {
    const el = raw && typeof raw === 'object' ? raw : {};
    let id = typeof el.id === 'string' && el.id.trim() ? el.id : '';
    if (!id || seen.has(id)) id = `${el.type || 'element'}-${now().toString(36)}-${index}`;
    seen.add(id);
    return { ...el, id, type: el.type || 'text' };
  });
}

/** Elements in paint order (lowest z first), stable for equal z. */
export function inPaintOrder(elements) {
  return (elements || [])
    .map((el, index) => ({ el, index }))
    .sort((a, b) => (Number(a.el.zIndex) || 1) - (Number(b.el.zIndex) || 1) || a.index - b.index)
    .map((entry) => entry.el);
}

/** Hit test for a marquee rectangle given in mm (used to build a selection). */
export function marqueeHits(elements, rect) {
  const left = Math.min(rect.x0, rect.x1);
  const right = Math.max(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const bottom = Math.max(rect.y0, rect.y1);
  return (elements || [])
    .filter((el) => el.visible !== false)
    .filter((el) => el.x < right && el.x + el.width > left && el.y < bottom && el.y + el.height > top)
    .map((el) => el.id);
}

/**
 * Smart alignment guides, ported from the original: try the moving box's left,
 * centre and right against every sibling's left, centre and right, take the
 * smallest correction inside the threshold, and report the line that was
 * matched so the canvas can draw it.
 */
export function smartGuides({ x, y, width, height }, siblings, threshold = SNAP_GUIDE_MM) {
  const others = (siblings || []).filter((s) => s && s.visible !== false);
  const guides = [];
  let nextX = x;
  let nextY = y;
  if (!others.length) return { x: nextX, y: nextY, guides };

  const xTargets = others.flatMap((s) => [s.x, s.x + s.width / 2, s.x + s.width]);
  const yTargets = others.flatMap((s) => [s.y, s.y + s.height / 2, s.y + s.height]);
  const xEdges = [x, x + width / 2, x + width];
  const yEdges = [y, y + height / 2, y + height];

  let bestX = null;
  for (const edge of xEdges) {
    for (const target of xTargets) {
      const delta = target - edge;
      if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
        bestX = { delta, target };
      }
    }
  }
  if (bestX) {
    nextX = Math.max(0, nextX + bestX.delta);
    guides.push({ axis: 'x', value: bestX.target });
  }

  let bestY = null;
  for (const edge of yEdges) {
    for (const target of yTargets) {
      const delta = target - edge;
      if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
        bestY = { delta, target };
      }
    }
  }
  if (bestY) {
    nextY = Math.max(0, nextY + bestY.delta);
    guides.push({ axis: 'y', value: bestY.target });
  }

  return { x: nextX, y: nextY, guides };
}

/**
 * Resize one element by dragging a handle.
 *
 * Returns width/height in mm, plus a doc string the caller can ignore. The
 * handle letters mean n/s, e/w and corners; `aspectLocked` comes from the
 * element type (images/barcodes keep their shape by default) and Shift inverts
 * it, exactly as the original app did.
 */
export function resizeElement(el, dir, dx, dy, { aspectLocked = false, shiftKey = false, snap = false } = {}) {
  const locked = shiftKey ? !aspectLocked : aspectLocked;
  const initial = { x: el.x, y: el.y, width: el.width, height: el.height };
  const aspect = initial.width / Math.max(initial.height, 0.001);
  const horiz = dir.includes('w') ? -1 : dir.includes('e') ? 1 : 0;
  const vert = dir.includes('n') ? -1 : dir.includes('s') ? 1 : 0;

  let dW = horiz * dx;
  let dH = vert * dy;

  if (locked) {
    if (horiz !== 0 && vert !== 0) {
      // Corner: follow the dominant axis and derive the other from the ratio.
      if (Math.abs(dx) * (1 / aspect) >= Math.abs(dy)) dH = dW / aspect;
      else dW = dH * aspect;
    } else if (horiz !== 0) {
      dH = dW / aspect;
    } else if (vert !== 0) {
      dW = dH * aspect;
    }
  }

  let width = Math.max(MIN_SIZE_MM, snapMm(initial.width + dW, snap));
  let height = Math.max(MIN_SIZE_MM, snapMm(initial.height + dH, snap));
  if (locked && horiz !== 0) height = Math.max(MIN_SIZE_MM, width / aspect);
  if (locked && vert !== 0 && horiz === 0) width = Math.max(MIN_SIZE_MM, height * aspect);

  const patch = { width, height };
  // A west/north handle moves the origin so the opposite edge stays put.
  if (horiz === -1) patch.x = Math.max(0, initial.x + (initial.width - width));
  if (vert === -1) patch.y = Math.max(0, initial.y + (initial.height - height));
  return patch;
}

/**
 * Scale a whole selection around a fixed anchor — the multi-select bounding box
 * handles. Each element's box scales proportionally, so relative layout is kept.
 */
export function scaleSelection(snapshot, scaleX, scaleY, anchor) {
  const bounds = unionBounds(snapshot);
  if (!bounds) return [];
  // The anchor is a point on the bounding box that must not move.
  const anchorX = anchor.includes('left') ? bounds.x
    : anchor.includes('right') ? bounds.x + bounds.width
      : bounds.x + bounds.width / 2;
  const anchorY = anchor.includes('top') ? bounds.y
    : anchor.includes('bottom') ? bounds.y + bounds.height
      : bounds.y + bounds.height / 2;

  return snapshot.map((el) => {
    const left = anchorX + (el.x - anchorX) * scaleX;
    const top = anchorY + (el.y - anchorY) * scaleY;
    return {
      id: el.id,
      patch: {
        x: Math.max(0, left),
        y: Math.max(0, top),
        width: Math.max(MIN_SIZE_MM, el.width * Math.abs(scaleX)),
        height: Math.max(MIN_SIZE_MM, el.height * Math.abs(scaleY)),
      },
    };
  });
}

/** Align the selection inside its own bounding box (or the label). */
export function alignPatches(elements, mode, label) {
  const list = (elements || []).filter(Boolean);
  if (list.length < 1) return [];
  const box = unionBounds(list) || { x: 0, y: 0, width: label?.widthMm || 0, height: label?.heightMm || 0 };
  const target = label
    ? { x: 0, y: 0, width: label.widthMm, height: label.heightMm }
    : box;
  return list.map((el) => {
    switch (mode) {
      case 'left': return { id: el.id, patch: { x: target.x } };
      case 'center': return { id: el.id, patch: { x: target.x + (target.width - el.width) / 2 } };
      case 'right': return { id: el.id, patch: { x: target.x + target.width - el.width } };
      case 'top': return { id: el.id, patch: { y: target.y } };
      case 'middle': return { id: el.id, patch: { y: target.y + (target.height - el.height) / 2 } };
      case 'bottom': return { id: el.id, patch: { y: target.y + target.height - el.height } };
      default: return { id: el.id, patch: {} };
    }
  });
}

/** Spread the selection evenly between its two extremes on one axis. */
export function distributePatches(elements, axis) {
  const list = [...(elements || [])].filter(Boolean);
  if (list.length < 3) return [];
  const key = axis === 'x' ? 'x' : 'y';
  const size = axis === 'x' ? 'width' : 'height';
  const sorted = [...list].sort((a, b) => a[key] - b[key]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  // Total free space, split into equal gaps between neighbours.
  const span = (last[key] + last[size]) - first[key];
  const used = sorted.reduce((sum, el) => sum + el[size], 0);
  const gap = (span - used) / (sorted.length - 1);
  let cursor = first[key];
  const patches = [];
  sorted.forEach((el, index) => {
    if (index === 0 || index === sorted.length - 1) return; // extremes stay put
    cursor += gap + sorted[index - 1][size];
    patches.push({ id: el.id, patch: { [key]: cursor } });
  });
  return patches;
}

/**
 * A short human label for a layer row, derived from the element (the original
 * app named every element in the Layers panel; ours derives it so old templates
 * without a `name` still read sensibly).
 */
export function elementLabel(el) {
  if (el?.name) return el.name;
  const type = { text: 'Text', sku: 'SKU', price: 'Price', qr: 'QR code', barcode: 'Barcode',
    productImage: 'Product image', logo: 'Logo', image: 'Image', cert: 'Cert badge',
    date: 'Date', country: 'Country', rect: 'Rectangle', colorbar: 'Color bar', divider: 'Divider' }[el?.type] || el?.type || 'Element';
  const value = el?.manualValue || el?.field;
  return value ? `${type} · ${value}` : type;
}
