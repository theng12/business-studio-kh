const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'webclient/index.html'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function response(result, status = 200, blob = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return status >= 200 && status < 300 ? { result } : { error: result }; },
    async blob() { return blob || new Blob(['image']); },
  };
}

function makeElement(id) {
  const listeners = new Map();
  const children = [];
  const classNames = new Set();
  const style = {
    setProperty(name, value) { this[name] = value; },
    removeProperty(name) { delete this[name]; },
  };
  let html = '';
  const element = {
    id,
    children,
    dataset: {},
    style,
    className: '',
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    isConnected: true,
    classList: {
      add(...names) { names.forEach((name) => classNames.add(name)); },
      remove(...names) { names.forEach((name) => classNames.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !classNames.has(name) : !!force;
        if (next) classNames.add(name); else classNames.delete(name);
        return next;
      },
      contains(name) { return classNames.has(name); },
    },
    addEventListener(name, handler) {
      const current = listeners.get(name) || [];
      current.push(handler);
      listeners.set(name, current);
    },
    dispatch(name, event = {}) {
      const input = { target: element, ...event };
      for (const handler of listeners.get(name) || []) handler(input);
    },
    appendChild(child) { children.push(child); child.parentNode = element; return child; },
    replaceChild(next, previous) {
      const index = children.indexOf(previous);
      if (index >= 0) children.splice(index, 1, next);
      next.parentNode = element;
      return previous;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
    },
    remove() { if (element.parentNode) element.parentNode.removeChild(element); },
    setAttribute(name, value) { element[name] = String(value); },
    getAttribute(name) { return element[name] || null; },
    querySelector() { return makeElement('query-result'); },
    querySelectorAll() { return []; },
    focus() {},
    click() { element.dispatch('click'); },
    setPointerCapture() {},
  };
  Object.defineProperty(element, 'innerHTML', {
    get() { return html; },
    set(value) {
      html = String(value); children.splice(0, children.length);
      if (id === 'figure' && html.startsWith('<div class="thumb"')) element.appendChild(makeElement('thumb'));
    },
  });
  Object.defineProperty(element, 'firstChild', { get() { return children[0] || null; } });
  return element;
}

function loadBrowserHarness({
  companyData = {}, deferReorder = false, deferAssets = false,
  assetsOk = false, assetBlob = null, shareAvailable = false, shareDenied = false,
  overlayApply = null, renderPreview = null, userAgent = '',
} = {}) {
  const elements = new Map();
  const storage = new Map();
  const pendingActivations = [];
  const pendingImageLists = [];
  const pendingReorders = [];
  const pendingAssets = [];
  const revokedUrls = [];
  const shares = [];
  const gets = [];
  const calls = [];
  let objectUrl = 0;

  const document = {
    body: makeElement('body'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement(tag) { return makeElement(tag); },
    createTextNode(text) { const node = makeElement('text'); node.textContent = text; return node; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    innerHeight: 800,
    visualViewport: null,
    addEventListener() {},
    confirm() { return true; },
    scrollTo() {},
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  };
  const BrowserURL = class extends URL {};
  BrowserURL.createObjectURL = () => `blob:test-${++objectUrl}`;
  BrowserURL.revokeObjectURL = (url) => revokedUrls.push(url);

  // The viewer's save path asks the platform for a share sheet. Over HTTPS
  // iOS provides one; over plain HTTP `navigator.share` is not defined at all,
  // which is what `shareAvailable: false` reproduces.
  const navigator = {};
  if (userAgent) navigator.userAgent = userAgent;
  if (shareAvailable) {
    navigator.canShare = (data) => !!(data && Array.isArray(data.files) && data.files.length);
    navigator.share = (data) => {
      shares.push(data);
      if (shareDenied) {
        const err = new Error('The request is not allowed by the user agent');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      return Promise.resolve();
    };
  }

  const fetch = (url, options = {}) => {
    if (deferAssets && String(url).includes('/assets/')) {
      const request = deferred();
      pendingAssets.push({ url: String(url), request });
      return request.promise;
    }
    if (options.method !== 'POST') {
      if (String(url).includes('/assets/')) gets.push(String(url));
      const ok = assetsOk && String(url).includes('/assets/');
      return Promise.resolve(response(null, ok ? 200 : 404, ok ? assetBlob : null));
    }
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), auth: options.headers.Authorization, ...body });
    if (deferReorder && body.channel === 'images:reorderImages') {
      const request = deferred();
      pendingReorders.push(request);
      return request.promise;
    }
    if (body.channel === 'templates:applyToProduct' && overlayApply) {
      return Promise.resolve(response(overlayApply));
    }
    if (body.channel === 'templates:renderPreview' && renderPreview) {
      return Promise.resolve(response(renderPreview));
    }
    if (body.channel === 'companies:setActive') {
      const request = deferred();
      pendingActivations.push({ id: body.args, request });
      return request.promise;
    }
    if (body.channel === 'images:listByProduct') {
      const request = deferred();
      pendingImageLists.push({ id: body.args, request });
      return request.promise;
    }
    if (body.channel === 'products:list') {
      return Promise.resolve(response(companyData[body.args.companyId] || []));
    }
    return Promise.resolve(response([]));
  };

  const scriptStart = source.indexOf('<script>') + '<script>'.length;
  const scriptEnd = source.lastIndexOf('</script>');
  const script = source.slice(scriptStart, scriptEnd);
  const end = script.lastIndexOf('\n})();');
  assert.ok(end > 0, 'browser script should have an IIFE terminator');
  const instrumented = script.slice(0, end) + `
  window.__testHooks = {
    state: state,
    setSession: function (url, authToken) { baseUrl = url; token = authToken; },
    switchCompany: switchCompany,
    resetSessionState: resetSessionState,
    clearImageCaches: clearImageCaches,
    getImageList: getImageList,
    getMainImage: getMainImage,
    renderGallery: renderGallery,
    openDetail: openDetail,
    reorderImageNeighbor: reorderImageNeighbor,
    openOverlaySheet: openOverlaySheet,
    applyOverlaySheet: applyOverlaySheet,
    paintOverlaySheet: paintOverlaySheet,
    saveImageToDevice: saveImageToDevice,
    closeOverlayDoneSheet: closeOverlayDoneSheet,
    openImgPreview: openImgPreview,
    closeImgPreview: closeImgPreview,
  };` + script.slice(end);
  const context = {
    URL: BrowserURL,
    Blob,
    File,
    Error,
    Promise,
    document,
    window,
    localStorage,
    fetch,
    location: { origin: 'http://viewer.test' },
    navigator,
    // The viewer decodes the server's `{ __bin, b64 }` envelopes with atob.
    atob,
    IntersectionObserver: class { disconnect() {} observe() {} unobserve() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  };
  vm.createContext(context);
  vm.runInContext(instrumented, context);

  function activation(id) {
    const found = pendingActivations.find((entry) => entry.id === id && !entry.done);
    assert.ok(found, `pending activation for ${id}`);
    found.done = true;
    return found;
  }
  function resolveActivation(id, result = true) { activation(id).request.resolve(response(result)); }
  function rejectActivation(id, message) { activation(id).request.resolve(response(message, 500)); }
  function imageList(id, result) {
    const found = pendingImageLists.find((entry) => entry.id === id && !entry.done);
    assert.ok(found, `pending image list for ${id}`);
    found.done = true;
    found.request.resolve(response(result));
  }
  async function flush() { await new Promise((resolve) => setImmediate(resolve)); }

  return {
    hooks: window.__testHooks,
    calls,
    elements,
    resolveActivation,
    rejectActivation,
    imageList,
    finishReorder() {
      assert.ok(pendingReorders.length, 'a reorder is pending');
      pendingReorders.shift().resolve(response(true));
    },
    asset(path) {
      const found = pendingAssets.find((entry) => entry.url.endsWith('/assets/' + path) && !entry.done);
      assert.ok(found, `pending asset ${path}`);
      found.done = true;
      found.request.resolve(response(null));
    },
    pendingAssets,
    revokedUrls,
    shares,
    gets,
    flush,
  };
}

test('browser company switches serialize activation and restore the last confirmed company after A/B/A failure', async () => {
  const harness = loadBrowserHarness();
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'token-a');
  hooks.state.companies = [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }];
  hooks.state.companyId = 'A';
  hooks.state.products = [{ id: 'a-product', sku: 'A-1' }];

  const switchB = hooks.switchCompany('B');
  const switchA = hooks.switchCompany('A');
  await harness.flush();

  assert.deepEqual(harness.calls.filter((call) => call.channel === 'companies:setActive').map((call) => call.args), ['B']);

  harness.resolveActivation('B');
  await harness.flush();
  await harness.flush();
  assert.deepEqual(harness.calls.filter((call) => call.channel === 'companies:setActive').map((call) => call.args), ['B', 'A']);

  harness.rejectActivation('A', 'A activation failed');
  await assert.rejects(switchA, /A activation failed/);
  await switchB;

  assert.equal(hooks.state.companyId, 'B');
  assert.equal(harness.calls.filter((call) => call.channel === 'companies:setActive').at(-1).args, 'A');
});

