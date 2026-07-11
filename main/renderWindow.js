const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

async function withWindow(html, options, task) {
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    frame: false,
    width: options?.width || 1200,
    height: options?.height || 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    if (options?.zoomFactor) win.webContents.setZoomFactor(options.zoomFactor);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true');
    return await task(win);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function toPdf(html, outputPath, options = {}) {
  const bytes = await withWindow(html, options, (win) => win.webContents.printToPDF({
    printBackground: true, preferCSSPageSize: true, landscape: options.orientation === 'landscape',
  }));
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

module.exports = { toPdf, toImage, listPrinters, printHtml };
