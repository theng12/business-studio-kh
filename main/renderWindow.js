const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { BrowserWindow } = require('electron');

/**
 * v0.1.21: render offscreen HTML and hand the window to `task`.
 *
 * The document is written to a temp file and loaded from there, NOT passed as a
 * `data:text/html,<encoded>` URL. That was the old approach and it silently
 * capped how big a document could be: Chromium rejects an over-long URL outright
 * with `ERR_INVALID_URL (-300)`. It only bites when the content is large, and
 * the place it bites is catalogs — a catalog inlines every product image as a
 * base64 data URI, so a two-product project already produced a 2.1 MB document
 * and **every catalog PDF export failed**, in standalone and server mode alike.
 * Labels stayed under the limit, which is why this went unnoticed.
 *
 * A temp file has no such limit, and it costs one write and one unlink per
 * render. The document is self-contained either way — fonts, images and styles
 * are all inlined by the renderer that builds it — so nothing depends on where
 * it is loaded from.
 */
function createRenderWindow(options) {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    frame: false,
    width: options?.width || 1200,
    height: options?.height || 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // v0.1.25: hidden windows are background-throttled by Chromium, which can
  // stall the animation frames `waitForPaint()` below depends on. Nothing is
  // being conserved here — the window lives for milliseconds.
  win.webContents.setBackgroundThrottling(false);
  return win;
}

/**
 * Load `html` into `win`, wait until it is painted, run `task(win)`. The temp
 * file outlives the task, as it always has, and is removed afterwards.
 */
async function renderIn(win, html, options, task) {
  const tmpPath = path.join(os.tmpdir(), `msk-render-${crypto.randomUUID()}.html`);
  try {
    if (options?.zoomFactor) win.webContents.setZoomFactor(options.zoomFactor);
    await fs.promises.writeFile(tmpPath, html, 'utf8');
    await win.loadURL(pathToFileURL(tmpPath).toString());
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    await waitForPaint(win);
    return await task(win);
  } finally {
    try { await fs.promises.unlink(tmpPath); } catch (_) { /* best effort */ }
  }
}