test('browser earlier failed activation preserves the later queued company and publishes its products', async () => {
  const harness = loadBrowserHarness({ companyData: {
    A: [{ id: 'a-product', sku: 'A-1' }],
    C: [{ id: 'c-product', sku: 'C-1' }],
  } });
  const { hooks } = harness;
  hooks.setSession('http://synthetic.test', 'dummy-token');
  hooks.state.companies = ['A', 'B', 'C'].map((id) => ({ id, name: id }));

  const initialA = hooks.switchCompany('A');
  await harness.flush();
  harness.resolveActivation('A');
  await initialA;
  assert.equal(hooks.state.companyId, 'A');
  assert.deepEqual(hooks.state.products, [{ id: 'a-product', sku: 'A-1' }]);

  const failedB = assert.rejects(hooks.switchCompany('B'), /B activation failed/);
  const switchC = hooks.switchCompany('C');
  await harness.flush();
  harness.rejectActivation('B', 'B activation failed');
  await failedB;
  await harness.flush();
  const selectionAfterFailure = hooks.state.companyId;
  harness.resolveActivation('C');
  assert.equal(await switchC, true);

  assert.deepEqual(harness.calls.filter((call) => call.channel === 'companies:setActive').map((call) => call.args), ['A', 'B', 'C']);
  assert.equal(hooks.state.companyId, 'C');
  assert.deepEqual(hooks.state.products, [{ id: 'c-product', sku: 'C-1' }]);
  assert.deepEqual(hooks.state.filtered, [{ id: 'c-product', sku: 'C-1' }]);
  assert.equal(selectionAfterFailure, 'C', 'the queued selection survives the older failure');
});

