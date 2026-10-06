// Parse a "w:h" string into a numeric ratio (w/h). Accepts ':' / 'x' / '/'
// separators. Returns null on bad input or 'free'.
export function parseAspectRatio(str) {
  if (typeof str === 'string' && str.startsWith('custom-')) str = str.slice(7);
  if (!str || str === 'free') return null;
  const m = String(str).match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  return w / h;
}

// A 1:1 output crop on a non-square source needs a non-square normalised rect to
// compensate. This helper converts "user wants output to be ratio R" into
// "rect.width / rect.height should be N" in normalised-source terms.
export function rectAspectFromOutput(outputAspect, sourceW, sourceH) {
  if (!outputAspect || !sourceW || !sourceH) return null;
  return outputAspect * (sourceH / sourceW);
}



// Given anchor + current pointer (both in normalised source coords) and
// an optional aspect lock, build a rect. For free mode this is just the
// drag bounding box. For ratio mode the larger axis of the drag wins and
// the other dimension is derived from ratio; the rect stays anchored at
// the original mousedown point so the drag still feels direct.
export function buildDragRect(anchor, current, rectAspectVal) {
  let w = Math.abs(current.x - anchor.x);
  let h = Math.abs(current.y - anchor.y);
  if (rectAspectVal) {
    // Pick the dimension the user dragged "more" of (normalised by the
    // ratio) and derive the other.
    if (w / rectAspectVal > h) h = w / rectAspectVal;
    else                       w = h * rectAspectVal;
  }
  // Anchor on whichever corner of the mousedown point the drag direction
  // implies.
  const x = current.x < anchor.x ? anchor.x - w : anchor.x;
  const y = current.y < anchor.y ? anchor.y - h : anchor.y;
  return clampRect({ x, y, width: Math.max(0.02, w), height: Math.max(0.02, h) }, rectAspectVal);
}

// Keep the whole rect in the source bounds, preserving the aspect lock.
export function clampRect(r, aspect) {
  if (aspect) {
    let width = Math.max(0.02, r.width), height = width / aspect;
    const scale = Math.min(1, 1 / width, 1 / height);
    width *= scale; height *= scale;
    return { x: Math.max(0, Math.min(1 - width, r.x)), y: Math.max(0, Math.min(1 - height, r.y)), width, height };
  }
  let { x, y, width, height } = r;
  if (x < 0) { width += x; x = 0; }
  if (y < 0) { height += y; y = 0; }
  if (x + width > 1)  width  = 1 - x;
  if (y + height > 1) height = 1 - y;
  width  = Math.max(0.02, Math.min(1, width));
  height = Math.max(0.02, Math.min(1, height));
  x = Math.max(0, Math.min(1 - width, x));
  y = Math.max(0, Math.min(1 - height, y));
  return { x, y, width, height };
}

// v0.49.16: unified resize for both corner (nw/ne/sw/se, 2 chars) and edge
// (n/s/e/w, 1 char) handles. Corner: opposite corner stays anchored.
// Edge: opposite edge stays anchored, perpendicular dim recenters around
// the rect\'s old center. Ratio lock applies in both modes.
export function resize(origin, handle, current, rectAspectVal) {
  const isCorner = handle.length === 2;
  if (isCorner) {
    const ox1 = origin.x, oy1 = origin.y;
    const ox2 = origin.x + origin.width, oy2 = origin.y + origin.height;
    const anchorX = handle.includes('w') ? ox2 : ox1;
    const anchorY = handle.includes('n') ? oy2 : oy1;
    let w = Math.max(0.02, Math.abs(current.x - anchorX));
    let h = Math.max(0.02, Math.abs(current.y - anchorY));
    if (rectAspectVal) {
      if (w / rectAspectVal > h) h = w / rectAspectVal;
      else                       w = h * rectAspectVal;
    }
    const x = handle.includes('w') ? anchorX - w : anchorX;
    const y = handle.includes('n') ? anchorY - h : anchorY;
    return clampRect({ x, y, width: w, height: h }, rectAspectVal);
  }
  // Edge handle. cx/cy = rect center; used to recenter the perpendicular
  // axis when ratio is locked.
  const cx = origin.x + origin.width / 2;
  const cy = origin.y + origin.height / 2;
  let x1 = origin.x, y1 = origin.y;
  let x2 = origin.x + origin.width, y2 = origin.y + origin.height;
  if (handle === 'n') y1 = Math.max(0, Math.min(y2 - 0.02, current.y));
  if (handle === 's') y2 = Math.min(1, Math.max(y1 + 0.02, current.y));
  if (handle === 'w') x1 = Math.max(0, Math.min(x2 - 0.02, current.x));
  if (handle === 'e') x2 = Math.min(1, Math.max(x1 + 0.02, current.x));
  let rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  if (rectAspectVal) {
    if (handle === 'n' || handle === 's') {
      const w = Math.min(1, rect.height * rectAspectVal);
      rect.x = Math.max(0, Math.min(1 - w, cx - w / 2));
      rect.width = w;
    } else {
      const h = Math.min(1, rect.width / rectAspectVal);
      rect.y = Math.max(0, Math.min(1 - h, cy - h / 2));
      rect.height = h;
    }
  }
  return clampRect(rect, rectAspectVal);
}

// Shift a rect by a normalised delta, keeping it inside [0,1].
export function moveRect(rect, dx, dy) {
  const x = Math.max(0, Math.min(1 - rect.width,  rect.x + dx));
  const y = Math.max(0, Math.min(1 - rect.height, rect.y + dy));
  return { ...rect, x, y };
}

export function containedImageBounds(imageW, imageH, boxW, boxH) {
  if (!imageW || !imageH || !boxW || !boxH) return null;
  const scale = Math.min(boxW / imageW, boxH / imageH);
  const width = imageW * scale, height = imageH * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

export function reshapeCropRect(rect, outputAspect, W, H) {
  if (!rect || !outputAspect || !W || !H) return rect;
  const aspect = rectAspectFromOutput(outputAspect, W, H);
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  let width = Math.max(rect.width, rect.height * aspect), height = width / aspect;
  const scale = Math.min(1, 1 / width, 1 / height);
  width *= scale; height *= scale;
  return { x: Math.max(0, Math.min(1 - width, cx - width / 2)), y: Math.max(0, Math.min(1 - height, cy - height / 2)), width, height };
}
