/**
 * Review fixes for the phone web viewer (webclient/index.html):
 *
 *   23  long single-request jobs get a long deadline, a job timeout does not
 *       flip the offline banner, and a lost templates:applyBulk reply is
 *       reconciled through templates:getApplyOutcome — never re-sent;
 *   24  coming back online resyncs even inside the 5s resync throttle;
 *   25  cards show the main image's background-removed copy (mainDisplayPath)
 *       with a stamp that changes with it — plus the products.list side;
 *   26  pinned blob URLs (spin frames, the open lightbox) survive eviction;
 *   27  Back closes the most recently opened layer, nothing is pushed from
 *       popstate, and a product opened right after closing another is not
 *       closed by the late popstate (34b);
 *   28  the pairing fragment is cleared even when it does not decode;
 *   34a a response body that outlives the header deadline is not cut off, and
 *       a body that does time out counts as a network failure.
 *
 * Pure JS: the page's script runs in a vm with a small fake DOM, fake timers,
 * a fake History API and a routed fetch. The products.list case needs the
 * native SQLite binding and skips under plain `node --test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'webclient/index.html'), 'utf8');

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
  const classNames = new Set();
  const children = [];
  const element = {
    id,
    children,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    className: '',
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    isConnected: true,
    classList: {
      add(...names) { names.forEach((n) => classNames.add(n)); },
      remove(...names) { names.forEach((n) => classNames.delete(n)); },
      toggle(name, force) {
        const next = force === undefined ? !classNames.has(name) : !!force;
        if (next) classNames.add(name); else classNames.delete(name);
        return next;
      },
      contains(name) { return classNames.has(name); },
    },
    addEventListener(name, handler) {
      const list = listeners.get(name) || [];
      list.push(handler);
      listeners.set(name, list);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler.call(element, { ...event, target: element });
      return true;
    },
    appendChild(child) { children.push(child); return child; },
    replaceChild(next) { return next; },
    removeChild() {},
    remove() {},
    setAttribute(name, value) { element[name] = String(value); },
    getAttribute(name) { return element[name] || null; },
    querySelector() { return makeElement('query-result'); },
    querySelectorAll() { return []; },
    focus() {},
    click() {},
    setPointerCapture() {},
  };
  Object.defineProperty(element, 'firstChild', { get() { return children[0] || null; } });
  return element;
}

/** A History API good enough to tell a pushState from a popstate. */
function makeHistory(windowListeners) {
  const entries = [{ state: null, url: '/m' }];
  let index = 0;
  const log = [];
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ state, url: url || entries[index].url });
      index += 1;
      log.push({ op: 'push', state, inPopstate: history.inPopstate });
    },
    replaceState(state, _title, url) {
      entries[index] = { state, url: url || entries[index].url };
      log.push({ op: 'replace', url, inPopstate: history.inPopstate });
    },
    // Traversal is asynchronous in browsers — model that.
    go(delta) {
      log.push({ op: 'go', delta, inPopstate: history.inPopstate });
      setImmediate(() => history.traverse(delta));
    },
    back() { history.go(-1); },
    inPopstate: false,
    traverse(delta) {
      const next = Math.max(0, Math.min(entries.length - 1, index + delta));
      if (next === index) return;
      index = next;
      history.inPopstate = true;
      try {
        for (const fn of windowListeners.get('popstate') || []) fn({ state: entries[index].state });
      } finally { history.inPopstate = false; }
    },
    /** The phone's Back button: a browser traversal, not page script. */
    userBack() { history.traverse(-1); },
    get index() { return index; },
    entries,
    log,
  };
  return history;
}