test('browser reset skips queued old-session company work and never sends it with new credentials', async () => {
  const harness = loadBrowserHarness();
  const { hooks } = harness;
  hooks.setSession('http://server-a.test', 'token-a');
  hooks.state.companyId = 'A';

  const oldInFlight = hooks.switchCompany('B');
  await harness.flush();
  const oldQueued = hooks.switchCompany('C');
  await harness.flush();
  hooks.resetSessionState();
  hooks.setSession('http://server-b.test', 'token-b');
  const newSession = hooks.switchCompany('D');
  await harness.flush();

  assert.deepEqual(harness.calls.filter((call) => call.channel === 'companies:setActive').map((call) => [call.args, call.auth]), [
    ['B', 'Bearer token-a'],
    ['D', 'Bearer token-b'],
  ]);

  harness.resolveActivation('B');
  harness.resolveActivation('D');
  await Promise.all([oldInFlight, oldQueued, newSession]);
});

test('browser company failure restores the latest server-confirmed snapshot, not the last requested company', async () => {
  const harness = loadBrowserHarness({ companyData: { A: [{ id: 'a-product', sku: 'A-1' }] } });
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'token-a');
  hooks.state.companies = [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }];
  hooks.state.companyId = 'C';
  hooks.state.products = [{ id: 'c-product', sku: 'C-1' }];

  const switchA = hooks.switchCompany('A');
  const switchB = hooks.switchCompany('B');
  await harness.flush();
  assert.deepEqual(harness.calls.filter((call) => call.channel === 'companies:setActive').map((call) => call.args), ['A']);

  harness.resolveActivation('A');
  await harness.flush();
  await harness.flush();
  assert.deepEqual(harness.calls.filter((call) => call.channel === 'companies:setActive').map((call) => call.args), ['A', 'B']);

  harness.rejectActivation('B', 'B activation failed');
  await assert.rejects(switchB, /B activation failed/);
  await switchA;

  assert.equal(hooks.state.companyId, 'A');
  assert.deepEqual(hooks.state.products, [{ id: 'a-product', sku: 'A-1' }]);
});

