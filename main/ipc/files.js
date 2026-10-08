/**
 * v0.21.1: files:* + samples:* IPC handlers, extracted from ipc.js.
 *
 * All local-only by definition — OS file pickers, spreadsheet
 * parsing on disk paths, thumbnail generation from absolute paths.
 * In client mode the same channel names are re-registered in
 * main/client/index.js so the dialog runs on the client's Mac.
 *
 * v0.1.17: these were registered with a bare `ipcMain.handle`, which meant
 * "local-only" also silently meant "unvalidated". They now go through
 * `exposeLocal()` — still local-only, but the argument shape is checked. The
 * absolute paths these handlers take are the reason it matters: see
 * `files:readImageThumb` below.
 */

const fs = require('node:fs');
const { dialog } = require('electron');
const { revealPath } = require('../util/openPath');
const fileHandler = require('../fileHandler');
const companies = require('../db/companies');
const productsDb = require('../db/products');
// v0.1.18: the accepted file kinds live in a shared module because the
// VALIDATORS enforce the same rule (so it applies in client mode too, which has
// its own copy of these handlers). See main/util/fileKinds.js.
const { IMAGE_EXTS, isAbsolutePath, isImagePath, isWorkbookPath, scanImageFilesIn } = require('../util/fileKinds');

function register({ exposeLocal }) {
  exposeLocal('files:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  /**
   * v0.11.0: read a thumbnail for an arbitrary absolute image
   * path, return a base64 data-URL. Used by the Bulk source picker
   * so it can preview files the user picked but hasn't queued yet
   * (those files haven't been imported into assets/ai-source/ yet,
   * so app-image:// can't serve them).
   *
   * v0.1.17: the path is now restricted to an absolute path with an image
   * extension. Previously this accepted ANY absolute path and handed it to
   * sharp, so a compromised renderer could turn any image on the Mac into a
   * base64 JPEG it could read back — which is exactly what main/protocol.js
   * refuses to do for `app-image://` ("a malicious renderer payload could
   * otherwise walk outside the asset trees"). This is that same rule applied
   * to the one other channel that reads by path. The picker above can only
   * return these extensions, so no working flow loses anything.
   */
  exposeLocal('files:readImageThumb', async (absPath) => {
    if (!isAbsolutePath(absPath)) throw new Error('An absolute image path is required');
    if (!isImagePath(absPath)) throw new Error('Only image files can be previewed');
    if (!fs.existsSync(absPath)) throw new Error('File not found');
    const sharp = require('sharp');
    const buf = await sharp(absPath)
      .rotate()
      .resize({ width: 160, height: 160, fit: 'cover' })
      .jpeg({ quality: 72 })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  });

  /**
   * Show a file or folder this Mac just wrote — "Show in Finder" after an
   * export, "Open folder" after a label run. A folder opens in Finder; a file
   * opens its folder with the file selected. Local-only: the path is on the
   * Mac that ran the job (client mode has its own copy in main/client/index.js).
   * The validator already requires an absolute path that exists; the check is
   * repeated here because the folder can vanish between the two.
   */
  exposeLocal('files:revealPath', async (absPath) => {
    if (!isAbsolutePath(absPath)) throw new Error('An absolute path is required');
    // Plain folders open; files and packages (.app, .pkg …) are revealed,
    // never opened — opening a package launches it (util/openPath.js).
    return revealPath(absPath);
  });

  exposeLocal('files:pickImageFile', async ({ multiple = false } = {}) => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
      filters: [
        // v0.41.0: allow HEIC/HEIF (iPhone photos) — converted to JPEG on import.
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return multiple ? res.filePaths : res.filePaths[0];
  });

  /**
   * v0.49.53: scan a folder for image files (top level + one level of
   * subfolders) and return their absolute paths. Used by the "Watermark
   * external photos" batch tool so a user can drop a whole folder in
   * rather than multi-selecting files. Skips hidden files/dotfolders.
   */
  exposeLocal('files:scanImageFiles', async (folderPath) => {
    if (!isAbsolutePath(folderPath)) throw new Error('An absolute folder path is required');
    return scanImageFilesIn(folderPath);
  });

  exposeLocal('files:pickWorkbook', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv', 'tsv'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  /**
   * v0.1.17: the path must be absolute and look like a workbook. Previously
   * anything was passed to SheetJS, which reports a parse failure for a
   * non-spreadsheet but only after reading the file — the same
   * read-any-file-by-path shape as `files:readImageThumb`.
   */
  exposeLocal('files:parseWorkbook', (filePath) => {
    if (!isAbsolutePath(filePath)) throw new Error('An absolute workbook path is required');
    if (!isWorkbookPath(filePath)) {
      throw new Error('Only .xlsx, .xls, .csv and .tsv files can be imported');
    }
    return fileHandler.readWorkbook(filePath);
  });

  exposeLocal('samples:generateProductSheet', async () => {
    /* v0.1.65: the sample sheet is built from the ACTIVE company, so it carries
     * a column for every price group the user has defined plus the custom fields
     * they already use. It used to be a fixed header list, which is why a new
     * price group had nowhere to be imported. */
    const activeCompanyId = companies.getActiveId();
    const company = activeCompanyId ? companies.get(activeCompanyId) : null;
    const res = await dialog.showSaveDialog({
      title: 'Save sample workbook',
      defaultPath: 'media-studio-kh-products-sample.xlsx',
      filters: [{ name: 'Workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fileHandler.writeProductSampleWorkbook(res.filePath, {
      priceGroups: company?.priceGroups ?? [],
      customFields: activeCompanyId ? productsDb.customFieldKeys(activeCompanyId) : [],
    });
    return res.filePath;
  });
}

module.exports = { register, IMAGE_EXTS };
