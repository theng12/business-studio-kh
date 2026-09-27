/**
 * v0.1.81 — Social Grid overlays (the anti-theft watermark).
 *
 * The Overlay Studio has had per-element opacity all along; the Social Grid had
 * no way to put anything over the grid at all, so a post could not carry a
 * faint handle or logo. These tests pin the two halves that matter:
 *
 *   1. What a stored overlay is allowed to be — an empty one is dropped rather
 *      than drawn invisibly, every number is clamped, and a preset written by an
 *      older build (no `overlays` key at all) still renders.
 *   2. What the markup actually says — the opacity, the rotation, the anchor's
 *      alignment, and that user text cannot escape into markup.
 *
 * Pure: `buildPageHtml` returns a string and the model has no dependencies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeConfig, normalizeOverlays, OVERLAY_ANCHORS, MAX_OVERLAYS } = require('../main/util/socialGridModel.js');
const { buildPageHtml } = require('../main/socialGridRenderer.js');

const render = (config) => buildPageHtml({
  products: [], brands: [], pageIndex: 0, pageCount: 1,
  resolveImage: (rel) => (rel ? `data:image/png;base64,${rel}` : ''),
  config,
});

test('an overlay with nothing to draw is dropped, not kept as an invisible row', () => {
  assert.deepEqual(normalizeOverlays(undefined), []);
  assert.deepEqual(normalizeOverlays('nonsense'), []);
  assert.deepEqual(normalizeOverlays([null, 7, 'text']), []);
  assert.deepEqual(normalizeOverlays([{ type: 'text', text: '   ' }]), [], 'whitespace-only text');
  assert.deepEqual(normalizeOverlays([{ type: 'image' }]), [], 'an image with no file');
  assert.equal(normalizeOverlays([{ type: 'text', text: '@shop' }]).length, 1);
});

test('every overlay number is clamped to something the renderer can draw', () => {
  const [o] = normalizeOverlays([{
    type: 'text', text: '@shop',
    opacity: 9, rotation: 400, size: 99999, weight: 5, anchor: 'nope',
    offsetX: -1e9, offsetY: 1e9, color: 'javascript:alert(1)',
  }]);
  assert.equal(o.opacity, 1, 'opacity is 0..1');
  assert.equal(o.rotation, 180);
  assert.equal(o.size, 3000);
  assert.equal(o.weight, 100, 'a weight the browser understands');
  assert.equal(o.anchor, 'br', 'an unknown anchor falls back to bottom-right');
  assert.equal(o.offsetX, -4000);
  assert.equal(o.offsetY, 4000);
  assert.equal(o.color, '#0f172a', 'a colour that is not a hex value is refused');
});

test('a dark-transparent watermark is what the ask was about', () => {
  const [o] = normalizeOverlays([{ type: 'text', text: '@gracecosmetics', opacity: 0.3, anchor: 'cc', rotation: -30 }]);
  assert.equal(o.opacity, 0.3, 'opacity survives normalization — the whole point');
  assert.equal(o.rotation, -30);
  assert.equal(o.anchor, 'cc');
});

test('a preset saved before overlays existed still renders', () => {
  const config = normalizeConfig({ title: 'Old preset', columns: 3, rows: 3 });
  assert.deepEqual(config.overlays, [], 'no overlays key means none, not a crash');
  const html = render(config);
  assert.doesNotMatch(html, /<div class="overlay-layer"/, 'nothing is drawn when there is nothing to draw');
});

test('the markup carries opacity, rotation, size and the anchor alignment', () => {
  const html = render({
    overlays: [
      { type: 'text', text: '@shop', anchor: 'br', size: 40, opacity: 0.25, rotation: -20, color: '#ff0000', weight: 800 },
      { type: 'image', src: 'watermarks/logo.png', anchor: 'cc', size: 300, opacity: 0.15 },
    ],
  });
  assert.match(html, /overlay-layer/);
  assert.match(html, /opacity:0\.25/, 'the text mark is a quarter opaque');
  assert.match(html, /rotate\(-20deg\)/);
  assert.match(html, /font-size:40px/);
  assert.match(html, /color:#ff0000/);
  // Anchored, not free-floating: bottom-right hangs inward, centre is centred.
  assert.match(html, /right:0;bottom:0/);
  assert.match(html, /translate\(0px, 0px\) translate\(0, 0\) rotate\(-20deg\)/,
    'a bottom-right mark needs no pull-back: its own right/bottom edge is the anchor');
  assert.match(html, /left:50%;top:50%/, 'the logo is centred');
  assert.match(html, /translate\(-50%, -50%\)/, 'a centred mark is pulled back by half itself');
  assert.match(html, /ov--image[^>]*width:300px/);
  assert.match(html, /data:image\/png;base64,watermarks\/logo\.png/, 'the artwork is inlined as a data URI');
});

test('overlay text cannot escape into markup', () => {
  const html = render({ overlays: [{ type: 'text', text: '<img src=x onerror=alert(1)>', anchor: 'tl' }] });
  assert.doesNotMatch(html, /<img src=x/, 'the tag is escaped, not injected');
  assert.match(html, /&lt;img src=x/);
});

test('an overlay image that is missing from disk is skipped, not drawn broken', () => {
  const html = buildPageHtml({
    products: [], brands: [], pageIndex: 0, pageCount: 1,
    resolveImage: () => '',                       // assetDataUri found no file
    config: { overlays: [{ type: 'image', src: 'watermarks/gone.png', anchor: 'cc', size: 200 }] },
  });
  assert.doesNotMatch(html, /<div class="overlay-layer"/, 'an unreadable logo leaves no empty layer behind');
});

test('the list is capped, and the cap is the model’s not the UI’s', () => {
  const many = Array.from({ length: MAX_OVERLAYS + 5 }, (_, i) => ({ type: 'text', text: `@mark${i}` }));
  assert.equal(normalizeOverlays(many).length, MAX_OVERLAYS);
});

test('every anchor the editor offers is one the model accepts', () => {
  for (const anchor of OVERLAY_ANCHORS) {
    const [o] = normalizeOverlays([{ type: 'text', text: 'x', anchor }]);
    assert.equal(o.anchor, anchor, `${anchor} survives normalization`);
  }
  assert.equal(OVERLAY_ANCHORS.length, 9, 'a 3x3 grid — the editor draws 9 buttons');
});
