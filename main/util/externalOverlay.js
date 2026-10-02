/**
 * v0.1.19: compose a template onto loose image FILES on disk.
 *
 * This is the work behind Overlay Studio's "Watermark external photos" tool —
 * the one that stamps a logo or static text onto a folder of photos that aren't
 * products (personal shots, supplier photos, a client's image dump).
 *
 * Why it is a module rather than the body of one IPC handler. It needs to run in
 * two places with one behaviour:
 *
 *   - main/ipc/templates.js (standalone / server) — assets come from the local
 *     data folder.
 *   - main/client/index.js (client mode) — the photos are on THIS Mac, so the
 *     composing has to happen here too, with assets pulled from the server.
 *
 * The two used to be impossible to share because the asset lookup was hard-coded
 * inside the renderer. It is now a `resolveAsset` argument (see
 * main/templateRenderer.js), so the only difference between the modes is where
 * an asset is read from — everything else is this file.
 *
 * Extracted verbatim from the original handler: same output naming, same
 * re-encode-to-source-format rule, same per-file failure handling, same progress
 * events. If you change behaviour here, both modes change together, which is the
 * point.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const templateRenderer = require('../templateRenderer');
const { slugify } = require('./slug');
const { writeUniqueFile } = require('./exclusiveFile');

/**
 * @param {object}   o
 * @param {object}   o.template        — the image_templates row (needs elements + name)
 * @param {string[]} o.inputPaths      — absolute source image paths (this machine)
 * @param {string}   o.outputFolder    — absolute folder to write into (this machine)
 * @param {Function} [o.resolveAsset]  — (relPath) => absolute path | null
 * @param {Function} [o.onProgress]    — ({ done, total, label })
 * @returns {Promise<{done:number, failed:Array, total:number, outputFolder:string}>}
 */
async function applyTemplateToFiles({
  template,
  inputPaths,
  outputFolder,
  resolveAsset,
  onProgress,
}) {
  if (!template) throw new Error('Template not found');

  await fs.promises.mkdir(outputFolder, { recursive: true });

  // External images have no product, so token-based text/barcode elements
  // (SKU, barcode, brand) render empty — a watermark template (logo / static
  // text) is the intended use. Neutral context.
  const ctx = {
    sku: '', name: '', brand: '', brandIcon: null, barcode: '',
    colorFinish: '', category: '', description: '', priceRetail: null, priceWholesale: null,
  };

  const done = [];
  const failed = [];
  const total = inputPaths.length;
  const label = template.name || 'Watermark';
  const tmplSlug = slugify(template.name || 'overlay', 'overlay');

  for (let i = 0; i < inputPaths.length; i += 1) {
    const src = inputPaths[i];
    try {
      if (!fs.existsSync(src)) {
        failed.push({ src, error: 'file not found' });
      } else {
        // `canvas: 'photo'` (owner decision 2026-10-02): watermarking keeps
        // each photo's own size and shape — no template-shaped white bands,
        // no inset — and only adds the artwork. Product overlays take the
        // template's shape instead (templateRenderer.outputCanvasSize).
        const bytes = await templateRenderer.compose({
          inputImage: src, template, context: ctx, resolveAsset, strictImageAssets: true,
          canvas: 'photo',
        });
        // Re-encode to the source format so a JPG photo stays a JPG
        // (PNG output would balloon photo file sizes).
        let ext = path.extname(src).toLowerCase();
        if (ext === '.heic' || ext === '.heif' || ext === '') ext = '.jpg'; // HEIC out isn't well supported
        let pipe = sharp(bytes, { failOn: 'none' });
        if (ext === '.png')       pipe = pipe.png({ compressionLevel: 9 });
        else if (ext === '.webp') pipe = pipe.webp({ quality: 90 });
        else { ext = ext === '.jpeg' ? '.jpeg' : '.jpg'; pipe = pipe.jpeg({ quality: 92, mozjpeg: true }); }
        const outBytes = await pipe.toBuffer();

        const baseName = slugify(path.basename(src, path.extname(src)) || 'photo', 'photo');
        const absOut = await writeUniqueFile(outputFolder, `${baseName}-${tmplSlug}${ext}`, outBytes);
        done.push({ src, outputFilepath: absOut });
      }
    } catch (err) {
      failed.push({ src, error: err.message });
    }
    if (onProgress) {
      onProgress({ done: i + 1, total, label: `${label} · ${path.basename(src)}` });
    }
  }

  return { done: done.length, failed, total, outputFolder };
}

/** The validation both modes apply before doing any work. */
function validateExternalRequest({ inputPaths, outputFolder }) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('Pick at least one image');
  if (inputPaths.length > 2000) throw new Error('Too many files (max 2000 per batch).');
  if (typeof outputFolder !== 'string' || !outputFolder.trim()) throw new Error('Pick an output folder');
}

module.exports = { applyTemplateToFiles, validateExternalRequest };