test('browser image-list and main-image results cannot refill caches after session reset', async () => {
  const harness = loadBrowserHarness();
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'token-a');
  hooks.state.companyId = 'A';

  const oldList = hooks.getImageList('product-1');
  await harness.flush();
  hooks.resetSessionState();
  harness.imageList('product-1', [{ filepath: 'old.jpg' }]);
  assert.equal(await oldList, null);
  const freshListPromise = hooks.getImageList('product-1');
  await harness.flush();
  harness.imageList('product-1', [{ filepath: 'new.jpg' }]);
  const freshList = await freshListPromise;
  assert.deepEqual(freshList, [{ filepath: 'new.jpg' }]);
  assert.equal(harness.calls.filter((call) => call.channel === 'images:listByProduct').length, 2);

  hooks.resetSessionState();
  const mainPromise = hooks.getMainImage('product-1');
  await harness.flush();
  harness.imageList('product-1', [{ filepath: 'main.jpg' }]);
  assert.equal(await mainPromise, 'main.jpg');
});

test('browser manual image-cache invalidation fences pending image-list work', async () => {
  const harness = loadBrowserHarness();
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'token-a');
  hooks.state.companyId = 'A';

  const oldList = hooks.getImageList('product-1');
  await harness.flush();
  hooks.clearImageCaches();
  harness.imageList('product-1', [{ filepath: 'old.jpg' }]);
  assert.equal(await oldList, null);

  const freshListPromise = hooks.getImageList('product-1');
  await harness.flush();
  harness.imageList('product-1', [{ filepath: 'new.jpg' }]);
  assert.deepEqual(await freshListPromise, [{ filepath: 'new.jpg' }]);
});

test('browser gallery ignores an image-list completion from the reset session', async () => {
  const harness = loadBrowserHarness();
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'token-a');
  hooks.state.companyId = 'A';
  const render = hooks.renderGallery('product-1');
  await harness.flush();
  hooks.resetSessionState();
  harness.imageList('product-1', [{ filepath: 'old.jpg' }]);
  await render;
  assert.equal(harness.elements.get('detailGallery').innerHTML, '<div class="loading">Loading images…</div>');
});

test('browser gallery ignores a late list for the product that is no longer open', async () => {
  const harness = loadBrowserHarness();
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'token-a');
  hooks.state.companyId = 'A';

  hooks.renderGallery('product-1');
  await harness.flush();
  hooks.openDetail({ id: 'product-2', sku: 'P-2', imageCount: 1 });
  await harness.flush();

  harness.imageList('product-1', [{ filepath: 'product-1.jpg' }]);
  await harness.flush();
  assert.equal(harness.elements.get('detailGallery').innerHTML, '<div class="loading">Loading images…</div>');

  harness.imageList('product-2', [{ filepath: 'product-2.jpg' }]);
  await harness.flush();
  assert.equal(harness.elements.get('detailGallery').children.length, 1);
  assert.equal(harness.elements.get('detailGallery').children[0].getAttribute('data-filepath'), 'product-2.jpg');
});

test('browser mutation invalidation fences a pre-mutation image-list response', async () => {
  const harness = loadBrowserHarness();
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'token-a');
  hooks.state.companyId = 'A';

  const oldList = hooks.getImageList('product-1');
  await harness.flush();
  hooks.reorderImageNeighbor('product-1', [{ filepath: 'one.jpg' }, { filepath: 'two.jpg' }], 0, 1);
  await harness.flush();
  await harness.flush();

  harness.imageList('product-1', [{ filepath: 'old.jpg' }]);
  await oldList;
  const freshList = hooks.getImageList('product-1');
  await harness.flush();
  assert.equal(harness.calls.filter((call) => call.channel === 'images:listByProduct').length, 3);

  harness.imageList('product-1', [{ filepath: 'reordered.jpg' }]);
  harness.imageList('product-1', [{ filepath: 'fresh.jpg' }]);
  assert.deepEqual(await freshList, [{ filepath: 'fresh.jpg' }]);
});

test('product A reorder completion preserves product B pending gallery list without a refetch', async () => {
  const harness = loadBrowserHarness({ deferReorder: true, deferAssets: true });
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'dummy-token');
  hooks.state.companyId = 'company';
  hooks.reorderImageNeighbor('A', [{ filepath: 'a1.jpg' }, { filepath: 'a2.jpg' }], 0, 1);
  hooks.openDetail({ id: 'B', sku: 'B', imageCount: 1 });
  await harness.flush();
  harness.finishReorder();
  await harness.flush();
  harness.imageList('B', [{ filepath: 'b.jpg' }]);
  await harness.flush();

  const gallery = harness.elements.get('detailGallery');
  assert.equal(gallery.children.length, 1, 'B list paints after A completes');
  assert.equal(gallery.children[0].getAttribute('data-filepath'), 'b.jpg');
  harness.asset('b.jpg');
  await harness.flush();
  assert.match(gallery.children[0].firstChild.src, /^blob:test-/);
  assert.equal(harness.calls.filter((call) => call.channel === 'images:listByProduct').length, 1);
});

