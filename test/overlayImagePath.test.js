/**
 * v0.1.4: regression tests for the Overlay Studio canvas image-path rule.
 *
 * Background — this is a two-sided path convention and getting it wrong
 * fails SILENTLY (the element just renders empty, with no error):
 *
 *   - Stored asset paths carry an `assets/` prefix. `brands.icon` and
 *     `productImages.filepath` are stored as e.g.
 *     "assets/KT/ROYAL/001.jpg" (see the header comment in
 *     main/db/productImages.js), and `imageManager.importAsset` returns a
 *     kind-prefixed path WITHOUT it (e.g. "watermarks/logo.png").
 *   - main/protocol.js resolves an `app-image://local/<p>` URL as
 *     `path.join(<dataDir>/assets, <p>)` — so `<p>` must NOT carry its own
 *     `assets/` prefix.
 *
 * The canvas resolver used to pass the prefixed value straight through, so
 * brand-icon and product-image elements produced
 * `<dataDir>/assets/assets/…` and 404'd on the canvas, while the exported
 * PNG (whose server-side renderer joins `assets/` itself) was correct.
 *
 * The resolver lives in a JSX module that can't be required from plain
 * Node (and isn't exported), so this mirrors its transform. If that
 * function changes, change this test with it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/** Mirror of stripAssetsPrefix() in renderer/modules/OverlayStudio/EditorCanvas.jsx */
function stripAssetsPrefix(rel) {
  return String(rel).replace(/^\/?assets\//, '');
}

/**
 * Mirror of resolveImageSrc() in the same file. Mirrors only the URL
 * construction, which is the part this test is about.
 */
function resolveImageSrc(source, ctx) {
  if (!source || !ctx) return null;
  if (source === 'brand-icon' && ctx.brandIcon) {
    return `app-image://local/${encodeURIComponent(stripAssetsPrefix(ctx.brandIcon))}`;
  }
  if (source.startsWith('product-image:')) {
    const idx = Number(source.split(':')[1] ?? 0);
    const img = ctx.productImages?.[idx];
    if (img?.filepath) return `app-image://local/${encodeURIComponent(stripAssetsPrefix(img.filepath))}`;
  }
  if (source.startsWith('asset:')) {
    const rel = source.slice('asset:'.length);
    if (rel) return `app-image://local/${encodeURIComponent(stripAssetsPrefix(rel))}`;
  }
  return null;
}

/** Mirror of the non-`processed/` branch of main/protocol.js. */
function protocolResolve(dataDir, decoded) {
  const assetsRoot = path.normalize(path.join(dataDir, 'assets'));
  if (decoded.startsWith('processed/') || decoded.startsWith('ai-gallery/')) {
    return path.join(dataDir, decoded);
  }
  return path.join(assetsRoot, decoded);
}

/** Pull the decoded path back out of an app-image URL the way the protocol does. */
function decodedFromUrl(url) {
  return decodeURIComponent(url.replace(/^app-image:\/\/local\//, '').split('?')[0]);
}

const DATA_DIR = '/tmp/msk-data';

test('brand icon — stored with the assets/ prefix, resolved without it', () => {
  // brands.icon is stored relative to <dataDir>/assets/ but INCLUDES the
  // segment (seed/migration writes 'assets/brands/x.png').
  const ctx = { brandIcon: 'assets/brands/acme.png' };
  const url = resolveImageSrc('brand-icon', ctx);
  const abs = protocolResolve(DATA_DIR, decodedFromUrl(url));
  assert.equal(abs, path.join(DATA_DIR, 'assets', 'brands', 'acme.png'));
  assert.ok(!abs.includes(`${path.sep}assets${path.sep}assets${path.sep}`), 'must not double the assets segment');
});

test('product image — same convention as brand icon', () => {
  const ctx = { productImages: [{ filepath: 'assets/KT-Ceramic/ROYAL/BF-1/001.jpg' }] };
  const url = resolveImageSrc('product-image:0', ctx);
  const abs = protocolResolve(DATA_DIR, decodedFromUrl(url));
  assert.equal(abs, path.join(DATA_DIR, 'assets', 'KT-Ceramic/ROYAL/BF-1/001.jpg'));
});

test('imported asset — returned by importAsset without a prefix, still resolves', () => {
  // imageManager.importAsset returns `watermarks/my-logo.png`.
  const ctx = { productImages: [] };
  const url = resolveImageSrc('asset:watermarks/my-logo.png', ctx);
  const abs = protocolResolve(DATA_DIR, decodedFromUrl(url));
  assert.equal(abs, path.join(DATA_DIR, 'assets', 'watermarks', 'my-logo.png'));
});

test('imported asset — tolerates a value that DOES carry the prefix', () => {
  // Defensive: an older/alternate writer might store the prefixed form.
  const url = resolveImageSrc('asset:assets/watermarks/my-logo.png', {});
  const abs = protocolResolve(DATA_DIR, decodedFromUrl(url));
  assert.equal(abs, path.join(DATA_DIR, 'assets', 'watermarks', 'my-logo.png'));
});

test('both conventions land on the SAME absolute path', () => {
  const withPrefix = protocolResolve(DATA_DIR, decodedFromUrl(resolveImageSrc('asset:assets/w/a.png', {})));
  const withoutPrefix = protocolResolve(DATA_DIR, decodedFromUrl(resolveImageSrc('asset:w/a.png', {})));
  assert.equal(withPrefix, withoutPrefix);
});

test('missing / unknown sources resolve to null rather than a bad path', () => {
  assert.equal(resolveImageSrc(null, {}), null);
  assert.equal(resolveImageSrc('brand-icon', {}), null);
  assert.equal(resolveImageSrc('product-image:7', { productImages: [] }), null);
  assert.equal(resolveImageSrc('asset:', {}), null);
});

test('leading slash is also normalised', () => {
  assert.equal(stripAssetsPrefix('/assets/brands/x.png'), 'brands/x.png');
  assert.equal(stripAssetsPrefix('assets/brands/x.png'), 'brands/x.png');
  assert.equal(stripAssetsPrefix('brands/x.png'), 'brands/x.png');
});
