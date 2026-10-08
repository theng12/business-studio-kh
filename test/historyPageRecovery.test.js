const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const ROOT = path.resolve(__dirname, '..');
function harness() {
  const hooks = [];
  const effects = [];
  let index = 0;
  const react = {
    useState(initial) { const i = index++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
    useMemo(fn, deps) { const i = index++; const old = hooks[i]; if (!old || deps.some((d, n) => !Object.is(d, old.deps[n]))) hooks[i] = { value: fn(), deps }; return hooks[i].value; },
    useEffect(fn, deps) { const i = index++; const old = effects[i]; if (!old || deps.some((d, n) => !Object.is(d, old.deps[n]))) { old?.cleanup?.(); effects[i] = { fn, deps, ran: false }; } },
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const source = fs.readFileSync(path.join(ROOT, 'renderer/modules/History/index.jsx'), 'utf8');
  const built = esbuild.transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const module = { exports: {} };
  const store = { attributionUsers: {}, allProducts: [], brands: [], categories: [], addToast() {} };
  const ui = Object.fromEntries(['Button', 'EmptyState', 'Input', 'Pagination', 'Select', 'PageHeader', 'HistoryModal'].map((n) => [n, n]));
  vm.runInNewContext(built, { module, exports: module.exports, window: global.window, setTimeout, clearTimeout,
    require(id) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (id.endsWith('store/index.js')) return { useAppStore: (select) => select(store) };
      if (id.endsWith('Sidebar.jsx')) return { useUserCaps: () => [] };
      if (id.endsWith('capabilities.js')) return { hasCap: () => false };
      if (id.endsWith('format.js')) return { formatDateTime: () => 'date', timeAgo: () => 'recent' };
      return ui;
    },
  });
  return { render() { index = 0; const output = module.exports.History(); for (const effect of effects) if (effect && !effect.ran) { effect.ran = true; effect.cleanup = effect.fn(); } return output; } };
}
function all(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((n) => all(n, predicate));
  return [...(predicate(node) ? [node] : []), ...all(node.props.children, predicate), ...all(node.props.actions, predicate)];
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function feed() {
  let count = 150;
  const requests = [];
  const api = { audit: {
    listRecent: async (opts) => { requests.push(opts); return Array.from({ length: Math.max(0, Math.min(opts.limit, count - opts.offset)) }, (_, i) => ({ id: `event-${opts.offset + i}`, entityType: 'product', entityId: 'p', action: 'update' })); },
    countRecent: async () => count,
  } };
  return { api, requests, shrink: (n) => { count = n; } };
}
async function lastPage(h) {
  h.render(); await tick();
  let out = h.render();
  all(out, (n) => n.type === 'Pagination')[0].props.onPageChange(2);
  h.render(); await tick(); out = h.render();
  return out;
}

test('History Refresh clamps a removed last page and refetches surviving records', async () => {
  const f = feed(); global.window = { api: f.api };
  const h = harness(); let out = await lastPage(h);
  f.shrink(20);
  all(out, (n) => n.type === 'Button' && n.props.children === 'Refresh')[0].props.onClick();
  h.render(); await tick(); h.render(); await tick(); out = h.render();
  assert.equal(f.requests.at(-1).offset, 0, 'reload the first surviving page');
  assert.equal(all(out, (n) => n.type === 'Pagination')[0]?.props.currentPage, 0);
  assert.equal(all(out, (n) => n.type === 'tr').length, 21, 'header plus all 20 surviving rows');
});

test('History empty refresh refetches at zero offset after a total shrinks to zero', async () => {
  const f = feed(); global.window = { api: f.api };
  const h = harness(); const out = await lastPage(h);
  f.shrink(0);
  all(out, (n) => n.type === 'Button' && n.props.children === 'Refresh')[0].props.onClick();
  h.render(); await tick(); h.render(); await tick(); const empty = h.render();
  assert.equal(f.requests.at(-1).offset, 0);
  assert.equal(all(empty, (n) => n.type === 'EmptyState')[0]?.props.title, 'No history yet');
});

test('History zero totals clamp to page one and delayed old filters cannot restore a removed page', async () => {
  const f = feed(); global.window = { api: f.api };
  const h = harness(); let out = await lastPage(h);
  let rows, count;
  f.api.audit.listRecent = () => new Promise((resolve) => { rows = resolve; });
  f.api.audit.countRecent = () => new Promise((resolve) => { count = resolve; });
  all(out, (n) => n.type === 'Button' && n.props.children === 'Refresh')[0].props.onClick();
  out = h.render();
  // Switch filters while that old page's refresh is still in flight.
  const entityFilter = all(out, (n) => n.type === 'Select' && n.props['aria-label'] === 'Filter by entity type')[0];
  entityFilter.props.onChange({ target: { value: 'brand' } });
  f.shrink(0);
  f.api.audit.listRecent = async (opts) => { f.requests.push(opts); return []; };
  f.api.audit.countRecent = async () => 0;
  h.render(); h.render(); await tick(); h.render();
  rows([{ id: 'stale', entityType: 'product', entityId: 'p', action: 'update' }]); count(150);
  await tick(); out = h.render();
  assert.equal(f.requests.at(-1).offset, 0);
  assert.equal(all(out, (n) => n.type === 'tr').length, 0);
  assert.equal(all(out, (n) => n.type === 'EmptyState')[0]?.props.title, 'Nothing matches these filters');
});

function crawlerSurface(forcedLabelPage = false) {
  let current = null;
  const buttons = ['Label History', 'History'].map((text) => ({ textContent: text, innerText: text, querySelector: () => ({ textContent: text }), click() { current = forcedLabelPage ? 'Label History' : text; } }));
  const document = { querySelector(sel) { if (sel === '.page--history') return current === 'History' ? {} : null; if (sel === '.page-fallback' || sel === '.page__error') return null; return current ? { textContent: current } : null; } };
  const __ui = { all: () => buttons, textOf: (el) => el?.textContent || '', click(sel, text) { buttons.find((b) => b.textContent.includes(text))?.click(); return 'ok'; }, crash: () => null, header: () => current, bareRanges: () => [], sliderCount: () => 0, valueBoxCount: () => 0 };
  const source = fs.readFileSync(path.join(ROOT, 'scripts/probe-ui-crawl.js'), 'utf8');
  // From the sidebar helpers (2026-10-08: goto reaches other modules through
  // Home) to the end of the Crawl class.
  const from = source.indexOf('  /* Click the sidebar item with this exact label');
  const methods = source.slice(from, source.indexOf('\n}\n', from));
  const sandbox = { window: { __ui }, document, MODULE_OF_LABEL: {} };
  const crawler = vm.runInNewContext(`new (class {${methods}})()`, sandbox);
  const results = [];
  crawler.eval = async (code) => vm.runInNewContext(code, sandbox);
  crawler.waitFor = async () => {};
  crawler.settle = async () => {};
  crawler.shot = async () => {};
  crawler.step = (name, ok) => results.push({ name, ok });
  return { crawler, results, current: () => current };
}

test('crawl selects the exact sidebar History identity and rejects Label History as global coverage', async () => {
  const real = crawlerSurface();
  await real.crawler.checkPage('history', 'History');
  assert.equal(real.current(), 'History');
  assert.equal(real.results.at(-1).ok, true);
  const wrong = crawlerSurface(true);
  await wrong.crawler.checkPage('history', 'History');
  assert.equal(wrong.results.at(-1).ok, false);
});
