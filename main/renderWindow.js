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
async function withWindow(html, options, task) {
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
  const tmpPath = path.join(os.tmpdir(), `msk-render-${crypto.randomUUID()}.html`);
  try {
    if (options?.zoomFactor) win.webContents.setZoomFactor(options.zoomFactor);
    await fs.promises.writeFile(tmpPath, html, 'utf8');
    await win.loadURL(pathToFileURL(tmpPath).toString());
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    await waitForPaint(win);
    return await task(win);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try { await fs.promises.unlink(tmpPath); } catch (_) { /* best effort */ }
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
  }));
}

async function toPdf(html, outputPath, options = {}) {
  const bytes = await toPdfBuffer(html, options);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, bytes);
  return outputPath;
}

async function toImage(html, outputPath, options = {}) {
  return withWindow(html, options, async (win) => {
    const image = await win.webContents.capturePage();
    const bytes = options.format === 'jpeg' ? image.toJPEG(options.quality || 92) : image.toPNG();
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, bytes);
    return outputPath;
  });
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
module.exports = { toPdf, toPdfBuffer, toImage, listPrinters, printHtml, withWindow };