test('product A reorder completion preserves product B pending blob paint and loaded blobs', async () => {
  const harness = loadBrowserHarness({ deferReorder: true, deferAssets: true });
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'dummy-token');
  hooks.state.companyId = 'company';
  hooks.reorderImageNeighbor('A', [{ filepath: 'a1.jpg' }, { filepath: 'a2.jpg' }], 0, 1);
  hooks.openDetail({ id: 'B', sku: 'B', imageCount: 2 });
  harness.imageList('B', [{ filepath: 'b1.jpg' }, { filepath: 'b2.jpg' }]);
  await harness.flush();
  harness.asset('b1.jpg');
  await harness.flush();
  const gallery = harness.elements.get('detailGallery');
  const first = gallery.children[0];
  const second = gallery.children[1];
  const loadedUrl = first.firstChild.src;
  assert.match(loadedUrl, /^blob:test-/);

  harness.finishReorder();
  await harness.flush();
  harness.asset('b2.jpg');
  await harness.flush();

  assert.match(second.firstChild.src || '', /^blob:test-/, 'B pending blob still paints');
  assert.equal(harness.revokedUrls.includes(loadedUrl), false, 'B loaded blob remains valid');
  assert.equal(gallery.children[0], first, 'B gallery was not rebuilt');
  assert.equal(gallery.children[1], second);
  assert.equal(harness.pendingAssets.length, 2, 'no duplicate asset fetch');
  assert.equal(harness.calls.filter((call) => call.channel === 'images:listByProduct').length, 1);
});

/* ── v0.1.73: overlay apply → a copy on this device ──────────────────
   The brother's flow: apply an overlay in the phone's web viewer and have
   the result land on the device as well as in the library. What is testable
   here is the agreement between the viewer and the platform: over HTTPS iOS
   supplies a share sheet, over plain HTTP it supplies nothing at all, and the
   code must not confuse "saved to Files" with "saved to Photos". */

async function overlayHarness(options = {}) {
  const harness = loadBrowserHarness({
    assetsOk: true,
    overlayApply: {
      outputFilepath: 'SKU-1/002--gold-frame.png',
      image: { filepath: 'SKU-1/002--gold-frame.png' },
      count: 1,
    },
    ...options,
  });
  const { hooks } = harness;
  hooks.setSession('http://server.test', 'token-a');
  hooks.state.companyId = 'C1';
  hooks.state.products = [{ id: 'p1', sku: 'SKU-1', imageCount: 1 }];
  hooks.openOverlaySheet({ productId: 'p1' });
  await harness.flush(); // templates:list resolves before the pick is faked in
  hooks.state.overlay.templates = [{ id: 't1', name: 'Gold Frame' }];
  hooks.state.overlay.templateId = 't1';
  return harness;
}

test('overlay apply hands the result to the share sheet when the device toggle is on', async () => {
  const harness = await overlayHarness({ shareAvailable: true });
  const { hooks } = harness;

  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();

  const applied = harness.calls.filter((call) => call.channel === 'templates:applyToProduct');
  assert.equal(applied.length, 1, 'the overlay is applied to the library');
  assert.equal(applied[0].args.destination.kind, 'append');

  // The rendered bytes are fetched with the bearer token, named after the
  // template, and offered to iOS — that is the only route into Photos.
  assert.deepEqual(harness.gets, ['http://server.test/assets/SKU-1/002--gold-frame.png']);
  assert.equal(harness.shares.length, 1, 'the share sheet is offered the result');
  assert.equal(harness.shares[0].files[0].name, 'SKU-1-gold-frame.png');
  assert.equal(harness.shares[0].files[0].type, 'image/png');

  // Share succeeded, so the fallback sheet must stay shut.
  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), false);
});

