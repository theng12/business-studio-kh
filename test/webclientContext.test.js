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

function response(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return status >= 200 && status < 300 ? { result } : { error: result }; },
    async blob() { return new Blob(['image']); },
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

function loadBrowserHarness({ companyData = {}, deferReorder = false, deferAssets = false } = {}) {
  const elements = new Map();
  const storage = new Map();
  const pendingActivations = [];
  const pendingImageLists = [];
  const pendingReorders = [];
  const pendingAssets = [];
  const revokedUrls = [];
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

  const fetch = (url, options = {}) => {
    if (deferAssets && String(url).includes('/assets/')) {
      const request = deferred();
      pendingAssets.push({ url: String(url), request });
      return request.promise;
    }
    if (options.method !== 'POST') return Promise.resolve(response(null, 404));
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), auth: options.headers.Authorization, ...body });
    if (deferReorder && body.channel === 'images:reorderImages') {
      const request = deferred();
      pendingReorders.push(request);
      return request.promise;
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
  };` + script.slice(end);
  const context = {
    URL: BrowserURL,
    Blob,
    Error,
    Promise,
    document,
    window,
    localStorage,
    fetch,
    location: { origin: 'http://viewer.test' },
    navigator: {},
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
