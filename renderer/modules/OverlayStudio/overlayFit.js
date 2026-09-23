/**
 * v0.1.71 — the one artwork-fit rule, shared by the Overlay Studio editor.
 *
 * The renderer (main/templateRenderer.js) resizes a photo into its element box
 * with `sharp.resize(..., { fit: 'contain' })` — contained, never stretched.
 * The editor draws plain `<img>`s, so it has to apply the SAME rule or a photo
 * whose aspect differs from its box looks stretched. This module is the single
 * place that maps an element (or the canvas backdrop) to a CSS `object-fit`.
 *
 * `contain` is the default, matching the renderer. A future/tuned element may
 * carry `fit: 'cover'` (e.g. a photo element that should crop to fill its
 * box); the editor and the renderer both read it, so they stay in step.
 *
 * Pure and DOM-free so it can be unit-tested — see
 * test/overlayArtworkFit.test.js.
 */

/**
 * object-fit values the editor understands (and the renderer can honour).
 * `fill` (true stretch) is data-only: no Overlay Studio control can set an
 * element's `fit`, and nothing defaults to it — a hand-tuned template can
 * opt in explicitly, which the editor and renderer both then honour.
 */
export const FIT_VALUES = ['contain', 'cover', 'fill'];

/** The element's chosen fit, or `contain` when it has none / an unknown one. */
export function fitForElement(element) {
  const fit = element?.fit;
  return FIT_VALUES.includes(fit) ? fit : 'contain';
}

/** The canvas backdrop is never stretched: it is contained in the canvas box. */
export const BACKDROP_FIT = 'contain';

/** The inset margin's blurred copy COVERS the canvas, exactly like reframe.js. */
export const INSET_BLUR_FIT = 'cover';

/** The inset foreground is contained inside its square bound (fit: 'inside'). */
export const INSET_FOREGROUND_FIT = 'contain';

/**
 * The sharp fit that matches a CSS object-fit. `fill` stretches (sharp's own
 * `fill`); everything else the editor offers maps 1:1. Used by
 * main/templateRenderer.js so the export and the editor agree on a `cover`
 * image element.
 */
export function sharpFitForElement(element) {
  return fitForElement(element);
}