test('overlay apply over plain HTTP offers the press-and-hold route instead of the share sheet', async () => {
  const harness = await overlayHarness(); // no navigator.share: an HTTP origin
  const { hooks } = harness;

  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();

  assert.equal(harness.shares.length, 0);
  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), true);
  assert.equal(harness.elements.get('overlayDoneName').textContent, 'SKU-1-gold-frame.png');
  assert.equal(harness.elements.get('overlayDoneSaveBtn').textContent, 'Open image to save');
  assert.equal(harness.elements.get('overlayDoneFilesBtn').hidden, false);
  assert.match(harness.elements.get('overlayDoneHint').textContent, /press and hold/i);
  assert.equal(hooks.state.overlayDone.filepath, 'SKU-1/002--gold-frame.png');

  // Closing the sheet releases the preview blob it created.
  const previewUrl = hooks.state.overlayDone.url;
  assert.match(previewUrl, /^blob:test-/);
  hooks.closeOverlayDoneSheet();
  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), false);
  assert.ok(harness.revokedUrls.includes(previewUrl), 'the preview blob is revoked');
  assert.equal(hooks.state.overlayDone, null);
});

test('the press-and-hold route carries its instruction into the fullscreen viewer', async () => {
  const harness = await overlayHarness();
  const { hooks } = harness;

  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();

  // Tapping the button is what opens the picture; the sheet is gone by then, so
  // the instruction has to travel with the picture or the user is left staring
  // at a full-screen image with no idea that a press-and-hold is the next step.
  harness.elements.get('overlayDoneSaveBtn').dispatch('click');
  await harness.flush();

  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), false);
  assert.equal(harness.elements.get('imgPreview').classList.contains('open'), true);
  assert.equal(harness.elements.get('imgPreviewHint').hidden, false);
  assert.match(harness.elements.get('imgPreviewHint').textContent, /Press and hold the picture/);
  assert.equal(hooks.state.overlayDone, null, 'the sheet released its state');

  // An ordinary lightbox visit (a gallery tile) must not carry the pill.
  hooks.state.overlay = null;
  hooks.openDetail({ id: 'p1', sku: 'SKU-1', imageCount: 1 });
  harness.imageList('p1', [{ filepath: 'SKU-1/001.jpg', filename: '001.jpg' }]);
  await harness.flush();
  hooks.openImgPreview([{ filepath: 'SKU-1/001.jpg', filename: '001.jpg' }], 0, 'p1');
  assert.equal(harness.elements.get('imgPreviewHint').hidden, true, 'no pill without a hint');
});

test('a deliberate Save tap whose share is refused still lands on the fallback', async () => {
  // canShare() is true, so the user gets a real "Save to Photos" button, but
  // every navigator.share call is refused (the iOS activation-expired case).
  // The tap must not end up doing visibly nothing.
  const harness = await overlayHarness({ shareAvailable: true, shareDenied: true });
  const { hooks } = harness;

  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();

  assert.equal(harness.elements.get('overlayDoneSaveBtn').textContent, 'Save to Photos');
  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), true);

  harness.elements.get('overlayDoneSaveBtn').dispatch('click');
  await harness.flush();
  await harness.flush();

  assert.equal(harness.shares.length, 2, 'the automatic share and the deliberate one');
  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), false);
  assert.equal(harness.elements.get('imgPreview').classList.contains('open'), true);
  assert.equal(harness.elements.get('imgPreviewHint').hidden, false);
});

test('a session reset closes the save sheet and releases its blob', async () => {
  const harness = await overlayHarness();
  const { hooks } = harness;

  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();
  const previewUrl = hooks.state.overlayDone.url;

  hooks.resetSessionState();

  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), false);
  assert.ok(harness.revokedUrls.includes(previewUrl), 'the blob is released on disconnect');
  assert.equal(hooks.state.overlayDone, null);
});

test('a second save offer releases the sheet that was already open', async () => {
  // Apply leaves the Apply button live again (applyOverlaySheet's .finally)
  // before the device fetch settles, so a fast user can apply twice and put two
  // offers in flight. The earlier sheet's blob must not be orphaned.
  const harness = await overlayHarness(); // no share sheet, so each offer opens the sheet
  const { hooks } = harness;
  hooks.state.overlay.save = true;

  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();
  const firstUrl = hooks.state.overlayDone && hooks.state.overlayDone.url;
  assert.match(firstUrl || '', /^blob:test-/, 'the first offer opened a sheet with a blob');

  hooks.state.overlay = { productId: 'p1', templates: [{ id: 't1', name: 'Gold Frame' }], templateId: 't1', destKind: 'append', save: true, previewSeq: 0, previewUrl: null };
  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();

  assert.ok(harness.revokedUrls.includes(firstUrl), 'the replaced blob is revoked, not dropped');
  assert.match(hooks.state.overlayDone.url, /^blob:test-/);
  assert.notEqual(hooks.state.overlayDone.url, firstUrl);
});