async function withWindow(html, options, task) {
  const win = createRenderWindow(options);
  try {
    return await renderIn(win, html, options, task);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * One offscreen window for a run of same-sized documents.
 *
 * `body` receives `render(html, task)`, which loads `html` into the shared
 * window exactly as `withWindow` would (same size, zoom, font and paint
 * waits) and hands the window to `task`. A per-label image export used to
 * create and destroy a BrowserWindow — a new renderer process — for every
 * label; a batch now pays for that once. Every document must want the
 * window `options` describe: the size is fixed for the run.
 */
async function withReusedWindow(options, body) {
  const win = createRenderWindow(options);
  try {
    return await body((html, task) => renderIn(win, html, options, task));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * v0.1.25: wait until the document has actually been PAINTED, not merely
 * loaded, before anyone captures pixels.
 *
 * WHY THIS EXISTS. `document.fonts.ready` resolves when the fonts have
 * finished loading — but the browser still has to lay out and paint the text
 * with them, and `capturePage()` reads the last committed frame. Those are not
 * the same moment. When a document embeds a web font, the capture could land
 * in the gap, and whatever had not been repainted yet was simply missing from
 * the exported image.
 *
 * It was found in Social Grid: a grid whose page contained one Khmer product
 * name embedded 1.97 MB of font CSS (see `embeddedFontCss`), and the product
 * NAME disappeared from the exported PNG while the PRICE right beside it
 * rendered fine. The name is the element that needs an extra layout pass
 * because of `-webkit-line-clamp`, so it was the one left unpainted when the
 * frame was grabbed early. Measured, on the same page: 0 dark pixels in the
 * name band before this fix, 2248 after.
 *
 * This is not a Social Grid bug. Any image export with non-ASCII text can hit
 * it — labels in Khmer or Thai included — which is why the wait lives here, in
 * the one place every image path goes through, rather than in the grid code.
 *
 * Two animation frames are the standard way to ask for "the next committed
 * frame": a single rAF callback runs BEFORE paint, so waiting on one only gets
 * you to the frame you are trying to avoid. The timeout is a safety net — a
 * render must never hang because a frame did not arrive — and it is a
 * fallback, not the mechanism.
 */
function waitForPaint(win) {
  const frames = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(finish, 1500);
    if (win.isDestroyed()) { clearTimeout(timer); finish(); return; }
    win.webContents.executeJavaScript(frames)
      .then(() => { clearTimeout(timer); finish(); })
      .catch(() => { clearTimeout(timer); finish(); });
  });
}

/**
 * v0.1.21: the PDF bytes, without writing a file.
 *
 * Split out of `toPdf` for client mode: when the data lives on a server Mac but
 * the user wants the file on THIS Mac, the rendering has to happen where the
 * images are and only the finished PDF travels. Returning bytes lets the caller
 * decide where they land.
 */
async function toPdfBuffer(html, options = {}) {
  return withWindow(html, options, (win) => win.webContents.printToPDF({
    printBackground: true, preferCSSPageSize: true, landscape: options.orientation === 'landscape',
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    ...(options.margins ? { margins: options.margins } : {}),
    ...(options.displayHeaderFooter ? { displayHeaderFooter: true, headerTemplate: options.headerTemplate, footerTemplate: options.footerTemplate } : {}),
  }));
}

async function toPdf(html, outputPath, options = {}) {
  const bytes = await toPdfBuffer(html, options);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, bytes);
  return outputPath;
}

/**
 * The target size and density for a captured image, or null to keep the raw
 * capture. Pure, so test/labelCatalog.test.js can pin it.
 *
 * `capturePage()` returns DEVICE pixels: on a Retina Mac a 60×40 mm label at
 * 203 dpi came out at twice the size it does on a plain screen, so the same
 * export differed per Mac. The window is sized `width`×`height` CSS pixels for
 * exactly the label's mm at the chosen dpi, so that is the size the file must
 * have. The density is the dpi (`dpi`, or `zoomFactor × 96` for a caller that
 * only passes the zoom — client mode does), so a label printer or layout app
 * places the image at its true physical size.
 */
function captureTarget(options = {}) {
  const width = Math.round(Number(options.width));
  const height = Math.round(Number(options.height));
  if (!(width > 0) || !(height > 0)) return null;
  const dpi = Number(options.dpi) || (Number(options.zoomFactor) ? Number(options.zoomFactor) * 96 : 0);
  return { width, height, density: dpi > 0 ? Math.round(dpi) : null };
}

async function captureImage(win, outputPath, options = {}) {
  const image = await win.webContents.capturePage();
  const target = captureTarget(options);
  let bytes;
  if (target) {
    // Same normalisation Social Grid does (main/ipc/socialGrid.js): resize the
    // capture to the exact pixel size with sharp. `fill` cannot distort — the
    // capture has the target's aspect ratio, only its scale differs.
    const sharp = require('sharp');
    let pipeline = sharp(image.toPNG()).resize(target.width, target.height, { fit: 'fill' });
    if (target.density) pipeline = pipeline.withMetadata({ density: target.density });
    bytes = options.format === 'jpeg'
      ? await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: options.quality || 92 }).toBuffer()
      : await pipeline.png().toBuffer();
  } else {
    bytes = options.format === 'jpeg' ? image.toJPEG(options.quality || 92) : image.toPNG();
  }
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, bytes);
  return outputPath;
}

async function toImage(html, outputPath, options = {}) {
  return withWindow(html, options, (win) => captureImage(win, outputPath, options));
}

/**
 * Several image files, one window. `next(i)` resolves the i-th job as
 * `{ html, outputPath }` and is called just before it renders, so only one
 * document is in memory at a time; `onDone(i, outputPath)` follows each
 * write. Same output as calling `toImage` per job with the same `options`.
 */
async function toImages(count, next, options = {}, onDone = null) {
  const written = [];
  await withReusedWindow(options, async (render) => {
    for (let i = 0; i < count; i += 1) {
      const { html, outputPath } = await next(i);
      written.push(await render(html, (win) => captureImage(win, outputPath, options)));
      if (onDone) onDone(i, outputPath);
    }
  });
  return written;
}

async function listPrinters() {
  return withWindow('<html></html>', {}, (win) => win.webContents.getPrintersAsync());
}

async function printHtml(html, options = {}) {
  return withWindow(html, {}, (win) => new Promise((resolve, reject) => {
    win.webContents.print({ silent: !!options.silent, deviceName: options.deviceName || '',
      printBackground: true, copies: Math.max(1, Number(options.copies) || 1) }, (ok, reason) => {
      if (ok) resolve({ ok: true }); else reject(new Error(reason || 'Printing failed'));
    });
  }));
}

/* v0.1.25: `withWindow` is exported for Social Grid, which needs to capture in
 * memory and then hand the raw pixels to sharp for exact-size normalization.
 * Going through toImage() would mean writing a temp PNG, reading it back and
 * deleting it — a file round-trip per image, for no benefit. */
module.exports = { toPdf, toPdfBuffer, toImage, toImages, listPrinters, printHtml, withWindow, withReusedWindow, captureTarget };
