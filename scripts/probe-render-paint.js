/**
 * Guards the "text is missing from the exported image" bug (fixed v0.1.25).
 *
 * WHAT IT CHECKS. `withWindow()` must not let anyone capture pixels until the
 * document has actually been PAINTED. `document.fonts.ready` is not enough: it
 * resolves when fonts finish LOADING, while the paint that uses them lands in a
 * later frame, and `capturePage()` reads the last committed frame.
 *
 * The failure is easy to miss because it is invisible in most documents. It
 * shows up when a page embeds a web font — which `embeddedFontCss()` does as
 * soon as any text is non-ASCII, e.g. a Khmer product name — and it takes out
 * whichever element needs an extra layout pass. In the original report the
 * product NAME vanished from a Social Grid PNG while the PRICE next to it was
 * fine, because the name is clamped with `-webkit-line-clamp`.
 *
 * Measured on the same page before the fix: 0 dark pixels in the name band.
 * After: 2248.
 *
 * WHY A SCRIPT AND NOT `npm test`. This needs a real BrowserWindow, which
 * means a real Electron app process. The unit suite runs under plain Node, and
 * `test:native` runs Electron in ELECTRON_RUN_AS_NODE mode — where the Electron
 * APIs do not exist at all. So this runs as its own Electron process:
 *
 *     npm run check:render
 *
 * Exits non-zero on failure, so it is safe to wire into CI. The PNGs land in
 * /tmp/msr-*.png for eyeballing when it does fail.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const sharp = require('sharp');
const renderUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-render-userdata-'));
app.setPath('userData', renderUserDataDir);
process.on('exit', () => {
  try { fs.rmSync(renderUserDataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

// The asset resolver reaches for the configured data folder; this script has no
// database, so give it an empty one. Every image below is supplied inline.
require.cache[require.resolve(path.join(ROOT, 'main/db'))] = {
  exports: { getDataDir: () => path.join(renderUserDataDir, 'data') },
};

const { buildPageHtml, } = require(path.join(ROOT, 'main/socialGridRenderer'));
const { normalizeConfig } = require(path.join(ROOT, 'main/util/socialGridModel'));
const { embeddedFontCss } = require(path.join(ROOT, 'main/studioRenderer'));
const { withWindow } = require(path.join(ROOT, 'main/renderWindow'));

// Stands in for a real product photo. It must be BIG — a 1x1 pixel does not
// reproduce the bug at all, because the page then paints fast enough that an
// early capture still catches everything. The original report carried a
// ~177 KB base64 JPEG per tile, so this generates random noise at a similar
// size: noise compresses badly, which is the point.
let PHOTO = '';
function buildPhoto() {
  const side = 900;
  const raw = Buffer.alloc(side * side * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) % 251;
  return sharp(raw, { raw: { width: side, height: side, channels: 3 } })
    .jpeg({ quality: 72 })
    .toBuffer()
    .then((buf) => `data:image/jpeg;base64,${buf.toString('base64')}`);
}

const ASCII_PRODUCT = {
  id: '1', sku: 'DEMO-001', name: 'Khmer Ceramic Bowl', priceRetail: 12.5,
  stockQty: 25, prices: {}, brandId: null, mainImagePath: 'photo.jpg',
};
// A Khmer name is what forces the font embedding that triggers the bug.
const KHMER_NAME = '\u1785\u17b6\u1793\u179f\u17c1\u179a\u17c9\u17b6\u1798\u17b7\u1785\u1781\u17d2\u1798\u17c2\u179a';
const KHMER_PRODUCT = {
  id: '2', sku: 'DEMO-KH', name: KHMER_NAME, priceRetail: null,
  stockQty: 0, prices: {}, brandId: null, mainImagePath: null,
};

/** Dark pixels in the first tile's name band (y 282..315, x 54..349 at 3x3). */
function namePixels(png) {
  return sharp(png).raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => {
    let n = 0;
    for (let y = 282; y < 315; y += 1) {
      for (let x = 54; x < 349; x += 1) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) n += 1;
      }
    }
    return n;
  });
}

async function render(products) {
  const config = normalizeConfig({ columns: 3, rows: 3, showName: true, showPrice: true });
  const html = buildPageHtml({
    products, brands: [], config, pageIndex: 0, pageCount: 1, resolveImage: () => PHOTO,
  });
  return withWindow(html, { width: 1080, height: 1080, zoomFactor: 1 },
    (win) => win.webContents.capturePage().then((img) => img.toPNG()));
}

app.on('window-all-closed', () => { /* stay alive between renders */ });

app.whenReady().then(async () => {
  PHOTO = await buildPhoto();
  console.log(`photo: ${Math.round(PHOTO.length / 1024)} KB of base64 (a real product photo, not a 1x1 pixel)\n`);
  const cases = [
    ['ascii-only', [ASCII_PRODUCT], false],
    ['with-khmer-name', [ASCII_PRODUCT, KHMER_PRODUCT], true],
  ];
  let failed = 0;

  for (const [label, products, fontsExpected] of cases) {
    const fontCss = embeddedFontCss(products.map((p) => p.name).join(' ')).length;
    const png = await render(products);
    fs.writeFileSync(path.join(os.tmpdir(), `msr-${label}.png`), png);
    const dark = await namePixels(png);

    // Guard the guard: if the font CSS stops being emitted, this case is no
    // longer exercising the code path the bug lived in, and a pass is hollow.
    if (fontsExpected && fontCss === 0) {
      console.log(`FAIL ${label}: expected embedded font CSS (non-ASCII text), got none — this case no longer tests anything`);
      failed += 1;
      continue;
    }
    if (dark < 200) {
      console.log(`FAIL ${label}: product name missing from the render (${dark} dark pixels in the name band; expected 200+). See ${os.tmpdir()}/msr-${label}.png`);
      failed += 1;
    } else {
      console.log(`ok   ${label}: name rendered (${dark} dark pixels, ${fontCss} bytes of font CSS)`);
    }
  }

  if (failed) console.log(`\n${failed} render check(s) FAILED — the product name is not reaching the painted frame.`);
  else console.log('\nRender check passed: text survives the capture with web fonts embedded.');
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.log('FATAL:', (e && e.stack) || e);
  app.exit(1);
});