test('the saved file is named and typed from its path, not from an octet-stream response', async () => {
  // serveAsset answers every extension it does not map (heic, gif, tif, …) with
  // application/octet-stream, so reading the MIME subtype named files
  // "SKU-1-1.octet-stream" and typed them as non-images — which is exactly what
  // hides "Save Image" in the iOS share sheet.
  const harness = loadBrowserHarness({
    assetsOk: true,
    assetBlob: new Blob(['image'], { type: 'application/octet-stream' }),
    shareAvailable: true,
  });
  harness.hooks.setSession('http://server.test', 'token-a');
  harness.hooks.saveImageToDevice({ productId: 'p1', filepath: 'SKU-1/001.jpg', index: 0, sku: 'SKU-1' });
  await harness.flush();
  await harness.flush();

  assert.equal(harness.shares.length, 1);
  assert.equal(harness.shares[0].files[0].name, 'SKU-1-1.jpg');
  assert.equal(harness.shares[0].files[0].type, 'image/jpeg');
});

test('overlay apply leaves the device untouched when the toggle is off', async () => {
  const harness = await overlayHarness({ shareAvailable: true });
  const { hooks } = harness;
  hooks.state.overlay.save = false;

  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();

  assert.equal(harness.calls.filter((call) => call.channel === 'templates:applyToProduct').length, 1);
  assert.deepEqual(harness.gets, [], 'no image is fetched for the device');
  assert.equal(harness.shares.length, 0);
  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), false);
});

test('the device-copy toggle defaults on, flips on tap, and is remembered per device', async () => {
  const harness = await overlayHarness();
  const { hooks } = harness;
  assert.equal(hooks.state.overlay.save, true, 'the copy is offered by default');

  const chip = harness.elements.get('overlaySaveChips').children[0];
  assert.match(chip.textContent, /Save to this device/);
  chip.dispatch('click', { preventDefault() {} });

  assert.equal(hooks.state.overlay.save, false);
  assert.equal(harness.elements.get('overlaySaveChips').children[0].textContent, 'Save to this device: off');

  // A second overlay sheet on the same device reads the stored choice back.
  hooks.state.overlay = null;
  hooks.openOverlaySheet({ productId: 'p1' });
  assert.equal(hooks.state.overlay.save, false, 'the choice survives reopening the sheet');
});

test('tile-menu save falls back to a Files download only when iOS refuses the share sheet', async () => {
  const shared = loadBrowserHarness({ assetsOk: true, shareAvailable: true });
  shared.hooks.setSession('http://server.test', 'token-a');
  shared.hooks.saveImageToDevice({ productId: 'p1', filepath: 'SKU-1/001.jpg', index: 0, sku: 'SKU-1' });
  await shared.flush();
  await shared.flush();
  assert.equal(shared.shares.length, 1);
  assert.doesNotMatch(shared.elements.get('toast').textContent, /Files/);

  // A refused share (activation expired while the render was in flight) must
  // still end somewhere useful rather than with an error toast and no file.
  const denied = loadBrowserHarness({ assetsOk: true, shareAvailable: true, shareDenied: true });
  denied.hooks.setSession('http://server.test', 'token-a');
  denied.hooks.saveImageToDevice({ productId: 'p1', filepath: 'SKU-1/001.jpg', index: 0, sku: 'SKU-1' });
  await denied.flush();
  await denied.flush();
  assert.equal(denied.shares.length, 1, 'the share sheet was attempted');
  assert.match(denied.elements.get('toast').textContent, /Saving to Files/);
});

/* ── v0.1.75: "just give me the picture" ─────────────────────────────
   The phone user applies an overlay to send the result on. He asked for the
   save without the library copy, so the save-only destination must never
   reach templates:applyToProduct — no new image, no new main, no image count,
   no history. The compose it needs is the one the live preview already uses. */

const OVERLAY_BYTES = { __bin: true, b64: Buffer.from('overlay-render-bytes').toString('base64') };

