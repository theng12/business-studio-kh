const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sharp = require('sharp');
const ROOT = path.resolve(__dirname, '..');
function load(file, stubs = {}) {
  const filename = path.join(ROOT, file);
  const req = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => Object.hasOwn(stubs, id) ? stubs[id] : req(id),
    module, exports: module.exports, Buffer, process, console, setTimeout, clearTimeout,
  }, { filename });
  return module.exports;
}
async function fixture(body) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'msk-label-output-'));
  try { await body(root); } finally {
    const trash = path.join(ROOT, '_trash', 'task6-fixtures');
    await fsp.mkdir(trash, { recursive: true });
    await fsp.rename(root, path.join(trash, path.basename(root)));
  }
}
async function renderService(onCapture = () => {}) {
  const pixels = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#cc2255' } }).png().toBuffer();
  class Window {
    constructor() {
      this.webContents = { setBackgroundThrottling() {}, setZoomFactor() {}, executeJavaScript: async () => true,
        capturePage: async () => { await onCapture(); return { toPNG: () => pixels, toJPEG: () => Buffer.from('jpeg-bytes') }; } };
    }
    async loadURL() {}
    isDestroyed() { return false; }
    destroy() {}
  }
  return load('main/renderWindow.js', { electron: { BrowserWindow: Window } });
}
function labelHandlers(renderer, products = []) {
  const handlers = new Map();
  const recorded = [];
  const module = load('main/ipc/labels.js', {
    '../renderWindow': renderer,
    '../db/labelTemplates': { get: () => ({ id: 't', name: 'Small', widthMm: 60, heightMm: 40 }) },
    '../db/products': { get: (id) => products.find((p) => p.id === id) },
    '../db/brands': { list: () => [] },
    '../db/companies': {},
    '../db/labelRuns': { create: (data) => { recorded.push(data); return { id: 'run', ...data }; }, addItems: (id, data) => { recorded.at(-1).items = data; } },
    '../studioRenderer': { labelsDocument: async () => '<html>label</html>', barcodeUri: async () => 'data:image/png;base64,YmFyY29kZS1ieXRlcw==' },
    '../events': { broadcast() {} }, '../imageManager': {},
  });
  module.register({ expose: (name, fn) => handlers.set(name, fn), exposeLocal: (name, fn) => handlers.set(name, fn), emitCatalogChange() {}, assertEntityInActiveCompany: (p) => p });
  return { handlers, recorded };
}
function clientHandlers(renderer, rpc) {
  const filename = path.join(ROOT, 'main/client/index.js');
  const source = fs.readFileSync(filename, 'utf8');
  const chunk = source.slice(source.indexOf("  handleLocal('labels:saveBarcode'"), source.indexOf("  handleLocal('labels:print'"));
  const handlers = new Map();
  const req = createRequire(filename);
  vm.runInNewContext(chunk, { handleLocal: (name, fn) => handlers.set(name, fn), fsp, path, rpc, Buffer,
    require: (id) => id === '../renderWindow' ? renderer : id === '../events' ? { broadcast() {} } : id === '../studioRenderer' ? { barcodeUri: async () => 'data:image/png;base64,YmFyY29kZS1ieXRlcw==' } : req(id) });
  return handlers;
}
const selected = [{ id: 'a', sku: 'A B' }, { id: 'b', sku: 'A-B' }, { id: 'c', sku: 'C' }];

test('standalone and client barcodes retain earlier bytes and return unique actual paths', async () => {
  await fixture(async (outputFolder) => {
    const local = labelHandlers({}).handlers;
    const client = clientHandlers({}, () => {});
    let first;
    const paths = [];
    for (const handlers of [local, local, client, client]) {
      const result = await handlers.get('labels:saveBarcode')({ value: '123', format: 'code128', outputFolder });
      paths.push(result.outputPath);
      if (!first) { first = result.outputPath; await fsp.writeFile(first, 'earlier-file'); }
    }
    assert.equal(new Set(paths).size, 4);
    assert.equal(await fsp.readFile(first, 'utf8'), 'earlier-file');
    for (const file of paths.slice(1)) assert.equal(await fsp.readFile(file, 'utf8'), 'barcode-bytes');
  });
});

