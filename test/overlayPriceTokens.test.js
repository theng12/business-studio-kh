/**
 * The two things a phone user could not do, checked where the database is:
 *
 *   1. `{price_vip}` — a price group he created himself. The token filler knew
 *      only retail and wholesale, so his token came out as literal text. The
 *      wiring that matters is company price groups → the token context, which
 *      only exists once a company with groups does.
 *
 *   2. One zip for a batch of overlays, instead of one full-size image per
 *      reply (which is what produced "Load failed" on a phone).
 *
 * Runs under `npm run test:native` — better-sqlite3 is built for Electron's
 * ABI, so plain `node --test` skips it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let skipReason = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  if (err?.code === 'ERR_DLOPEN_FAILED') {
    skipReason = "better-sqlite3 is built for Electron's ABI — run this test with ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron";
  } else {
    throw err;
  }
}

/** Register the templates handlers with a capture, so a case can call one
 *  directly — no HTTP server, no ports, no client. */
function captureHandlers(templates) {
  const handlers = new Map();
  templates.register({
    expose(channel, handler) { handlers.set(channel, handler); },
    exposeLocal() {},
    emitCatalogChange() {},
  });
  return handlers;
}

test('a price group the owner created becomes a token', { skip: skipReason }, async () => {
  const originalLoad = Module._load;
  Module._load = function testLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() }, ipcMain: { handle() {}, on() {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const db = require('../main/db');
  const companies = require('../main/db/companies');
  const products = require('../main/db/products');
  const imageTemplates = require('../main/db/imageTemplates');
  const templateRenderer = require('../main/templateRenderer');
  const templates = require('../main/ipc/templates');
  Module._load = originalLoad;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-price-tokens-'));
  try {
    db.initDb(dataDir);
    // create() takes only name/colour/sectors; groups are set through update(),
    // which is what the Settings → Price groups panel does.
    const company = companies.create({ name: 'Token Company' });
    companies.update(company.id, {
      priceGroups: [{ key: 'vip', label: 'VIP' }, { key: 'dealer', label: 'Dealer' }],
    });
    assert.equal(companies.getActiveId(), company.id);
    assert.equal(companies.get(company.id).priceGroups.length, 2, 'the groups are on the company');

    const product = products.create({
      companyId: company.id,
      sku: 'TOKEN-1',
      name: 'Token product',
      priceRetail: 100,
      prices: { vip: { amount: 1234.5, currency: 'USD' } },
    });

    const ctx = templates.buildTemplateContext(products.get(product.id));
    assert.equal(ctx.prices.vip, '$1,234.50', 'the VIP group is formatted like every other price');
    assert.equal(ctx.prices.dealer, '', 'a group this product has no price for is empty, not missing');
    assert.equal(Object.prototype.hasOwnProperty.call(ctx.prices, 'nope'), false, 'unknown keys are not invented');

    const template = imageTemplates.create({
      name: 'Price card', canvasWidth: 32, canvasHeight: 32, elements: [],
    });
    const out = templateRenderer.fillTokens(
      'VIP {price_vip} / retail {price_retail} / {price_nope}',
      { ...ctx, priceRetail: 100 },
    );
    assert.equal(out, 'VIP $1,234.50 / retail 100 / {price_nope}',
      'his token resolves; a typo stays visible instead of silently blanking');
    assert.equal(template.id.length > 0, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a batch of overlays comes back as one zip', { skip: skipReason }, async () => {
  const originalLoad = Module._load;
  Module._load = function testLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getVersion: () => '0.0.0-test', getPath: () => os.tmpdir() }, ipcMain: { handle() {}, on() {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const db = require('../main/db');
  const companies = require('../main/db/companies');
  const products = require('../main/db/products');
  const productImages = require('../main/db/productImages');
  const imageTemplates = require('../main/db/imageTemplates');
  const templates = require('../main/ipc/templates');
  const sharp = require('sharp');
  Module._load = originalLoad;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-zip-'));
  try {
    db.initDb(dataDir);
    const company = companies.create({ name: 'Zip Company' });
    assert.equal(companies.getActiveId(), company.id);

    // Three DIFFERENT images: imports dedup by content, so the same bytes twice
    // would leave the product with one image and quietly shrink the batch.
    const shot = (bg) => sharp({
      create: { width: 48, height: 48, channels: 4, background: bg },
    }).png().toBuffer();

    const one = products.create({ companyId: company.id, sku: 'ZIP-1', name: 'First' });
    await productImages.addFromBytes(one.id, await shot('#336699'), '.png', { originalFilepath: 'a.png' });
    await productImages.addFromBytes(one.id, await shot('#996633'), '.png', { originalFilepath: 'b.png' });
    assert.equal(productImages.listByProduct(one.id).length, 2, 'two distinct images on the first product');

    const two = products.create({ companyId: company.id, sku: 'ZIP-2', name: 'Second' });
    await productImages.addFromBytes(two.id, await shot('#339966'), '.png', { originalFilepath: 'c.png' });

    const template = imageTemplates.create({
      name: 'Gold Frame', canvasWidth: 48, canvasHeight: 48, elements: [],
    });

    const handlers = captureHandlers(templates);
    const renderZip = handlers.get('templates:renderZip');
    assert.equal(typeof renderZip, 'function', 'the zip channel is registered');

    // Two products, and the second image of the first — the position case.
    const result = await renderZip({
      templateId: template.id,
      items: [{ productId: one.id, position: 1 }, { productId: one.id, position: 2 }, { productId: two.id }],
      label: 'Gold Frame',
    });

    assert.equal(result.count, 3);
    assert.deepEqual(result.skipped, []);
    assert.match(result.filepath, /^processed\/overlay-zips\/Gold-Frame-.*\.zip$/);

    const abs = path.join(dataDir, result.filepath);
    assert.equal(fs.existsSync(abs), true, 'the archive is where the asset route will look for it');

    const listing = execFileSync('unzip', ['-Z1', abs], { encoding: 'utf8' }).trim().split('\n');
    // Case is preserved (main/util/slug.js): the name matches the SKU and the
    // template as the owner typed them, the same as the desktop's exports.
    assert.deepEqual(listing, ['ZIP-1-Gold-Frame.png', 'ZIP-1-p2-Gold-Frame.png', 'ZIP-2-Gold-Frame.png'],
      'every result is in the archive, and two images of one product cannot collide');
    assert.match(execFileSync('unzip', ['-t', abs], { encoding: 'utf8' }), /No errors detected/);

    // Each entry is a real PNG, not an empty file.
    const bytes = execFileSync('unzip', ['-p', abs, 'ZIP-2-Gold-Frame.png'], { encoding: 'buffer' });
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    await assert.rejects(() => renderZip({ templateId: template.id, items: [] }), /items required/);
    await assert.rejects(
      () => renderZip({ templateId: template.id, items: [{ productId: 'missing-id' }] }),
      /Nothing to package/,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