test('save-only renders the overlay without touching the product', async () => {
  const harness = await overlayHarness({ shareAvailable: true, renderPreview: { bytes: OVERLAY_BYTES } });
  const { hooks } = harness;
  hooks.state.overlay.destKind = 'saveOnly';
  hooks.paintOverlaySheet();

  assert.equal(harness.elements.get('overlayApplyBtn').textContent, 'Apply and save');
  assert.match(harness.elements.get('overlayPreviewLabel').textContent, /saved to this device only/);
  assert.equal(harness.elements.get('overlaySaveRow').hidden, true,
    'the device toggle is not offered when saving is the whole point');
  // `.reframe-row` sets display:flex, which beats the user-agent [hidden] rule;
  // without this override the row would be marked hidden and still be on screen.
  assert.match(source, /\.reframe-row\[hidden\] \{ display: none; \}/);

  const countBefore = hooks.state.products[0].imageCount;
  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();

  assert.equal(harness.calls.filter((c) => c.channel === 'templates:applyToProduct').length, 0,
    'nothing is added to the library');
  assert.equal(harness.calls.filter((c) => c.channel === 'templates:renderPreview').length, 1,
    'the overlay is composed, not applied');
  assert.equal(hooks.state.products[0].imageCount, countBefore, 'the image count is untouched');

  // The bytes arrive over the RPC, so there is no second fetch of anything.
  assert.deepEqual(harness.gets, []);
  assert.equal(harness.shares.length, 1, 'the render is handed to the share sheet');
  assert.equal(harness.shares[0].files[0].name, 'SKU-1-gold-frame.png');
  assert.equal(harness.shares[0].files[0].type, 'image/png');
  assert.equal(harness.shares[0].files[0].size, 'overlay-render-bytes'.length);
});

test('a save-only result reaches the press-and-hold route without a library file', async () => {
  const harness = await overlayHarness({ renderPreview: { bytes: OVERLAY_BYTES } }); // plain HTTP
  const { hooks } = harness;
  hooks.state.overlay.destKind = 'saveOnly';
  hooks.paintOverlaySheet();

  hooks.applyOverlaySheet();
  await harness.flush();
  await harness.flush();
  await harness.flush();

  assert.equal(harness.elements.get('overlayDoneSheet').classList.contains('open'), true);
  assert.equal(hooks.state.overlayDone.filepath, null, 'there is no library path to re-fetch');

  harness.elements.get('overlayDoneSaveBtn').dispatch('click');
  await harness.flush();

  // The lightbox must show the bytes we already hold — there is nothing on the
  // server to fetch — and must take over releasing that blob.
  assert.equal(harness.elements.get('imgPreview').classList.contains('open'), true);
  assert.deepEqual(harness.gets, [], 'no asset fetch for an image that only exists in the browser');
  const shown = harness.elements.get('imgPreviewImg').src;
  assert.match(shown, /^blob:test-/);

  hooks.closeImgPreview();
  assert.ok(harness.revokedUrls.includes(shown), 'the lightbox releases the blob it was handed');
});

test('the press-and-hold instruction names the menu the platform actually has', async () => {
  const iphone = await overlayHarness({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  iphone.hooks.applyOverlaySheet();
  await iphone.flush(); await iphone.flush(); await iphone.flush();
  assert.equal(iphone.elements.get('overlayDoneFilesBtn').textContent, 'Save to Files');
  iphone.elements.get('overlayDoneSaveBtn').dispatch('click');
  await iphone.flush();
  assert.match(iphone.elements.get('imgPreviewHint').textContent, /tap Save Image/);

  // The owner's brother is on Android, where the same gesture is "Download
  // image" — the iOS wording sent him looking for a menu item that is not there.
  const android = await overlayHarness({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  });
  android.hooks.applyOverlaySheet();
  await android.flush(); await android.flush(); await android.flush();
  assert.equal(android.elements.get('overlayDoneFilesBtn').textContent, 'Download');
  android.elements.get('overlayDoneSaveBtn').dispatch('click');
  await android.flush();
  assert.match(android.elements.get('imgPreviewHint').textContent, /tap Download image/);
});

test('opening the overlay sheet clears a dead preview from the last visit', async () => {
  const harness = await overlayHarness();
  const img = harness.elements.get('overlayPreviewImg');
  // The previous visit's blob URL was revoked when that sheet closed, so the
  // shared <img> still holds a src that can no longer load — the broken-image
  // icon the owner photographed behind the spinner.
  img.src = 'blob:test-from-last-visit';
  img.hidden = false;

  harness.hooks.state.overlay = null;
  harness.hooks.openOverlaySheet({ productId: 'p1' });

  assert.equal(img.src, '');
  assert.equal(img.hidden, true);
  assert.equal(harness.elements.get('overlayBusy').textContent, 'Pick a template to preview…');
});