test('label PNG/JPEG capture keeps competing writes and reports actual paths with unchanged size, density and bytes', async () => {
  await fixture(async (outputFolder) => {
    for (const format of ['png', 'jpeg']) {
      const target = path.join(outputFolder, `label.${format}`);
      let competing = true;
      const renderer = await renderService(async () => {
        if (competing) { competing = false; await fsp.writeFile(target, 'competing-file'); }
      });
      const options = { format, width: 480, height: 320, dpi: 203, quality: 92, zoomFactor: 203 / 96, unique: true };
      const callbacks = [];
      const paths = await renderer.toImages(2, async () => ({ html: '<html></html>', outputPath: target }), options, (i, file) => callbacks.push(file));
      assert.equal(new Set(paths).size, 2);
      assert.ok(paths.every((p) => p !== target));
      assert.deepEqual(Array.from(paths), callbacks);
      assert.equal(await fsp.readFile(target, 'utf8'), 'competing-file');
      const before = await fsp.readFile(paths[0]);
      await renderer.toImage('<html></html>', target, options);
      assert.deepEqual(await fsp.readFile(paths[0]), before);
      const meta = await sharp(before).metadata();
      assert.equal(meta.width, 480); assert.equal(meta.height, 320); assert.equal(meta.density, 203);
      assert.equal(meta.format, format === 'jpeg' ? 'jpeg' : 'png');
      const baseline = await renderer.toImage('<html></html>', path.join(outputFolder, `baseline.${format}`), { ...options, unique: false });
      assert.deepEqual(await fsp.readFile(baseline), before, 'unique save does not change encoded output');
    }
  });
});

test('standalone label images with sluggified/repeated names persist distinct paths in run items', async () => {
  await fixture(async (outputFolder) => {
    const renderer = await renderService();
    const { handlers, recorded } = labelHandlers(renderer, selected.slice(0, 2));
    const args = { companyId: 'co', templateId: 't', productIds: ['a', 'b'], outputFolder, format: 'png', layout: { dpi: 203 } };
    const first = await handlers.get('labels:generate')(args);
    const firstBytes = await Promise.all(first.files.map((file) => fsp.readFile(file)));
    const second = await handlers.get('labels:generate')(args);
    assert.equal(new Set([...first.files, ...second.files]).size, 4);
    assert.deepEqual(Array.from(recorded[0].items, (item) => item.filePath), Array.from(first.files));
    assert.deepEqual(Array.from(recorded[1].items, (item) => item.filePath), Array.from(second.files));
    for (let i = 0; i < first.files.length; i++) assert.deepEqual(await fsp.readFile(first.files[i]), firstBytes[i]);
  });
});

test('client label images record actual unique paths; PDF history and Run again retain resolved products only', async () => {
  await fixture(async (outputFolder) => {
    const renderer = await renderService();
    renderer.toPdf = async (html, target) => { await fsp.writeFile(target, 'pdf-bytes'); return target; };
    const server = labelHandlers(renderer, selected);
    const records = [];
    const rpc = async (name, data) => {
      if (name === 'labels:recordRun') records.push(data);
      return server.handlers.get(name)(data);
    };
    const handlers = clientHandlers(renderer, rpc);
    const args = { companyId: 'co', templateId: 't', productIds: ['a', 'missing', 'b', 'c'], outputFolder, format: 'png' };
    const one = await handlers.get('labels:generate')(args);
    const two = await handlers.get('labels:generate')(args);
    assert.equal(new Set([...one.files, ...two.files]).size, 6);
    assert.deepEqual(Array.from(records[1].items, (p) => p.filePath), Array.from(two.files));
    const pdf = await handlers.get('labels:generate')({ ...args, format: 'pdf' });
    assert.equal(pdf.files.length, 1);
    assert.equal(pdf.run.productCount, 3);
    assert.deepEqual(Array.from(pdf.run.settings.productIds), ['a', 'b', 'c']);
    const rerunSource = require('esbuild').transformSync(fs.readFileSync(path.join(ROOT, 'renderer/modules/LabelStudio/labelRerun.js'), 'utf8'), { format: 'cjs' }).code;
    const rerunModule = { exports: {} };
    vm.runInNewContext(rerunSource, { module: rerunModule, exports: rerunModule.exports });
    assert.deepEqual(Array.from(rerunModule.exports.rerunFromRun(pdf.run).productIds), ['a', 'b', 'c']);
    assert.deepEqual(Array.from(records[2].items, (p) => p.productId), ['a', 'b', 'c']);
    assert.ok(records[2].items.every((p) => p.filePath === pdf.files[0]));
  });
});

test('label sheets retain finite zero spacing and use defaults only for invalid/missing values', async () => {
  const studio = require('../main/studioRenderer');
  const args = { template: { widthMm: 60, heightMm: 40, elements: [] }, products: [{}], preview: true };
  for (const value of [0, '0', -1]) {
    const html = await studio.labelsDocument({ ...args, layout: { marginMm: value, gapMm: value } });
    assert.match(html, /margin: 0mm/); assert.match(html, /gap:0mm/);
  }
  for (const value of [undefined, null, '', 'bad', Infinity, NaN]) {
    const html = await studio.labelsDocument({ ...args, layout: { marginMm: value, gapMm: value } });
    assert.match(html, /margin: 8mm/); assert.match(html, /gap:2mm/);
  }
  const html = await studio.labelsDocument({ ...args, layout: { marginMm: 4, gapMm: 3, orientation: 'landscape', pageSize: 'Letter' } });
  assert.match(html, /size: Letter landscape/); assert.match(html, /margin: 4mm/); assert.match(html, /gap:3mm/);
});