function loadViewer({ route = null, hash = '', session = null, withHistory = true } = {}) {
  const elements = new Map();
  const storage = new Map();
  const revokedUrls = [];
  const calls = [];
  const gets = [];
  const timers = new Map();
  let timerId = 0;
  let objectUrl = 0;
  const windowListeners = new Map();

  if (session) {
    storage.set('iskh.web.serverUrl', session.url);
    storage.set('iskh.web.token', session.token);
  }

  const document = {
    body: makeElement('body'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement(tag) { return makeElement(tag); },
    createTextNode(text) { const n = makeElement('text'); n.textContent = text; return n; },
    querySelector(selector) {
      const m = /^\.thumb\[data-thumb="([^"]+)"\]$/.exec(selector);
      return m ? document.getElementById('thumb-' + m[1]) : null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    visibilityState: 'visible',
  };
  const window = {
    innerHeight: 800,
    visualViewport: null,
    addEventListener(name, fn) {
      const list = windowListeners.get(name) || [];
      list.push(fn);
      windowListeners.set(name, list);
    },
    confirm() { return true; },
    scrollTo() {},
  };
  const history = withHistory ? makeHistory(windowListeners) : undefined;
  const BrowserURL = class extends URL {};
  BrowserURL.createObjectURL = () => `blob:test-${++objectUrl}`;
  BrowserURL.revokeObjectURL = (url) => revokedUrls.push(url);

  const fetch = (url, options = {}) => {
    const u = String(url);
    let body = null;
    if (options.method === 'POST') {
      body = JSON.parse(options.body);
      calls.push({ url: u, ...body });
    } else if (u.includes('/assets/')) {
      gets.push(u);
    }
    const routed = route ? route({ url: u, body, options }) : undefined;
    if (routed !== undefined) return routed;
    if (u.includes('/assets/')) return Promise.resolve(response(null));
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
    net: net,
    rpc: rpc,
    rpcTimeoutFor: rpcTimeoutFor,
    applyBulkTracked: applyBulkTracked,
    newOperationId: newOperationId,
    resync: resync,
    noteOffline: noteOffline,
    noteOnline: noteOnline,
    lastResyncAt: function () { return lastResyncAt; },
    setBootCompleted: function (v) { bootCompleted = v; },
    lazyThumb: lazyThumb,
    assetUrl: assetUrl,
    blobCachePut: blobCachePut,
    blobPinned: blobPinned,
    pinBlobUrl: pinBlobUrl,
    unpinBlobUrl: unpinBlobUrl,
    clearImageCaches: clearImageCaches,
    openSpin: openSpin,
    closeSpin: closeSpin,
    spinState: function () { return spinState; },
    openDetail: openDetail,
    closeDetail: closeDetail,
    openSheet: openSheet,
    closeSheet: closeSheet,
    layerStack: function () { return layerStack.slice(); },
    setSession: function (url, authToken) { baseUrl = url; token = authToken; },
  };` + script.slice(end);

  const context = {
    URL: BrowserURL,
    Blob,
    File,
    Error,
    Promise,
    Uint8Array,
    AbortController,
    document,
    window,
    localStorage: {
      getItem(k) { return storage.has(k) ? storage.get(k) : null; },
      setItem(k, v) { storage.set(k, String(v)); },
      removeItem(k) { storage.delete(k); },
    },
    fetch,
    location: { origin: 'http://viewer.test', hash, pathname: '/m', search: '' },
    navigator: {},
    atob,
    crypto: globalThis.crypto,
    IntersectionObserver: class { disconnect() {} observe() {} unobserve() {} },
    setTimeout(fn, ms) { timerId += 1; timers.set(timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { timerId += 1; return timerId; },
    clearInterval() {},
    console,
  };
  if (history) context.history = history;
  context.window.history = history;
  vm.createContext(context);
  vm.runInContext(instrumented, context);

  async function flush(n = 3) { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); }
  /** Run (and forget) every pending timer with exactly this delay. */
  function fire(ms) {
    let count = 0;
    for (const [id, t] of [...timers]) {
      if (t.ms !== ms) continue;
      timers.delete(id);
      t.fn();
      count += 1;
    }
    return count;
  }
  function pendingDelays() { return [...timers.values()].map((t) => t.ms); }

  return { hooks: window.__testHooks, calls, gets, elements, revokedUrls, history, timers, fire, pendingDelays, flush, storage };
}

/** A fetch that never answers until its signal aborts it (a stalled server). */
function hang(options) {
  return new Promise((_resolve, reject) => {
    const signal = options && options.signal;
    if (!signal) return;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

const MIN = 60 * 1000;

/* ── 23: long jobs ─────────────────────────────────────────────────── */

test('23: job channels get a 15-minute deadline; reads and ordinary writes keep theirs', () => {
  const { hooks } = loadViewer();
  for (const channel of ['templates:applyBulk', 'templates:renderZip', 'images:autoEnhanceProducts',
    'images:autoCropProducts', 'images:importFromBytes']) {
    assert.equal(hooks.rpcTimeoutFor(channel), 15 * MIN, channel);
  }
  assert.equal(hooks.rpcTimeoutFor('products:list'), 20000);
  assert.equal(hooks.rpcTimeoutFor('templates:getApplyOutcome'), 20000);
  assert.equal(hooks.rpcTimeoutFor('images:reorderImages'), 2 * MIN);
});

test('23: a job that outlives its deadline says "may still finish" and does NOT show the offline banner', async () => {
  const v = loadViewer({ route: ({ body, options }) => (body && body.channel === 'templates:renderZip' ? hang(options) : undefined) });
  v.hooks.setSession('http://mac.test:13180', 'tok');
  let error = null;
  v.hooks.rpc('templates:renderZip', { templateId: 't', items: [] }).catch((e) => { error = e; });
  await v.flush();
  assert.equal(v.fire(2 * MIN), 0, 'no 2-minute deadline on a job channel');
  assert.equal(v.fire(15 * MIN), 1, 'the 15-minute deadline');
  await v.flush();
  assert.ok(error, 'the request gave up');
  assert.equal(error.timedOut, true);
  assert.match(error.message, /may still finish/);
  assert.equal(v.hooks.net.offline, false, 'a busy server is not an offline one');
  assert.notEqual(v.elements.get('netBanner') && v.elements.get('netBanner').hidden, false, 'no banner');
});

test('23: an ordinary read that times out still shows the offline banner', async () => {
  const v = loadViewer({ route: ({ body, options }) => (body && body.channel === 'products:list' ? hang(options) : undefined) });
  v.hooks.setSession('http://mac.test:13180', 'tok');
  let error = null;
  v.hooks.rpc('products:list', {}).catch((e) => { error = e; });
  await v.flush();
  assert.equal(v.fire(20000), 1);
  await v.flush();
  assert.equal(error.network, true);
  assert.equal(v.hooks.net.offline, true);
  assert.equal(v.elements.get('netBanner').hidden, false);
});

test('23: operation ids are v4 UUIDs the server validator accepts', () => {
  const { hooks } = loadViewer();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const id = hooks.newOperationId();
    assert.match(id, isUuid);
    seen.add(id);
  }
  assert.equal(seen.size, 50);
});

function applyRoute(outcomes) {
  return ({ body }) => {
    if (!body) return undefined;
    if (body.channel === 'templates:applyBulk') return Promise.reject(new TypeError('Failed to fetch'));
    if (body.channel === 'templates:getApplyOutcome') {
      const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
      return Promise.resolve(response({ operationId: body.args.operationId, ...next }));
    }
    return undefined;
  };
}

test('23: a lost applyBulk reply is reconciled through getApplyOutcome, and the apply is never re-sent', async () => {
  const v = loadViewer({ route: applyRoute([{ status: 'pending' }, { status: 'succeeded', summary: { imagesCount: 3, productsCount: 2 } }]) });
  v.hooks.setSession('http://mac.test:13180', 'tok');
  let result = null;
  let error = null;
  v.hooks.applyBulkTracked({ templateId: 't1', productIds: ['p1', 'p2'], destination: { kind: 'append' } })
    .then((r) => { result = r; }, (e) => { error = e; });
  await v.flush();
  assert.equal(v.fire(3000), 1, 'polls again after a pending answer');
  await v.flush();
  assert.equal(error, null);
  assert.equal(result.reconciled, true);
  assert.equal(result.summary.imagesCount, 3);
  const applies = v.calls.filter((c) => c.channel === 'templates:applyBulk');
  const polls = v.calls.filter((c) => c.channel === 'templates:getApplyOutcome');
  assert.equal(applies.length, 1, 'never re-sent');
  assert.equal(polls.length, 2);
  assert.ok(applies[0].args.operationId, 'the apply carries an operationId');
  assert.equal(polls[0].args.operationId, applies[0].args.operationId, 'the poll asks about that same run');
});

test('23: an unconfirmable outcome is reported as "check before running again", not as a failure', async () => {
  const v = loadViewer({ route: applyRoute([{ status: 'lost' }]) });
  v.hooks.setSession('http://mac.test:13180', 'tok');
  let error = null;
  v.hooks.applyBulkTracked({ templateId: 't1', productIds: ['p1'], destination: { kind: 'append' } })
    .catch((e) => { error = e; });
  await v.flush();
  assert.ok(error);
  assert.equal(error.unconfirmed, true);
  assert.match(error.message, /Check the photos before running it again/);
  assert.equal(v.calls.filter((c) => c.channel === 'templates:applyBulk').length, 1);
});

test('23: an applyBulk the server answered with an error is a plain failure (no polling)', async () => {
  const v = loadViewer({ route: ({ body }) => (body && body.channel === 'templates:applyBulk' ? Promise.resolve(response('Template not found', 400)) : undefined) });
  v.hooks.setSession('http://mac.test:13180', 'tok');
  let error = null;
  v.hooks.applyBulkTracked({ templateId: 't1', productIds: ['p1'], destination: { kind: 'append' } })
    .catch((e) => { error = e; });
  await v.flush();
  assert.equal(error.message, 'Template not found');
  assert.equal(v.calls.filter((c) => c.channel === 'templates:getApplyOutcome').length, 0);
});

/* ── 24: back online is never throttled away ───────────────────────── */

test('24: the "back online" resync runs even inside the 5s throttle', async () => {
  const v = loadViewer();
  v.hooks.setSession('http://mac.test:13180', 'tok');
  v.hooks.setBootCompleted(true);
  v.hooks.state.companyId = 'c1';
  const lists = () => v.calls.filter((c) => c.channel === 'products:list').length;
  v.hooks.resync('foreground');
  const first = v.hooks.lastResyncAt();
  assert.ok(first > 0);
  await v.flush();
  assert.equal(lists(), 1, 'the foreground resync reloaded the list');
  v.hooks.noteOffline();          // that reload failed: Wi-Fi still reconnecting
  v.hooks.noteOnline();           // ~2s later the server answers again, inside the 5s throttle
  await v.flush();
  assert.equal(lists(), 2, 'the recovery resync actually asked the server again');
  assert.ok(v.hooks.lastResyncAt() >= first);
});

/* ── 25: cards show the processed main image ───────────────────────── */

test('25: a card asks for mainDisplayPath with a stamp that follows the processed copy', async () => {
  const v = loadViewer();
  v.hooks.setSession('http://mac.test:13180', 'tok');
  v.hooks.lazyThumb({
    id: 'p1', imageCount: 1, updatedAt: 111,
    mainImagePath: 'Co/SKU-1/SKU-1-001.jpg',
    mainDisplayPath: 'processed/SKU-1/SKU-1-001.png',
    mainDisplayStamp: 'abc.4.1',
  });
  await v.flush();
  assert.equal(v.gets.length, 1);
  assert.match(v.gets[0], /\/assets\/processed\/SKU-1\/SKU-1-001\.png\?w=320&v=111\.abc\.4\.1$/);

  // An older server without the new field still gets the old behaviour.
  v.hooks.lazyThumb({ id: 'p2', imageCount: 1, updatedAt: 5, mainImagePath: 'Co/SKU-2/SKU-2-001.jpg' });
  await v.flush();
  assert.match(v.gets[1], /\/assets\/Co\/SKU-2\/SKU-2-001\.jpg\?w=320&v=5$/);
});

let dbStack = null;
let skipDb = false;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  dbStack = {
    db: require('../main/db/index'),
    companies: require('../main/db/companies'),
    products: require('../main/db/products'),
    productImages: require('../main/db/productImages'),
  };
} catch (err) {
  if (err && err.code === 'ERR_DLOPEN_FAILED') {
    skipDb = "better-sqlite3 is built for Electron's ABI, not this Node — run `npm run test:native`";
  } else {
    throw err;
  }
}

test('25: products.list returns the processed main image as mainDisplayPath, with a stamp that changes with it', { skip: skipDb }, () => {
  const { db, companies, products, productImages } = dbStack;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msk-maindisplay-'));
  db.initDb(dataDir);
  const company = companies.create({ name: 'Display Co', isActive: true });
  const product = products.create({ companyId: company.id, sku: 'D-1', name: 'Display' });
  const rel = 'Display-Co/_unassigned/D-1/D-1-001.jpg';
  fs.mkdirSync(path.join(dataDir, 'assets', path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'assets', rel), Buffer.from('jpeg bytes'));
  productImages.addRow(product.id, {
    filepath: rel, filename: path.posix.basename(rel), originalFilepath: rel, contentHash: 'h1', orderIndex: 0,
  });

  let row = products.list(company.id).find((p) => p.id === product.id);
  assert.equal(row.mainImagePath, rel);
  assert.equal(row.mainDisplayPath, rel, 'no processed copy yet: the original');
  const stampBefore = row.mainDisplayStamp;

  productImages.setProcessed(product.id, rel, {
    isProcessed: true, processedFilepath: 'processed/D-1/D-1-001.png', workspaceSettings: null,
  });
  row = products.list(company.id).find((p) => p.id === product.id);
  assert.equal(row.mainImagePath, rel, 'mainImagePath stays the original (desktop unchanged)');
  assert.equal(row.mainDisplayPath, 'processed/D-1/D-1-001.png');
  assert.notEqual(row.mainDisplayStamp, stampBefore, 'the stamp follows the displayed bytes');

  assert.equal(Object.prototype.hasOwnProperty.call(products.get(product.id), 'mainDisplayPath'), false,
    'only products.list carries the field, so no other query reports a misleading null');
});

/* ── 26: pinned blob URLs are not evicted ──────────────────────────── */

test('26: eviction and clearImageCaches skip pinned URLs; unpinning releases them', () => {
  const v = loadViewer();
  const { hooks } = v;
  hooks.blobCachePut('frame-0', { url: 'blob:frame-0', productId: 'p1', bytes: 30 * 1024 * 1024 });
  hooks.pinBlobUrl('blob:frame-0');
  for (let i = 1; i <= 4; i += 1) {
    hooks.blobCachePut('frame-' + i, { url: 'blob:frame-' + i, productId: 'p1', bytes: 30 * 1024 * 1024 });
  }
  assert.equal(v.revokedUrls.includes('blob:frame-0'), false, 'the pinned first frame survives the 80 MB cap');
  assert.ok(v.revokedUrls.includes('blob:frame-1'), 'an unpinned older entry is evicted instead');

  hooks.clearImageCaches('p1');
  assert.equal(v.revokedUrls.includes('blob:frame-0'), false, 'still on screen: not revoked by a cache clear');
  hooks.unpinBlobUrl('blob:frame-0');
  assert.ok(v.revokedUrls.includes('blob:frame-0'), 'released once its viewer lets go');
});

test('26: every spin frame is pinned while the spin is open, and unpinned on close', async () => {
  const imgs = [1, 2, 3].map((n) => ({ id: 'i' + n, filepath: `S/S-00${n}.jpg` }));
  const okAssets = loadViewer({
    route: ({ url, body }) => {
      if (body && body.channel === 'images:listByProduct') return Promise.resolve(response(imgs));
      if (url.includes('/assets/')) return Promise.resolve({ ok: true, status: 200, async blob() { return new Blob(['x']); } });
      return undefined;
    },
  });
  okAssets.hooks.setSession('http://mac.test:13180', 'tok');
  okAssets.hooks.openSpin('p1');
  await okAssets.flush(6);
  const spin = okAssets.hooks.spinState();
  assert.ok(spin, 'the spin opened');
  assert.equal(spin.urls.length, 3);
  for (const url of spin.urls) assert.equal(okAssets.hooks.blobPinned(url), true, url + ' pinned');
  const urls = spin.urls.slice();
  okAssets.hooks.closeSpin();
  for (const url of urls) assert.equal(okAssets.hooks.blobPinned(url), false, url + ' unpinned');
});

/* ── 27 / 34b: Back and the layer stack ────────────────────────────── */

test('27: one entry per layer, pushed at open time; Back closes the most recent layer and pushes nothing', async () => {
  const v = loadViewer();
  const { hooks, history } = v;
  hooks.openDetail({ id: 'p1', sku: 'SKU-1', imageCount: 0 });
  await v.flush();
  hooks.openSheet('zipSheet');
  await v.flush();
  hooks.openSheet('companySheet'); // earlier in the DOM than zipSheet, but opened last
  await v.flush();
  assert.equal(history.index, 3, 'three layers, three entries');
  assert.deepEqual([...hooks.layerStack()], ['detail', 'zipSheet', 'companySheet']);

  history.userBack();
  await v.flush();
  assert.equal(v.elements.get('companySheet').classList.contains('open'), false, 'the most recently opened sheet closed');
  assert.equal(v.elements.get('zipSheet').classList.contains('open'), true, 'not the last one in DOM order');
  assert.equal(v.elements.get('detail').classList.contains('open'), true);

  history.userBack();
  await v.flush();
  history.userBack();
  await v.flush();
  assert.equal(v.elements.get('detail').classList.contains('open'), false);
  assert.deepEqual([...hooks.layerStack()], []);
  assert.equal(history.index, 0);
  assert.equal(history.log.filter((e) => e.op === 'push' && e.inPopstate).length, 0, 'nothing pushed from popstate');
});

test('27: a layer closed by its own button drops its entry, so Back then leaves normally', async () => {
  const v = loadViewer();
  const { hooks, history } = v;
  hooks.openDetail({ id: 'p1', sku: 'SKU-1', imageCount: 0 });
  await v.flush();
  hooks.openSheet('sortSheet');
  await v.flush();
  assert.equal(history.index, 2);
  hooks.closeSheet('sortSheet');
  await v.flush();
  assert.equal(history.index, 1);
  hooks.closeDetail();
  await v.flush();
  assert.equal(history.index, 0);
});

test('34b: a product opened right after closing another is not closed by the late popstate', async () => {
  const v = loadViewer();
  const { hooks, history } = v;
  hooks.openDetail({ id: 'p1', sku: 'SKU-1', imageCount: 0 });
  await v.flush();
  hooks.closeDetail();
  await Promise.resolve();        // the go(-1) is issued but has not landed yet
  await Promise.resolve();
  hooks.openDetail({ id: 'p2', sku: 'SKU-2', imageCount: 0 });
  await v.flush(6);
  assert.equal(v.elements.get('detail').classList.contains('open'), true, 'p2 stays open');
  assert.deepEqual([...hooks.layerStack()], ['detail']);
  assert.equal(history.index, 1, 'and it has its own Back entry');
  history.userBack();
  await v.flush();
  assert.equal(v.elements.get('detail').classList.contains('open'), false, 'Back closes it');
});

/* ── 28: the pairing fragment is always cleared ────────────────────── */

test('28: a malformed #t= fragment is still removed from the address bar', () => {
  const v = loadViewer({ hash: '#t=%E0%A4%A' });
  const replaced = v.history.log.filter((e) => e.op === 'replace');
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].url, '/m');
  assert.equal(v.storage.has('iskh.web.token'), false, 'nothing stored from an undecodable token');
});

test('28: a good #t= token is stored and the fragment cleared', () => {
  const v = loadViewer({ hash: '#t=abc123' });
  const replaced = v.history.log.filter((e) => e.op === 'replace');
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].url, '/m');
  assert.ok([...v.storage.values()].includes('abc123'));
});

test('28: the desktop pairing hint tells the user they can clear the page from history', () => {
  const panel = fs.readFileSync(path.join(root, 'renderer/modules/Settings/MultiMacPanel.jsx'), 'utf8');
  assert.match(panel, /After pairing, you can clear this page from the phone&rsquo;s browser history\./);
});

/* ── 34a: the header deadline does not cut off a slow body ─────────── */

test('34a: once headers arrive the 20s deadline is replaced by the body deadline', async () => {
  let resolveBody;
  const v = loadViewer({
    route: ({ body }) => {
      if (!body || body.channel !== 'products:list') return undefined;
      return Promise.resolve({
        ok: true, status: 200,
        json() { return new Promise((r) => { resolveBody = r; }); },
      });
    },
  });
  v.hooks.setSession('http://mac.test:13180', 'tok');
  let result = null;
  v.hooks.rpc('products:list', {}).then((r) => { result = r; });
  await v.flush();
  assert.equal(v.pendingDelays().includes(20000), false, 'the header deadline is gone once headers arrived');
  assert.ok(v.pendingDelays().includes(2 * MIN), 'the body has its own, longer deadline');
  resolveBody({ result: [{ id: 'p1' }] });
  await v.flush();
  assert.deepEqual(result, [{ id: 'p1' }]);
  assert.equal(v.pendingDelays().includes(2 * MIN), false, 'and it is cleared when the body is in');
});

test('34a: a body that times out is a network failure (banner + retry), not an unclassified error', async () => {
  const v = loadViewer({
    route: ({ body, options }) => {
      if (!body || body.channel !== 'products:list') return undefined;
      return Promise.resolve({ ok: true, status: 200, json() { return hang(options); } });
    },
  });
  v.hooks.setSession('http://mac.test:13180', 'tok');
  let error = null;
  v.hooks.rpc('products:list', {}).catch((e) => { error = e; });
  await v.flush();
  assert.equal(v.fire(2 * MIN), 1);
  await v.flush();
  assert.equal(error.network, true);
  assert.equal(error.timedOut, true);
  assert.equal(v.hooks.net.offline, true, 'the banner logic saw it');
});
