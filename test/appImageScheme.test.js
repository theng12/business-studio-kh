/**
 * The `app-image` scheme must stay CORS-enabled.
 *
 * WHY THIS EXISTS. Found 2026-09-22: the renderer runs at `app://local` and
 * images live at `app-image://local` — different origins. `<img>` tags don't
 * care, so every thumbnail in the app looked fine, but `fetch()` does: Chromium
 * will not even attempt a cross-origin request to a scheme that is not
 * registered as CORS-enabled and fails it with
 *
 *   Access to fetch at 'app-image://local/…' from origin 'app://local' has been
 *   blocked by CORS policy: Cross origin requests are only supported for
 *   protocol schemes: app, chrome, chrome-extension, chrome-untrusted, data,
 *   http, https.
 *
 * The one caller that reads pixels is background removal
 * (`renderer/lib/bgRemoval.js` → `fetchImageBlob`), which is ON by default in
 * the Image Workspace. So "Apply to this image" died with a bare
 * "Failed to fetch" while the preview next to it rendered perfectly — a bug
 * that no unit test and no eyeballing of the UI would catch. The `corsEnabled`
 * privilege on the scheme is the whole fix; an `Access-Control-Allow-Origin`
 * response header is NOT needed (measured with scripts/probe-app-image-cors.js,
 * which is the real end-to-end check and needs a BrowserWindow:
 * `npm run check:images`).
 *
 * This test is the always-on half: it reads main/index.js and fails if anyone
 * trims that privilege off. A future refactor that moves scheme registration
 * somewhere else should move this assertion with it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = path.join(__dirname, '..', 'main', 'index.js');

/** Pull the privileges object registered for one scheme out of index.js. */
function privilegesFor(source, scheme) {
  const at = source.indexOf(`scheme: '${scheme}'`);
  assert.notEqual(at, -1, `main/index.js no longer registers the '${scheme}' scheme`);
  const next = source.indexOf('privileges:', at);
  assert.notEqual(next, -1, `no privileges block after scheme: '${scheme}'`);
  const open = source.indexOf('{', next);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced privileges block for scheme: '${scheme}'`);
}

test('app-image is registered CORS-enabled (renderer fetch of image bytes)', () => {
  const source = fs.readFileSync(INDEX, 'utf8');
  const privileges = privilegesFor(source, 'app-image');
  assert.match(privileges, /\bcorsEnabled:\s*true\b/,
    'app-image must stay corsEnabled: true — without it background removal (and anything else that fetch()es image bytes) fails with "Failed to fetch". See scripts/probe-app-image-cors.js.');
  assert.match(privileges, /\bstandard:\s*true\b/, 'app-image must stay a standard scheme');
  assert.match(privileges, /\bsupportFetchAPI:\s*true\b/, 'app-image must keep supportFetchAPI for fetch() to be allowed at all');
});

test('the renderer protocol stays CORS-enabled too', () => {
  const source = fs.readFileSync(INDEX, 'utf8');
  const privileges = privilegesFor(source, 'app');
  assert.match(privileges, /\bcorsEnabled:\s*true\b/,
    'app:// carries the renderer origin and the blob: URLs the ONNX/WASM backends import');
});
