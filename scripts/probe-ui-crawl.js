#!/usr/bin/env node
/**
 * Full-app UI usage crawl — clicks through every screen and looks for the bugs
 * the unit suite cannot see.
 *
 * WHY THIS EXISTS. `npm run check` covers utilities, the database and the
 * renderers, but it never mounts a React screen. The bugs that actually reach
 * the owner are screen bugs: a page that throws into its error boundary, a
 * control that silently stops saving, a price that prints as `$NaN`, a slider
 * that lost its typeable value box. None of those fail a unit test. So this
 * drives the REAL app through the Chrome DevTools Protocol and reports what it
 * finds.
 *
 * WHAT IT DOES
 *   1. boots an isolated copy (its own user-data dir + data folder), creates a
 *      company through the UI, then
 *   2. visits every sidebar page, one by one — recording a screenshot, the page
 *      title, any crash into the error boundary, and any `input[type=range]`
 *      that is missing its typeable value box (the v0.1.53/v0.1.58 fix), then
 *   3. clicks every Settings tab,
 *   4. exercises the flows that were recently changed: What's new (Esc and
 *      backdrop dismissal), the price-group add flow reaching the Social Grid
 *      picker, and a typed value through a slider's number box.
 *
 * Usage — the app must ALREADY be running with a debugging port:
 *
 *     env -u ELECTRON_RUN_AS_NODE npx electron . --remote-debugging-port=9333 \
 *       --user-data-dir=/tmp/mskh-ui/userdata
 *     node scripts/probe-ui-crawl.js --port 9333 --out /tmp/mskh-ui/shots
 *
 * Exits 0 when every step passed, 1 otherwise. Screenshots land in `--out` so a
 * human can eyeball them (`open /tmp/mskh-ui/shots`).
 *
 * SAFETY. It writes to whatever profile the running app was launched with. Use
 * a throwaway `--user-data-dir` (and a `config.json` inside it pointing at a
 * scratch data folder) so no real data is touched.
 */
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const DEFAULT_PORT = 9333;
const DEFAULT_OUT = path.join(require('node:os').tmpdir(), 'mskh-ui-crawl');
const BOOT_TIMEOUT_MS = 30_000;
const SETTLE_MS = 450;

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, out: DEFAULT_OUT, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--port') out.port = Number(argv[++i]);
    else if (flag === '--out') out.out = path.resolve(argv[++i]);
    else if (flag === '--verbose') out.verbose = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!Number.isFinite(out.port) || out.port <= 0) throw new Error('--port must be a number');
  return out;
}

/* ── CDP plumbing ─────────────────────────────────────────────────────── */

async function findPageTarget(port) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastErr = 'no /json/list response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
      lastErr = `no page target yet (${list.length} targets)`;
    } catch (err) {
      lastErr = err.message;
    }
    await delay(500);
  }
  throw new Error(`could not find a debuggable page on port ${port}: ${lastErr}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    const pending = new Map();
    const listeners = new Set();
    let seq = 0;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${entry.method} → ${msg.error.message}${msg.error.data ? ` — ${msg.error.data}` : ''}`));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of listeners) fn(msg);
    });
    ws.on('error', (err) => { reject(err); for (const [, p] of pending) p.reject(err); pending.clear(); });
    ws.on('open', () => {
      resolve({
        send(method, params) {
          seq += 1;
          const id = seq;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej, method });
            ws.send(JSON.stringify({ id, method, params: params ?? {} }));
          });
        },
        on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        close() { try { ws.close(); } catch { /* best effort */ } },
      });
    });
  });
}

/* ── In-page toolkit ─────────────────────────────────────────────────── */

// Injected once. React owns the inputs, so a plain `el.value = x` is ignored:
// the native setter plus an `input` event is what actually updates state.
const TOOLKIT = `
window.__ui = (() => {
  const setNative = (el, value) => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const find = (sel, text) => all(sel).find((el) => textOf(el).includes(text)) || null;
  const api = {
    all, find, textOf,
    count: (sel) => all(sel).length,
    pick: (sel, text) => (text === undefined ? document.querySelector(sel) : find(sel, text)),
    click: (sel, text) => {
      const el = api.pick(sel, text);
      if (!el) return 'MISS ' + sel + (text === undefined ? '' : ' :: ' + text);
      el.click();
      return 'ok';
    },
    set: (sel, value, text) => {
      const el = api.pick(sel, text);
      if (!el) return 'MISS ' + sel + (text === undefined ? '' : ' :: ' + text);
      el.focus();
      setNative(el, String(value));
      return 'ok';
    },
    /* Type into a text/number box the way a user does, then commit. */
    typeAndEnter: (sel, value, text) => {
      const el = api.pick(sel, text);
      if (!el) return 'MISS ' + sel + (text === undefined ? '' : ' :: ' + text);
      el.focus();
      setNative(el, String(value));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.blur();
      return 'ok';
    },
    /* The shared Modal closes on MOUSEDOWN on .modal-backdrop (see
     * components/ui.jsx), and only when the event target is the backdrop
     * itself — a synthetic click event never reaches that handler. */
    mouseDown: (sel) => {
      const el = api.pick(sel);
      if (!el) return 'MISS ' + sel;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return 'ok';
    },
    pressEscape: () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'ok';
    },
    /* Field-based lookups, covering BOTH form styles in this app:
     *   - the shared <Field> component: .field > .field__label + control
     *   - a plain <label>Text<input/></label> wrapper (the catalog controls)
     * The visible text of a bare label includes its options' text, so only the
     * label's OWN text nodes are compared — otherwise "Page" would match
     * "Page margin (mm)" and every <option> underneath it. */
    ownText: (el) => Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(' ')
      .trim(),
    field: (label) => all('.field').find((f) => textOf(f.querySelector('.field__label')).replace(/\\s*\\*$/, '') === label) || null,
    labelFor: (label) => all('label').find((l) => {
      if (l.classList.contains('switch-row')) return false;
      const own = api.ownText(l).replace(/\\s*\\*$/, '');
      if (!own) return false;
      return own === label || own.startsWith(label);
    }) || null,
    fieldInput: (label) => {
      const f = api.field(label);
      if (f) return f.querySelector('input, textarea, select');
      const l = api.labelFor(label);
      return l ? l.querySelector('input, textarea, select') : null;
    },
    fieldSet: (label, value) => {
      const el = api.fieldInput(label);
      if (!el) return 'MISS field ' + label;
      el.focus();
      setNative(el, String(value));
      return 'ok';
    },
    fieldValue: (label) => {
      const el = api.fieldInput(label);
      return el ? el.value : null;
    },
    fieldOptions: (label) => {
      const el = api.fieldInput(label);
      if (!el || el.tagName !== 'SELECT') return null;
      return Array.from(el.querySelectorAll('option')).map(textOf);
    },
    /* Case-insensitive text click — section headers render as CSS uppercase. */
    clickLike: (sel, text) => {
      const el = all(sel).find((e) => textOf(e).toLowerCase().includes(String(text).toLowerCase()));
      if (!el) return 'MISS ' + sel + ' :: ' + text;
      el.click();
      return 'ok';
    },
    /* Exact-text button click — '+ New product', 'Save', 'Add group' … */
    clickExact: (text) => {
      const el = all('button').find((b) => textOf(b) === text);
      if (!el) return 'MISS button :: ' + text;
      el.click();
      return 'ok';
    },
    toastText: () => all('.toast').map(textOf).join(' | '),
    /* The Process -> button that belongs to the row/tile carrying that SKU.
     * Needed because the Library lists many rows and the first Process button
     * on the page is not necessarily the one we just created. */
    clickProcessFor: (needle) => {
      const btns = all('button').filter((b) => textOf(b) === 'Process →');
      const hit = btns.find((b) => {
        let n = b;
        for (let i = 0; i < 8 && n; i += 1, n = n.parentElement) if (textOf(n).includes(needle)) return true;
        return false;
      });
      if (!hit) return 'MISS Process for ' + needle + ' (' + btns.length + ' Process button(s) on screen)';
      hit.click();
      return 'ok';
    },
    /* Real mouse gestures. React's synthetic handlers listen on the root, and
     * the designer's drag code listens on window, so dispatching a genuine
     * mousedown on the target and mousemove/mouseup on window is the same path a
     * hand takes — a plain .click() cannot exercise a drag at all. */
    mouseDragPoint: async (target, fromX, fromY, toX, toY) => {
      const fire = (node, type, cx, cy) => node.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
      }));
      fire(target, 'mousedown', fromX, fromY);
      await new Promise((r) => setTimeout(r, 30));
      fire(window, 'mousemove', (fromX + toX) / 2, (fromY + toY) / 2);
      await new Promise((r) => setTimeout(r, 30));
      fire(window, 'mousemove', toX, toY);
      await new Promise((r) => setTimeout(r, 30));
      fire(window, 'mouseup', toX, toY);
      return 'ok';
    },
    /* Drag a selector from its centre by (dx, dy) client pixels. */
    mouseDrag: async (sel, dx, dy, text) => {
      const candidates = all(sel);
      const el = text
        ? candidates.find((e) => (e.getAttribute('title') || '').includes(text)) || candidates[candidates.length - 1]
        : candidates[candidates.length - 1];
      if (!el) return 'MISS ' + sel;
      if (!el) return 'MISS ' + sel;
      const r = el.getBoundingClientRect();
      return api.mouseDragPoint(el, r.left + r.width / 2, r.top + r.height / 2,
        r.left + r.width / 2 + dx, r.top + r.height / 2 + dy);
    },
    /* Shift-click the Nth canvas element (0 = first). Used to build a
     * multi-selection without depending on where the boxes happen to sit. */
    clickElAt: (index, shift) => {
      const list = all('.ld-el');
      const el = list[index];
      if (!el) return 'MISS index ' + index;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, shiftKey: !!shift }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0, shiftKey: !!shift }));
      return 'ok';
    },
    /* Drag the 'se' handle of the selected element's box. */
    mouseDragHandle: async (sel, dir, dx, dy) => {
      const handle = document.querySelector(sel + ' .ld-handle--' + dir)
        || document.querySelector('.ld-el[title*="Text"] .ld-handle--' + dir);
      if (!handle) return 'MISS handle ' + dir;
      const r = handle.getBoundingClientRect();
      return api.mouseDragPoint(handle, r.left + r.width / 2, r.top + r.height / 2,
        r.left + r.width / 2 + dx, r.top + r.height / 2 + dy);
    },
    /* Element boxes on the designer canvas carry their kind in the title
     * attribute (their text is the product value they will print), so match
     * on that rather than on text content. */
    elBox: (sel, title) => {
      const list = all(sel);
      // No title → the LAST box in paint order, which is the element most
      // recently added (equal z sorts stable). Picking by title is ambiguous
      // when several elements share a kind.
      const el = title
        ? list.find((e) => (e.getAttribute('title') || '').includes(title))
        : list[list.length - 1];
      if (!el) return null;
      return { left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0,
        width: parseFloat(el.style.width) || 0, height: parseFloat(el.style.height) || 0 };
    },
    crash: () => {
      const box = document.querySelector('.page__error');
      if (!box) return null;
      const msg = document.querySelector('.page__error-message');
      return msg ? textOf(msg) : textOf(box);
    },
    header: () => textOf(document.querySelector('.page__header')),
    openModal: () => {
      const m = document.querySelector('.modal, .modal__box, [role="dialog"]');
      return m ? textOf(m).slice(0, 400) : null;
    },
    modalCount: () => document.querySelectorAll('.modal, [role="dialog"]').length,
    /* Every slider must be the shared SliderField: a range input inside
     * .slider-field, paired with the typeable number box. Anything else is the
     * v0.1.53 regression coming back. */
    bareRanges: () => all('input[type="range"]')
      .filter((r) => !r.closest('.slider-field'))
      .map((r) => (r.id || r.name || r.getAttribute('aria-label') || r.outerHTML.slice(0, 120))),
    sliderCount: () => all('.slider-field').length,
    valueBoxCount: () => all('.slider-field input[type="number"]').length,
    optionLabels: (sel) => (document.querySelector(sel) ? all(sel + ' option').map(textOf) : null),
  };
  return api;
})();
'ready'
`;

/* ── Runner ──────────────────────────────────────────────────────────── */

class Crawl {
  constructor(cdp, outDir, verbose) {
    this.cdp = cdp;
    this.outDir = outDir;
    this.verbose = verbose;
    this.results = [];
    this.errors = [];
    this.phase = 'boot';
    this.shots = [];
    this.cdp.on((msg) => this.onEvent(msg));
  }

  onEvent(msg) {
    const { method, params } = msg;
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      const text = d.exception?.description || d.text || 'unknown exception';
      this.errors.push({ phase: this.phase, kind: 'exception', text: text.split('\n')[0].slice(0, 400) });
    } else if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(params.type)) {
      const text = (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 400);
      this.errors.push({ phase: this.phase, kind: `console.${params.type}`, text });
    } else if (method === 'Log.entryAdded' && ['error'].includes(params.entry.level)) {
      this.errors.push({ phase: this.phase, kind: 'log', text: `${params.entry.text} ${params.entry.url || ''}`.slice(0, 400) });
    }
  }

  async start() {
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Log.enable');
    await this.cdp.send('Page.enable');
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    // A crawl page is never the front window, and Chromium reports it as
    // hidden — which makes window.queryLocalFonts() reject with "Page needs to
    // be visible" before it reads anything. Focus emulation puts the page in the
    // state a real user's window is in, so the font-picker check below tests the
    // real code path instead of the fallback list.
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.eval(TOOLKIT);
  }

  async eval(expression, awaitPromise = false) {
    if (this.verbose) process.stdout.write(`    · ${expression.replace(/\s+/g, ' ').slice(0, 120)}\n`);
    const res = await this.cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page eval failed: ${d.exception?.description || d.text}`);
    }
    return res.result.value;
  }

  async waitFor(expression, timeoutMs = 12_000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    // `Boolean(...)` matters: an expression like `a || b` completes with a DOM
    // node, and CDP cannot serialise one for `returnByValue` — it fails the
    // whole call with "Object reference chain is too long".
    const probe = `Boolean(${expression})`;
    while (Date.now() < deadline) {
      last = await this.eval(probe);
      if (last) return last;
      await delay(120);
    }
    throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
  }

  async settle(ms = SETTLE_MS) { await delay(ms); }

  async shot(name) {
    const res = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(this.outDir, `${String(this.shots.length + 1).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    this.shots.push(file);
    return file;
  }

  step(name, ok, detail = '') {
    this.results.push({ step: name, ok: !!ok, detail: String(detail) });
    const mark = ok ? 'ok  ' : 'FAIL';
    process.stdout.write(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}\n`);
  }

  /* Navigate by clicking the real sidebar button. */
  async goto(label) {
    const res = await this.eval(`window.__ui.click('.sidebar__item', ${JSON.stringify(label)})`);
    if (res !== 'ok') throw new Error(`sidebar item not found: ${label} (${res})`);
    await this.waitFor(
      `!document.querySelector('.page-fallback') && (document.querySelector('.page__header') || document.querySelector('.page__error'))`,
      15_000,
      `page ${label} to render`,
    );
    await this.settle();
  }

  async checkPage(id, label) {
    this.phase = `page:${id}`;
    await this.goto(label);
    const crash = await this.eval('window.__ui.crash()');
    const header = await this.eval('window.__ui.header()');
    const bare = await this.eval('window.__ui.bareRanges()');
    const sliders = await this.eval('window.__ui.sliderCount()');
    const boxes = await this.eval('window.__ui.valueBoxCount()');
    await this.shot(id);
    if (crash) {
      this.step(`page ${id}`, false, `CRASHED: ${crash}`);
      return;
    }
    const detail = [`“${(header || '(no header)').replace(/\s+/g, ' ').slice(0, 60)}”`];
    if (sliders) detail.push(`${sliders} slider(s), ${boxes}/${sliders} value box(es)`);
    if (bare.length) {
      this.step(`page ${id}`, false, `bare range input(s) outside SliderField: ${JSON.stringify(bare)}`);
      return;
    }
    this.step(`page ${id}`, true, detail.join(' · '));
  }
}

/**
 * The flows a "no product selected" screen never reaches. Creates a product
 * through the real form, imports a synthetic photo over the same IPC the
 * clipboard/folder paths use, opens it in the Image Workspace through the
 * Process router, and drives the sliders there.
 */
async function deepImageFlow(crawl, photoPath) {
  crawl.phase = 'deep: create product';
  await crawl.goto('Product Library');
  const sku = `UI-CRAWL-${String(Date.now()).slice(-6)}`;
  const opened = await crawl.eval(`window.__ui.clickExact('+ New product')`);
  if (opened !== 'ok') { crawl.step('deep: open the product form', false, opened); return; }
  await crawl.waitFor(`!!document.querySelector('input[placeholder="e.g. BBC-TILE-001"]')`, 8000, 'the product form');
  await crawl.eval(`window.__ui.set('input[placeholder="e.g. BBC-TILE-001"]', ${JSON.stringify(sku)})`);
  await crawl.eval(`window.__ui.fieldSet('Name', 'UI Crawl Widget')`);
  await crawl.settle(400);
  await crawl.eval(`window.__ui.clickExact('Create')`);
  await crawl.settle(1400);

  const created = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    const ps = await window.api.products.list(cid, {});
    const p = ps.find((x) => x.sku === ${JSON.stringify(sku)});
    return p ? { id: p.id, sku: p.sku, name: p.name } : null;
  })()`, true).catch((err) => ({ error: err.message }));
  if (!created || created.error || !created.id) {
    crawl.step('deep: create product', false, JSON.stringify(created).slice(0, 200));
    return;
  }
  crawl.step('deep: create product', true, `${created.sku} · ${created.name}`);

  crawl.phase = 'deep: import image';
  let imported;
  try {
    imported = await crawl.eval(`window.api.images.importForProduct(${JSON.stringify(created.id)}, ${JSON.stringify(photoPath)})`, true);
    crawl.step('deep: import a photo', !!imported, JSON.stringify(imported).slice(0, 140));
  } catch (err) {
    crawl.step('deep: import a photo', false, err.message);
  }

  crawl.phase = 'deep: open the workspace';
  // Close the create form, then use the row's Process router — the same path a
  // user takes. `Create` leaves the form open on purpose.
  await crawl.eval(`window.__ui.clickExact('Cancel')`);
  await crawl.settle(600);
  const routed = await crawl.eval(`window.__ui.clickProcessFor(${JSON.stringify(sku)})`);
  if (routed !== 'ok') { crawl.step('deep: open Process router', false, routed); return; }
  await crawl.waitFor(`!!document.querySelector('.process-dest__label')`, 6000, 'the Process destination modal');
  await crawl.eval(`window.__ui.click('.process-dest__label', 'Image Workspace')`);
  await crawl.waitFor(`!!document.querySelector('input[aria-label="Product fill value"]')`, 15_000, 'the workspace settings panel');
  await crawl.settle(600);
  const crash = await crawl.eval('window.__ui.crash()');
  if (crash) { crawl.step('deep: workspace opens', false, `CRASHED: ${crash}`); return; }
  const boxes = await crawl.eval(`window.__ui.all('.slider-field input[type="number"]').map((i) => i.getAttribute('aria-label'))`);
  const bare = await crawl.eval('window.__ui.bareRanges()');
  await crawl.shot('workspace-with-image');
  crawl.step('deep: workspace opens', true, `value boxes: ${JSON.stringify(boxes)}`);
  if (bare.length) crawl.step('deep: no bare ranges in the workspace', false, JSON.stringify(bare));

  /* typed values must commit through the number box, not only the drag */
  await crawl.eval(`window.__ui.typeAndEnter('input[aria-label="Product fill value"]', 63)`);
  await crawl.settle(500);
  const fill = await crawl.eval(`(() => {
    const b = document.querySelector('input[aria-label="Product fill value"]');
    const r = b.closest('.slider-field').querySelector('input[type="range"]');
    return { box: b.value, range: r.value };
  })()`);
  crawl.step('deep: typed Product fill 63 sticks', fill.box === '63' && fill.range === '63', JSON.stringify(fill));

  /* Watermark opacity lives behind the collapsed Watermark section + toggle —
   * this is the slider whose value box went missing when SettingsPanel had its
   * own private SliderField (v0.1.58 fix). */
  await crawl.eval(`window.__ui.clickLike('.section__toggle', 'watermark')`);
  await crawl.settle(350);
  await crawl.eval(`(() => {
    const box = Array.from(document.querySelectorAll('.toggle input[type=checkbox]')).find((c) => c.closest('.toggle') && c.closest('.toggle').innerText.includes('Show watermark'));
    if (box && !box.checked) box.click();
    return box ? 'ok' : 'MISS';
  })()`);
  await crawl.settle(500);
  const wmBox = await crawl.eval(`!!document.querySelector('input[aria-label="Opacity value"]')`);
  if (!wmBox) {
    crawl.step('deep: watermark Opacity has a value box', false, 'number box missing');
  } else {
    await crawl.eval(`window.__ui.typeAndEnter('input[aria-label="Opacity value"]', 42)`);
    await crawl.settle(500);
    const wm = await crawl.eval(`(() => {
      const b = document.querySelector('input[aria-label="Opacity value"]');
      const r = b.closest('.slider-field').querySelector('input[type="range"]');
      return { box: b.value, range: r.value };
    })()`);
    crawl.shot('workspace-watermark-opacity');
    crawl.step('deep: typed watermark Opacity 42 sticks', wm.box === '42' && wm.range === '42', JSON.stringify(wm));
  }

  /* One real processing run: bg removal (a fetch of the source pixels — the
   * path that the app-image CORS bug killed) + sharp compositing in main. On a
   * cold profile this also downloads the @imgly model, so give it minutes. */
  crawl.phase = 'deep: apply';
  const applyOk = await crawl.eval(`window.__ui.clickExact('Apply to this image')`);
  if (applyOk !== 'ok') {
    crawl.step('deep: apply to this image', false, applyOk);
  } else {
    let toast = '';
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      toast = await crawl.eval('window.__ui.toastText()');
      if (toast) break;
      await delay(500);
    }
    await crawl.settle(1500);
    const crashAfter = await crawl.eval('window.__ui.crash()');
    const processed = await crawl.eval(`(async () => {
      const cid = await window.api.companies.getActiveId();
      const ps = await window.api.products.list(cid, {});
      const p = ps.find((x) => x.sku === ${JSON.stringify(sku)});
      if (!p) return { error: 'product vanished' };
      const imgs = await window.api.images.listByProduct(p.id);
      const list = imgs.images || imgs;
      return list.map((i) => ({ filename: i.filename, isProcessed: i.isProcessed, processedFilepath: i.processedFilepath }));
    })()`, true).catch((err) => ({ error: err.message }));
    await crawl.shot('workspace-after-apply');
    const okToast = /processed/i.test(toast);
    const okRow = Array.isArray(processed) && processed.some((r) => r.isProcessed || r.processedFilepath);
    crawl.step('deep: apply to this image', !crashAfter && okToast && okRow,
      crashAfter ? `CRASHED: ${crashAfter}` : `toast: ${toast || '(none)'} · rows: ${JSON.stringify(processed).slice(0, 200)}`);
  }
}

/**
 * Overlay Studio's template editor — the most complex screen in the app, and
 * the only one the page loop never opens (the module's landing page is a list).
 * Covers the two controls v0.1.58 migrated here (background Opacity, Product
 * size), the v0.1.57 system font picker, and that adding an element does not
 * drop the editor into its error boundary.
 */
async function deepOverlayFlow(crawl) {
  crawl.phase = 'deep: overlay editor';
  await crawl.goto('Overlay Studio');
  const opened = await crawl.eval(`window.__ui.clickExact('+ New template')`);
  if (opened !== 'ok') { crawl.step('deep: open the new-template modal', false, opened); return; }
  await crawl.waitFor(`window.__ui.fieldInput('Template name') !== null`, 8000, 'the new-template modal');
  await crawl.eval(`window.__ui.clickExact('Create template')`);
  await crawl.waitFor(`!!document.querySelector('.ovl-inset-controls')`, 15_000, 'the overlay template editor');
  await crawl.settle(800);
  const crash = await crawl.eval('window.__ui.crash()');
  if (crash) { crawl.step('deep: overlay editor opens', false, `CRASHED: ${crash}`); return; }
  await crawl.shot('overlay-editor');
  crawl.step('deep: overlay editor opens', true, '');

  /* + Text is the button whose absence crashed the whole editor in v0.1.8. */
  await crawl.eval(`window.__ui.clickExact('+ Text')`);
  await crawl.settle(800);
  const crash2 = await crawl.eval('window.__ui.crash()');
  if (crash2) { crawl.step('deep: add a text element', false, `CRASHED: ${crash2}`); return; }
  const boxes = await crawl.eval(`window.__ui.all('.slider-field input[type="number"]').map((i) => i.getAttribute('aria-label'))`);
  const bare = await crawl.eval('window.__ui.bareRanges()');
  await crawl.shot('overlay-text-selected');
  crawl.step('deep: add a text element', bare.length === 0,
    bare.length ? `bare range(s): ${JSON.stringify(bare)}` : `value boxes: ${JSON.stringify(boxes)}`);

  const bgBox = await crawl.eval(`!!document.querySelector('input[aria-label="Opacity value"]')`);
  if (!bgBox) {
    crawl.step('deep: element background Opacity has a value box', false, 'number box missing');
  } else {
    await crawl.eval(`window.__ui.typeAndEnter('input[aria-label="Opacity value"]', 40)`);
    await crawl.settle(500);
    const v = await crawl.eval(`(() => {
      const b = document.querySelector('input[aria-label="Opacity value"]');
      return { box: b.value, range: b.closest('.slider-field').querySelector('input[type="range"]').value };
    })()`);
    crawl.step('deep: typed background Opacity 40 sticks', v.box === '40' && v.range === '40', JSON.stringify(v));
  }

  /* v0.1.57 font picker. A new text element carries a font STACK, so the field
   * renders as free text + "Pick from list"; clicking that is what has to
   * reveal the list. This step is why the "the button did nothing" bug was
   * found — reading the DOM without clicking showed a perfectly reasonable
   * input box. */
  const fonts = await crawl.eval(`(async () => {
    const field = window.__ui.field('Font family');
    if (!field) return { error: 'no Font family field' };
    const before = field.querySelectorAll('select').length;
    const btn = Array.from(field.querySelectorAll('button')).find((b) => /pick from list/i.test(b.innerText));
    if (btn) {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      btn.click();
    }
    await new Promise((r) => setTimeout(r, 3000));
    const sel = field.querySelector('select');
    if (!sel) return { error: 'the list never appeared', hadButton: !!btn, selectsBefore: before };
    const hint = field.querySelector('.field__hint');
    return {
      families: sel.options.length,
      sample: Array.from(sel.options).slice(0, 3).map((o) => o.textContent),
      value: sel.value,
      hint: hint ? hint.textContent : null,
    };
  })()`, true);
  await crawl.shot('overlay-font-picker');
  const fontsOk = fonts && fonts.families > 20 && !fonts.error;
  crawl.step('deep: Font family opens the list of installed fonts', fontsOk, JSON.stringify(fonts).slice(0, 240));

  /* v0.1.58: the inset Product-size slider lives behind this toggle. */
  await crawl.eval(`window.__ui.pressEscape()`);
  await crawl.settle(250);
  const inset = await crawl.eval(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /inset/i.test(x.innerText));
    if (!b) return 'MISS';
    if (b.getAttribute('aria-pressed') !== 'true') b.click();
    return 'ok';
  })()`);
  if (inset !== 'ok') {
    crawl.step('deep: inset Product size has a value box', false, inset);
  } else {
    await crawl.settle(600);
    const box = await crawl.eval(`!!document.querySelector('input[aria-label="Product size value"]')`);
    if (!box) {
      crawl.step('deep: inset Product size has a value box', false, 'number box missing after enabling Inset');
    } else {
      await crawl.eval(`window.__ui.typeAndEnter('input[aria-label="Product size value"]', 72)`);
      await crawl.settle(500);
      const v = await crawl.eval(`(() => {
        const b = document.querySelector('input[aria-label="Product size value"]');
        return { box: b.value, range: b.closest('.slider-field').querySelector('input[type="range"]').value, hint: !!b.closest('.slider-field').querySelector('.slider-field__hint') };
      })()`);
      await crawl.shot('overlay-inset');
      crawl.step('deep: typed Product size 72 sticks', v.box === '72' && v.range === '72' && v.hint, JSON.stringify(v));
    }
  }

  const crashFinal = await crawl.eval('window.__ui.crash()');
  const bareFinal = await crawl.eval('window.__ui.bareRanges()');
  if (crashFinal) crawl.step('deep: overlay editor survives the flow', false, `CRASHED: ${crashFinal}`);
  else if (bareFinal.length) crawl.step('deep: overlay editor survives the flow', false, `bare ranges: ${JSON.stringify(bareFinal)}`);
  else crawl.step('deep: overlay editor survives the flow', true, '');
}

/**
 * Social Grid templates — the whole point of the v0.1.62 change, exercised the
 * way the customer described it: design a look, save it as a template, then
 * pick it in the Product Library and render it from a hand-picked selection.
 *
 * The one thing this cannot click is the native folder picker, so it drives the
 * modal up to that point and then calls the SAME export IPC the modal calls,
 * writing into a scratch folder. Everything either side of the folder dialog is
 * covered, including the pre-flight count the modal shows before you commit.
 */
async function deepSocialTemplateFlow(crawl, outDir) {
  crawl.phase = 'deep: social template';
  await crawl.goto('Social Grid');

  /* A post to save the look from. The price-group leg already made one, but do
   * not depend on that: create one if the list is empty. */
  const hasPost = await crawl.eval(`window.__ui.all('button').some((b) => b.outerHTML.includes('social-card') || b.closest('.social-card'))`);
  if (!hasPost) {
    await crawl.eval(`window.__ui.clickExact('+ New post')`);
    await crawl.waitFor(`window.__ui.fieldInput('Post name') !== null`, 6000, 'the new-post modal');
    await crawl.eval(`window.__ui.fieldSet('Post name', 'UI Crawl post')`);
    await crawl.eval(`window.__ui.clickExact('Create post')`);
    await crawl.waitFor(`!!document.querySelector('.social-editor')`, 12_000, 'the Social Grid editor');
    await crawl.settle(700);
  } else {
    await crawl.eval(`window.__ui.click('.social-card__actions button', 'Open')`);
    await crawl.waitFor(`!!document.querySelector('.social-editor')`, 12_000, 'the Social Grid editor');
    await crawl.settle(700);
  }

  /* 1 ── save the look as a template */
  const tplName = `UI Crawl Look ${String(Date.now()).slice(-5)}`;
  const opened = await crawl.eval(`window.__ui.clickExact('Save as template')`);
  if (opened !== 'ok') { crawl.step('deep: save a Social Grid template', false, opened); return; }
  await crawl.waitFor(`window.__ui.fieldInput('Template name') !== null`, 6000, 'the save-as-template modal');
  await crawl.eval(`window.__ui.fieldSet('Template name', ${JSON.stringify(tplName)})`);
  await crawl.eval(`window.__ui.clickExact('Save template')`);
  await crawl.settle(1200);
  const savedToast = await crawl.eval('window.__ui.toastText()');
  const modalGone = await crawl.eval(`window.__ui.fieldInput('Template name') === null`);
  await crawl.shot('social-save-template');
  crawl.step('deep: save a Social Grid template', modalGone && /saved/i.test(savedToast || ''),
    modalGone ? `toast: ${savedToast || '(none)'}` : 'the modal stayed open');

  /* 2 ── it is listed on the Social Grid page, with no products attached */
  await crawl.eval(`window.__ui.click('.social-editor-back button', 'Social Grid')`);
  await crawl.settle(1200);
  const listed = await crawl.eval(`(() => {
    const card = Array.from(document.querySelectorAll('.social-card--template')).find((c) => c.innerText.includes(${JSON.stringify(tplName)}));
    return card ? card.innerText.replace(/\\n+/g, ' | ') : null;
  })()`);
  await crawl.shot('social-templates-list');
  crawl.step('deep: the template is listed on Social Grid', !!listed, listed || 'not found in the templates section');

  /* 3 ── pick products in the Library and apply it */
  crawl.phase = 'deep: library apply';
  await crawl.goto('Product Library');
  const picked = await crawl.eval(`(() => {
    const boxes = Array.from(document.querySelectorAll('tbody input[type="checkbox"], .lib-grid input[type="checkbox"], .product-tile input[type="checkbox"]'));
    const rows = boxes.filter((b) => !b.closest('thead'));
    rows.slice(0, 2).forEach((b) => { if (!b.checked) b.click(); });
    return rows.length;
  })()`);
  await crawl.settle(600);
  const selectedCount = await crawl.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => String(b.innerText).startsWith('Image operations ('));
    return btn ? btn.innerText : null;
  })()`);
  if (!selectedCount) {
    crawl.step('deep: select products + open the bulk menu', false, `found ${picked} row checkbox(es), no toolbar`);
    return;
  }
  await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.settle(400);
  const menuItem = await crawl.eval(`window.__ui.click('.lib-bulk-menu__item', 'Social post')`);
  if (menuItem !== 'ok') {
    crawl.step('deep: select products + open the bulk menu', false, `no "Social post" item (${menuItem})`);
    return;
  }
  await crawl.waitFor(`window.__ui.fieldInput('Template') !== null`, 8000, 'the apply-social-template modal');
  await crawl.settle(1200);
  await crawl.shot('library-social-modal');

  const modalState = await crawl.eval(`(() => {
    const field = window.__ui.field('Template');
    const sel = field ? field.querySelector('select') : null;
    const plan = document.querySelector('.bulk-overlay-run__plan');
    const radios = Array.from(document.querySelectorAll('input[name="social-scope"]')).map((r) => ({ checked: r.checked, label: r.closest('label').innerText.replace(/\\n+/g, ' ').slice(0, 40) }));
    const button = Array.from(document.querySelectorAll('.modal button')).find((b) => /Render .* image/.test(b.innerText));
    return {
      templates: sel ? Array.from(sel.options).map((o) => o.textContent) : null,
      chosen: sel ? sel.value : null,
      plan: plan ? plan.innerText.replace(/\\n+/g, ' ') : null,
      radios,
      submit: button ? button.innerText : null,
      submitDisabled: button ? button.disabled : null,
    };
  })()`);
  const hasTemplate = (modalState.templates || []).some((t) => t.includes(tplName));
  const planMentionsImages = /→\s*\d+\s*image/.test(modalState.plan || '');
  crawl.step('deep: the Library apply modal offers the template', hasTemplate, JSON.stringify(modalState.templates || []).slice(0, 180));
  crawl.step('deep: it pre-counts products and images', planMentionsImages, `plan: ${modalState.plan || '(none)'} · button: ${modalState.submit}`);
  crawl.step('deep: it targets the selection by default', modalState.radios?.[0]?.checked === true && /Selected \(\d+\)/.test(modalState.radios?.[0]?.label || ''),
    JSON.stringify(modalState.radios));

  /* 4 ── the export the modal runs, minus the native folder dialog */
  crawl.phase = 'deep: library render';
  const rendered = await crawl.eval(`(async () => {
    const sel = window.__ui.field('Template').querySelector('select');
    const tplId = sel.value;
    const tpl = (await window.api.socialGrid.listTemplates(await window.api.companies.getActiveId())).find((t) => t.id === tplId);
    const boxes = Array.from(document.querySelectorAll('tbody input[type="checkbox"], .lib-grid input[type="checkbox"], .product-tile input[type="checkbox"]')).filter((b) => !b.closest('thead') && b.checked);
    const ids = boxes.map((b) => b.dataset ? null : null);
    // Read the ids from the store's product list instead of the DOM: the
    // checkboxes carry no id attribute.
    const products = await window.api.products.list(await window.api.companies.getActiveId(), {});
    const productIds = products.slice(0, 2).map((p) => p.id);
    const config = { ...tpl.config, source: 'picked', productIds, sortBy: 'asSelected' };
    const plan = await window.api.socialGrid.plan(config);
    const res = await window.api.socialGrid.exportImages(config, ${JSON.stringify(outDir)}, null);
    return { planned: plan.pageCount, plannedProducts: plan.productCount, pageCount: res.pageCount, productCount: res.productCount, paths: res.outputPaths };
  })()`, true).catch((err) => ({ error: err.message }));
  await crawl.eval(`window.__ui.pressEscape()`);
  await crawl.settle(200);
  const renderedOk = rendered && !rendered.error && rendered.pageCount >= 1 && (rendered.paths || []).length === rendered.pageCount;
  crawl.step('deep: rendering from a Library selection works', renderedOk,
    JSON.stringify(rendered).slice(0, 260));
  if (renderedOk) {
    crawl.step('deep: the plan matched the render', rendered.planned === rendered.pageCount && rendered.plannedProducts === rendered.productCount,
      `plan ${rendered.planned}/${rendered.plannedProducts} · render ${rendered.pageCount}/${rendered.productCount}`);
  }

  /* 5 ── a single product can be routed to Social Grid from its Process menu */
  crawl.phase = 'deep: process router';
  await crawl.goto('Product Library');
  await crawl.eval(`window.__ui.clickExact('Clear')`);
  await crawl.settle(300);
  const sku = await crawl.eval(`(async () => {
    const ps = await window.api.products.list(await window.api.companies.getActiveId(), {});
    return ps.length ? ps[0].sku : null;
  })()`, true);
  const routed = sku ? await crawl.eval(`window.__ui.clickProcessFor(${JSON.stringify(sku)})`) : 'no products';
  if (routed !== 'ok') {
    crawl.step('deep: Process → Social Grid', false, routed);
  } else {
    await crawl.waitFor(`!!document.querySelector('.process-dest__grid')`, 6000, 'the Process destination modal');
    const cards = await crawl.eval(`window.__ui.all('.process-dest__label').map((e) => e.innerText)`);
    const openedSocial = await crawl.eval(`window.__ui.click('.process-dest__label', 'Social Grid')`);
    await crawl.settle(1000);
    const socialModal = await crawl.eval(`window.__ui.fieldInput('Template') !== null`);
    const scope = await crawl.eval(`(() => { const r = document.querySelector('input[name="social-scope"]'); return r ? r.closest('label').innerText.replace(/\\n+/g, ' ') : null; })()`);
    await crawl.shot('library-process-social');
    await crawl.eval(`window.__ui.pressEscape()`);
    crawl.step('deep: Process → Social Grid', openedSocial === 'ok' && socialModal, `destinations: ${JSON.stringify(cards)} · opened: ${socialModal} · scope: ${scope}`);
  }
}

/**
 * Catalog templates — the builder, end to end.
 *
 * The complaint was that Catalog Studio had five hard-coded layouts and no way
 * to build or keep one. So this leg does exactly what a person would: open the
 * builder from the Templates page, change the layout, save a template, find it
 * under "My templates", then create a catalog from it and confirm the project
 * came out with that design (and its own products).
 *
 * It also checks the preview is a REAL page render (the iframe contains the
 * catalog markup, not an empty shell), because a builder whose preview lies is
 * worse than no preview.
 */
async function deepCatalogTemplateFlow(crawl) {
  crawl.phase = 'deep: catalog template';
  await crawl.goto('Catalog Templates');

  const opened = await crawl.eval(`window.__ui.clickExact('+ New template')`);
  if (opened !== 'ok') { crawl.step('deep: open the catalog template builder', false, opened); return; }
  await crawl.waitFor(`window.__ui.fieldInput('Name') !== null && !!document.querySelector('.catalog-editor')`, 10_000, 'the template builder');
  await crawl.settle(1200);
  const builderCrash = await crawl.eval('window.__ui.crash()');
  if (builderCrash) { crawl.step('deep: the builder opens', false, `CRASHED: ${builderCrash}`); return; }
  const sections = await crawl.eval(`window.__ui.all('.catalog-controls section h3').map((h) => h.innerText)`);
  await crawl.shot('catalog-builder');
  crawl.step('deep: the builder opens with the design controls', sections.length >= 4, `sections: ${JSON.stringify(sections)}`);

  /* The preview must be a real render of the company's own catalog. */
  const previewInfo = await crawl.eval(`(async () => {
    for (let i = 0; i < 40; i += 1) {
      const frame = document.querySelector('.catalog-preview iframe');
      const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
      if (doc && doc.body && doc.body.innerHTML.length > 500) {
        return {
          bytes: doc.body.innerHTML.length,
          hasGrid: !!doc.querySelector('.grid'),
          hasCover: !!doc.querySelector('.cover'),
          title: (doc.querySelector('.cover h1') || {}).textContent || null,
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { bytes: 0 };
  })()`, true);
  crawl.step('deep: the preview is a real page render', previewInfo.bytes > 500 && previewInfo.hasGrid,
    JSON.stringify(previewInfo));

  /* Change the design: 2 columns, minimal style, cover off, extra field. */
  const name = `UI Crawl Catalog ${String(Date.now()).slice(-5)}`;
  await crawl.eval(`window.__ui.fieldSet('Name', ${JSON.stringify(name)})`);
  await crawl.eval(`window.__ui.fieldSet('Description', 'Built by the UI crawl')`);
  await crawl.eval(`window.__ui.fieldSet('Columns', '2')`);
  await crawl.eval(`window.__ui.fieldSet('Page margin (mm)', '14')`);
  await crawl.eval(`window.__ui.click('.theme-choices button', 'Minimal')`);
  await crawl.settle(200);
  const coverOff = await crawl.eval(`(() => {
    const label = Array.from(document.querySelectorAll('.catalog-controls .switch-row')).find((l) => /cover page/i.test(l.innerText));
    if (!label) return 'MISS';
    const box = label.querySelector('input[type=checkbox]');
    if (box && box.checked) box.click();
    return box ? (box.checked ? 'still on' : 'off') : 'no checkbox';
  })()`);
  // Add a card field (Description) that was not in the default four.
  const addedField = await crawl.eval(`(() => {
    const row = Array.from(document.querySelectorAll('.catalog-field-row')).find((r) => /Description/.test(r.innerText));
    if (!row) return 'MISS';
    const box = row.querySelector('input[type=checkbox]');
    if (box && !box.checked) box.click();
    return box ? (box.checked ? 'on' : 'still off') : 'no checkbox';
  })()`);
  await crawl.settle(1500);
  await crawl.shot('catalog-builder-changed');

  const afterEdits = await crawl.eval(`(() => {
    const frame = document.querySelector('.catalog-preview iframe');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    if (!doc) return null;
    const grid = doc.querySelector('.grid');
    return {
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      hasCover: !!doc.querySelector('.cover'),
    };
  })()`);
  // Rendered text is the wrong probe for the FIELD list: a product with no
  // description value prints no row (by design), so the field list is asserted
  // on the saved config below instead.
  crawl.step('deep: the preview follows the edits',
    afterEdits && afterEdits.columns === 2 && afterEdits.hasCover === false,
    `cover switch: ${coverOff} · description field: ${addedField} · ${JSON.stringify(afterEdits)}`);

  /* Save it. */
  await crawl.eval(`window.__ui.clickExact('Create template')`);
  await crawl.waitFor(`window.__ui.fieldInput('Name') === null`, 10_000, 'the builder to close after saving');
  await crawl.settle(1200);
  const savedToast = await crawl.eval('window.__ui.toastText()');
  const listed = await crawl.eval(`(() => {
    const card = Array.from(document.querySelectorAll('.catalog-template-card--mine')).find((c) => c.innerText.includes(${JSON.stringify(name)}));
    return card ? card.innerText.replace(/\\n+/g, ' | ') : null;
  })()`);
  await crawl.shot('catalog-templates-saved');
  crawl.step('deep: the template is saved and listed', !!listed, listed || `not found under My templates · toast: ${savedToast || '(none)'}`);

  /* Create a catalog from it and verify the project picked up the design. */
  crawl.phase = 'deep: catalog from template';
  const usedIt = await crawl.eval(`(() => {
    const card = Array.from(document.querySelectorAll('.catalog-template-card--mine')).find((c) => c.innerText.includes(${JSON.stringify(name)}));
    if (!card) return 'MISS';
    const btn = Array.from(card.querySelectorAll('button')).find((b) => b.innerText.includes('Use in a new catalog'));
    if (!btn) return 'no button';
    btn.click();
    return 'ok';
  })()`);
  if (usedIt !== 'ok') {
    crawl.step('deep: a catalog can be created from the template', false, usedIt);
    return;
  }
  await crawl.waitFor(`window.__ui.fieldInput('Project name') !== null`, 6000, 'the create-project dialog');
  await crawl.settle(300);
  await crawl.eval(`window.__ui.fieldSet('Project name', ${JSON.stringify(`${name} catalog`)})`);
  await crawl.eval(`window.__ui.clickExact('Create and add products')`);
  await crawl.waitFor(`!!document.querySelector('.catalog-editor-tabs')`, 15_000, 'the catalog editor');
  await crawl.settle(1200);
  const project = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    const rows = await window.api.catalogStudio.list(cid);
    const row = rows.find((r) => r.name === ${JSON.stringify(`${name} catalog`)});
    if (!row) return { error: 'project not in the list' };
    return { columns: row.config.columns, theme: row.config.theme, marginMm: row.config.marginMm,
      coverEnabled: row.config.coverEnabled, coverTitle: row.config.cover?.title,
      fields: (row.config.fields || []).map((f) => f.key), productIds: row.config.productIds };
  })()`, true);
  await crawl.shot('catalog-from-template');
  // The four standard fields AND the one the builder added: a template that
  // forgot the defaults produced a catalog whose cards printed nothing, which
  // is exactly the bug the first version of this builder had.
  const expectedFields = ['sku', 'name', 'colorFinish', 'price', 'description'];
  const ok = project && !project.error && project.columns === 2 && project.theme === 'minimal'
    && project.coverEnabled === false && project.coverTitle === `${name} catalog`
    && expectedFields.every((k) => project.fields.includes(k));
  crawl.step('deep: the catalog came out with the template\'s design', ok, JSON.stringify(project).slice(0, 260));
  crawl.step('deep: the new catalog starts with no products of its own', project && Array.isArray(project.productIds) && project.productIds.length === 0,
    JSON.stringify(project?.productIds));

  /* And "Save as template" from a project opens the same builder. */
  crawl.phase = 'deep: save project as template';
  const fromProject = await crawl.eval(`window.__ui.clickExact('Save as template')`);
  if (fromProject !== 'ok') { crawl.step('deep: Save as template opens the builder pre-filled', false, fromProject); return; }
  await crawl.waitFor(`!!document.querySelector('.catalog-editor-back')`, 6000, 'the builder from a project');
  await crawl.settle(800);
  const draftName = await crawl.eval(`window.__ui.fieldValue('Name')`);
  const draftCrash = await crawl.eval('window.__ui.crash()');
  await crawl.shot('catalog-save-as-template');
  const draftColumns = await crawl.eval(`window.__ui.fieldValue('Columns')`);
  crawl.step('deep: Save as template opens the builder pre-filled', !draftCrash && !!draftName && String(draftName).includes('template') && draftColumns === '2',
    `name: ${draftName} · columns: ${draftColumns}${draftCrash ? ` · CRASHED: ${draftCrash}` : ''}`);
  await crawl.eval(`window.__ui.clickExact('Cancel')`);
  await crawl.settle(400);
}

/**
 * The label designer — the part the customer said was unusable.
 *
 * "hard to pick or select elements, hard to drag and drop around": this drives
 * real mouse gestures (mousedown/mousemove/mouseup, not .click()) and checks the
 * four things that were broken — a click selects and STAYS selected, a drag
 * moves the box, a marquee selects, a handle resizes — plus multi-select,
 * undo/redo, the layer list and the exact print preview.
 */
async function deepLabelDesignerFlow(crawl) {
  crawl.phase = 'deep: label designer';
  await crawl.goto('Label Templates');

  /* A brand-new template, not an existing one: the canvas then starts empty and
   * the geometry below is exact. Opening whatever happens to be in the profile
   * would make this leg depend on leftover data from earlier runs. */
  const opened = await crawl.eval(`window.__ui.clickExact('+ New label template')`);
  if (opened !== 'ok') { crawl.step('deep: open a label template', false, opened); return; }
  await crawl.waitFor(`window.__ui.fieldInput('Template name') !== null`, 8000, 'the new-template modal');
  await crawl.eval(`window.__ui.fieldSet('Template name', 'UI Crawl Label')`);
  await crawl.eval(`window.__ui.clickExact('Create')`);
  await crawl.waitFor(`!!document.querySelector('.ld-canvas')`, 12_000, 'the designer canvas');
  await crawl.settle(900);
  const crash = await crawl.eval('window.__ui.crash()');
  if (crash) { crawl.step('deep: the label designer opens', false, `CRASHED: ${crash}`); return; }
  const chrome = await crawl.eval(`({
    canvas: !!document.querySelector('.ld-canvas'),
    align: !!document.querySelector('.ld-align'),
    layers: !!document.querySelector('.ld-layers'),
    zoomBar: !!document.querySelector('.ld-bar__tools'),
    palette: document.querySelectorAll('.designer-toolbar__tools button').length,
    current: document.querySelectorAll('.ld-el').length,
  })`);
  await crawl.shot('label-designer');
  crawl.step('deep: the designer opens with canvas, align bar and layers',
    chrome.canvas && chrome.align && chrome.layers && chrome.zoomBar && chrome.palette > 5,
    JSON.stringify(chrome));

  /* 1 ── click a palette item: it must be added AND stay selected. This is the
   *      exact bug — the canvas's own mousedown used to clear it in the same tick. */
  await crawl.eval(`window.__ui.click('.designer-toolbar__tools button', 'Text')`);
  await crawl.settle(500);
  const afterAdd = await crawl.eval(`({
    count: document.querySelectorAll('.ld-el').length,
    alignLabel: (document.querySelector('.ld-align__label') || {}).innerText || null,
    inspector: (document.querySelector('.inspector-title strong') || {}).innerText || null,
    selected: document.querySelectorAll('.ld-el [class*="ld-handle"]').length > 0,
  })`);
  crawl.step('deep: adding an element leaves it selected',
    afterAdd.count > chrome.current && /1 selected/.test(afterAdd.alignLabel || '') && afterAdd.selected,
    JSON.stringify(afterAdd));

  /* 2 ── drag it: the box must move, by roughly the pixel delta. */
  const boxBefore = await crawl.eval(`window.__ui.elBox('.ld-el')`);
  const dragged = await crawl.eval(`window.__ui.mouseDrag('.ld-el', 40, 24)`, true);
  await crawl.settle(400);
  const boxAfter = await crawl.eval(`window.__ui.elBox('.ld-el')`);
  const moved = boxBefore && boxAfter
    && Math.abs(boxAfter.left - boxBefore.left) > 10 && Math.abs(boxAfter.top - boxBefore.top) > 5;
  await crawl.shot('label-designer-dragged');
  crawl.step('deep: dragging an element moves it', dragged === 'ok' && moved,
    `before ${JSON.stringify(boxBefore)} → after ${JSON.stringify(boxAfter)}`);

  /* 3 ── a resize handle changes the size, and undo puts it back. */
  const beforeResize = await crawl.eval(`window.__ui.elBox('.ld-el')`);
  const resized = await crawl.eval(`window.__ui.mouseDragHandle('.ld-el', 'se', 30, 0)`, true);
  await crawl.settle(400);
  const afterResize = await crawl.eval(`window.__ui.elBox('.ld-el')`);
  await crawl.eval(`window.__ui.clickExact('Undo')`);
  await crawl.settle(400);
  const afterUndo = await crawl.eval(`window.__ui.elBox('.ld-el')`);
  crawl.step('deep: the resize handle resizes and Undo restores',
    resized === 'ok' && afterResize.width > beforeResize.width + 5
      && Math.abs(afterUndo.width - beforeResize.width) < 1.5,
    `${Math.round(beforeResize.width)} → ${Math.round(afterResize.width)} → undo ${Math.round(afterUndo.width)}`);

  /* 4 ── click empty canvas: deselect. Marquee across the element: select. */
  await crawl.eval(`(async () => {
    const canvas = document.querySelector('.ld-canvas');
    const r = canvas.getBoundingClientRect();
    await window.__ui.mouseDragPoint(canvas, r.right - 6, r.bottom - 6, r.right - 5, r.bottom - 5);
  })()`, true);
  await crawl.settle(300);
  const cleared = await crawl.eval(`(document.querySelector('.ld-align__label') || {}).innerText || ''`);
  await crawl.eval(`(async () => {
    const canvas = document.querySelector('.ld-canvas');
    const r = canvas.getBoundingClientRect();
    await window.__ui.mouseDragPoint(canvas, r.right - 6, r.bottom - 6, r.left + 4, r.top + 4);
  })()`, true);
  await crawl.settle(400);
  const marqueeLabel = await crawl.eval(`(document.querySelector('.ld-align__label') || {}).innerText || ''`);
  crawl.step('deep: clicking empty canvas clears, marquee selects',
    /Align/.test(cleared) && /selected/.test(marqueeLabel),
    `cleared → “${cleared}” · marquee → “${marqueeLabel}”`);

  /* 5 ── a second element + an explicit two-element selection (click, then
   *      shift-click): both must travel together by the same delta. */
  await crawl.eval(`window.__ui.click('.designer-toolbar__tools button', 'QR code')`);
  await crawl.settle(500);
  const total = await crawl.eval(`document.querySelectorAll('.ld-el').length`);
  await crawl.eval(`window.__ui.clickElAt(0, false)`, true);
  await crawl.settle(250);
  await crawl.eval(`window.__ui.clickElAt(${total - 1}, true)`, true);
  await crawl.settle(400);
  const multiLabel = await crawl.eval(`(document.querySelector('.ld-align__label') || {}).innerText || ''`);
  const beforeMulti = await crawl.eval(`Array.from(document.querySelectorAll('.ld-el')).map((el) => el.style.left)`);
  await crawl.eval(`window.__ui.mouseDrag('.ld-el', 30, 0)`, true);
  await crawl.settle(400);
  const afterMulti = await crawl.eval(`Array.from(document.querySelectorAll('.ld-el')).map((el) => el.style.left)`);
  const movedCount = afterMulti.filter((v, i) => v !== beforeMulti[i]).length;
  await crawl.shot('label-designer-multi');
  crawl.step('deep: multi-select drags every selected element',
    /2 selected/.test(multiLabel) && movedCount === 2,
    `${total} element(s) · “${multiLabel}” · ${movedCount} moved · ${JSON.stringify(beforeMulti)} → ${JSON.stringify(afterMulti)}`);

  /* 6 ── the exact print preview renders the real document. */
  await crawl.eval(`window.__ui.click('.ld-bar__tools button', 'Exact preview')`);
  await crawl.waitFor(`!!document.querySelector('.ld-exact')`, 12_000, 'the exact preview iframe');
  await crawl.settle(600);
  const exact = await crawl.eval(`(() => {
    const frame = document.querySelector('.ld-exact');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    if (!doc || !doc.body) return { ok: false };
    return { ok: true, bytes: doc.body.innerHTML.length, label: !!doc.querySelector('.label'),
      transform: getComputedStyle(frame).transform };
  })()`);
  await crawl.shot('label-designer-exact');
  crawl.step('deep: the exact preview is the real print document',
    exact.ok && exact.bytes > 200 && exact.label, JSON.stringify(exact));
  await crawl.eval(`window.__ui.click('.ld-bar__tools button', 'Editing view')`);
  await crawl.settle(300);

  /* 7 ── the layer list selects. */
  const layerClick = await crawl.eval(`(() => {
    const row = document.querySelectorAll('.ld-layers li button.ld-layers__name');
    if (!row.length) return 'MISS';
    row[0].click();
    return { label: (document.querySelector('.ld-align__label') || {}).innerText || '', rows: row.length };
  })()`);
  await crawl.settle(300);
  crawl.step('deep: the layer list selects elements',
    typeof layerClick === 'object' && layerClick.rows >= 2 && /selected/.test(layerClick.label),
    JSON.stringify(layerClick));

  /* 8 ── snapping toggles the grid, and the keyboard nudges. */
  const snapOn = await crawl.eval(`(() => {
    const btn = Array.from(document.querySelectorAll('.ld-bar__tools button')).find((b) => /^Snap/.test(b.innerText));
    if (!btn) return null;
    const before = getComputedStyle(document.querySelector('.ld-canvas')).backgroundImage;
    btn.click();
    return { before };
  })()`);
  await crawl.settle(400);
  const snapState = await crawl.eval(`({
    after: getComputedStyle(document.querySelector('.ld-canvas')).backgroundImage,
    label: Array.from(document.querySelectorAll('.ld-bar__tools button')).find((b) => /^Snap/.test(b.innerText))?.innerText,
  })`);
  crawl.step('deep: the snap toggle drives the grid',
    !!snapOn && snapOn.before !== snapState.after, `${snapOn?.label ?? ''} → ${snapState.label}`);

  const beforeKey = await crawl.eval(`window.__ui.elBox('.ld-el')`);
  await crawl.eval(`(() => {
    document.body.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return 'ok';
  })()`);
  await crawl.settle(400);
  const afterKey = await crawl.eval(`window.__ui.elBox('.ld-el')`);
  crawl.step('deep: arrow keys nudge the selection',
    beforeKey && afterKey && afterKey.left > beforeKey.left,
    `${Math.round(beforeKey?.left)} → ${Math.round(afterKey?.left)}`);

  const finalCrash = await crawl.eval('window.__ui.crash()');
  crawl.step('deep: the designer survives the whole flow', !finalCrash, finalCrash || '');
}

/**
 * The bulk edit table (v0.1.66) — the newest screen, and the one with the most
 * ways to fail silently: a paste that half-lands, an image that goes to the
 * wrong product, a Save that writes before the dry run.
 *
 * It ticks two real products in the Library, opens Image operations ▾ →
 * Edit in table, then drives the grid the way a person would: type in a cell,
 * paste a block too wide to fit (and read the refusal), paste one that fits,
 * paste a real clipboard image in both modes (checking position 0 moves only
 * for Make main), and save through the dry-run summary.
 */
async function deepBulkTableFlow(crawl, photoPath) {
  crawl.phase = 'deep: bulk table';

  /* Two products are needed and the isolated profile may only have one, so top
   * the catalog up over IPC before touching the UI. */
  const ensured = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    let ps = await window.api.products.list(cid, {});
    const stamp = String(Date.now()).slice(-6);
    let made = 0;
    while (ps.length < 2) {
      await window.api.products.create({ companyId: cid, sku: 'UI-BULK-' + stamp + '-' + made, name: 'Bulk table widget ' + made, status: 'active' });
      made += 1;
      ps = await window.api.products.list(cid, {});
    }
    return { total: ps.length, made };
  })()`, true).catch((err) => ({ error: err.message }));
  if (!ensured || ensured.error) { crawl.step('deep bulk table: two products exist', false, JSON.stringify(ensured)); return; }
  crawl.step('deep bulk table: two products exist', ensured.total >= 2, JSON.stringify(ensured));

  await crawl.goto('Product Library');

  /* Give the product that will be row 0 a main image first, so "Add keeps the
   * main" is a real assertion rather than a first-image special case. The
   * import bumps updated_at, which floats it to the top of the newest-first
   * list. */
  const seeded = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    let brands = await window.api.brands.list(cid);
    if (!brands.length) {
      await window.api.brands.create({ companyId: cid, name: 'UI Crawl Brand' });
      brands = await window.api.brands.list(cid);
    }
    const ps = await window.api.products.list(cid, {});
    const p = ps[0];
    // A brand on row 0 gives the "— Unassigned —" option something to clear.
    await window.api.products.update(p.id, { brandId: brands[0].id });
    let imgs = await window.api.images.listByProduct(p.id);
    let list = imgs.images || imgs;
    if (list.length === 0) {
      await window.api.images.importForProduct(p.id, ${JSON.stringify(photoPath)});
      imgs = await window.api.images.listByProduct(p.id);
      list = imgs.images || imgs;
    }
    return {
      sku: p.sku, id: p.id, count: list.length, first: list[0] ? list[0].filepath : null,
      brandId: brands[0].id, brandName: brands[0].name,
    };
  })()`, true).catch((err) => ({ error: err.message }));
  if (!seeded || seeded.error) { crawl.step('deep bulk table: row 0 has a main image', false, JSON.stringify(seeded)); return; }

  await crawl.goto('Product Library');
  // v0.1.68: start from the default column widths so the resize assertion has a
  // known baseline (a previous run on the same profile may have persisted some).
  await crawl.eval(`(() => { try { localStorage.removeItem('BulkTable.columnWidths'); } catch {} return 'ok'; })()`);
  const picked = await crawl.eval(`(() => {
    const boxes = Array.from(document.querySelectorAll('tbody input[type="checkbox"], .lib-grid input[type="checkbox"], .product-tile input[type="checkbox"]')).filter((b) => !b.closest('thead'));
    boxes.slice(0, 2).forEach((b) => { if (!b.checked) b.click(); });
    return boxes.length;
  })()`);
  await crawl.settle(600);
  const menu = await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.settle(350);
  const item = await crawl.eval(`window.__ui.click('.lib-bulk-menu__item', 'Edit in table')`);
  if (menu !== 'ok' || item !== 'ok') {
    crawl.step('deep bulk table: open the table from the bulk menu', false, `menu ${menu} · item ${item} · ${picked} row checkbox(es)`);
    return;
  }
  await crawl.waitFor(`!!document.querySelector('.bulk-table__grid')`, 10_000, 'the bulk table grid');
  await crawl.settle(500);
  const crash = await crawl.eval('window.__ui.crash()');
  if (crash) { crawl.step('deep bulk table: the table opens', false, `CRASHED: ${crash}`); return; }

  const chrome = await crawl.eval(`({
    rows: document.querySelectorAll('.bulk-table__grid tbody tr[data-row]').length,
    headers: Array.from(document.querySelectorAll('.bulk-table__grid thead th')).map((th) => th.innerText),
    inputs: document.querySelectorAll('.bulk-table__grid tbody input, .bulk-table__grid tbody select').length,
    imageCells: document.querySelectorAll('.bulk-table__grid tbody [data-col="image"]').length,
    scopes: Array.from(document.querySelectorAll('input[name="bulk-table-scope"]')).map((r) => r.checked),
    modes: Array.from(document.querySelectorAll('.bulk-table__imagectl button')).map((b) => b.innerText),
    hint: (document.querySelector('.bulk-table__hint') || {}).innerText || '',
  })`);
  await crawl.shot('bulk-table');
  const wantedCols = ['Name', 'SKU', 'Brand', 'Category', 'Retail price', 'Image'];
  const hasCols = wantedCols.every((c) => chrome.headers.some((h) => h === c));
  crawl.step('deep bulk table: rows and columns render',
    chrome.rows === 2 && hasCols && chrome.imageCells === 2 && chrome.scopes[0] === true,
    JSON.stringify({ rows: chrome.rows, headers: chrome.headers.length, inputs: chrome.inputs, scopes: chrome.scopes }));
  crawl.step('deep bulk table: both image modes and the hint are offered',
    chrome.modes.join('|') === 'Add|Make main' && /⌘V/.test(chrome.hint) && /⇧⌘V/.test(chrome.hint),
    `modes ${JSON.stringify(chrome.modes)} · hint “${chrome.hint.slice(0, 80)}…”`);

  /* ── v0.1.68 Fix 1: drag a header edge to resize, remember the width ──── */
  const nameColWidth = () => crawl.eval(`(() => { const c = document.querySelector('col[data-col="name"]'); return c ? parseFloat(c.style.width) : null; })()`);
  const nameBefore = await nameColWidth();
  const dragged = await crawl.eval(`window.__ui.mouseDrag('[data-col-resize="name"]', 100, 0)`, true);
  await crawl.settle(300);
  const nameResized = await crawl.eval(`(() => {
    const c = document.querySelector('col[data-col="name"]');
    const th = document.querySelector('.bulk-table__grid thead th[title="Name"]');
    return { col: c ? parseFloat(c.style.width) : null, rendered: th ? Math.round(th.getBoundingClientRect().width) : null };
  })()`);
  const storedWidths = await crawl.eval(`(() => { try { return JSON.parse(localStorage.getItem('BulkTable.columnWidths') || '{}'); } catch { return null; } })()`);
  await crawl.shot('bulk-table-resized');
  crawl.step('deep bulk table: dragging a header edge widens the column and remembers it',
    dragged === 'ok' && nameBefore != null && nameResized.col >= nameBefore + 80
      && nameResized.rendered >= nameResized.col - 6
      && storedWidths && storedWidths.name === nameResized.col,
    `drag ${nameBefore} → ${nameResized.col}px (rendered ${nameResized.rendered}) · stored ${JSON.stringify(storedWidths)} · ${dragged}`);

  /* The width must survive closing and reopening the table. */
  await crawl.eval(`window.__ui.clickExact('Close')`);
  await crawl.waitFor(`!document.querySelector('.bulk-table__grid')`, 10_000, 'the table to close');
  await crawl.settle(400);
  await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.settle(350);
  const reopenedItem = await crawl.eval(`window.__ui.click('.lib-bulk-menu__item', 'Edit in table')`);
  await crawl.waitFor(`!!document.querySelector('.bulk-table__grid')`, 10_000, 'the bulk table grid after reopen');
  await crawl.settle(450);
  const nameAfterReopen = await nameColWidth();
  crawl.step('deep bulk table: the remembered column width survives close and reopen',
    reopenedItem === 'ok' && nameAfterReopen === nameResized.col,
    `${nameResized.col} → ${nameAfterReopen} after reopen · ${reopenedItem}`);

  /* ── v0.1.68 Fix 1: Reset columns restores the defaults ──────────────── */
  await crawl.eval(`window.__ui.clickExact('Reset columns')`);
  await crawl.settle(250);
  const afterReset = await crawl.eval(`(() => {
    const c = document.querySelector('col[data-col="name"]');
    return { col: c ? parseFloat(c.style.width) : null, stored: localStorage.getItem('BulkTable.columnWidths') };
  })()`);
  crawl.step('deep bulk table: Reset columns restores the default width and clears the saved map',
    afterReset.col === 190 && afterReset.stored === null,
    `name ${afterReset.col}px · stored ${afterReset.stored}`);

  /* The brand/category selects must offer an explicit "— Unassigned —" that
   * CLEARS the field. Row 0 was given a brand above, so both the option and the
   * current value are checkable. */
  await crawl.waitFor(`(() => {
    const sel = document.querySelector('select[data-row="0"][data-col="brandId"]');
    return sel && Array.from(sel.options).some((o) => o.value === ${JSON.stringify(seeded.brandId)});
  })()`, 8000, 'the brand option to reach the grid');
  const brandCell = await crawl.eval(`(() => {
    const sel = document.querySelector('select[data-row="0"][data-col="brandId"]');
    if (!sel) return { error: 'no brand cell' };
    const opts = Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent }));
    return { value: sel.value, unassigned: opts.some((o) => o.value === '' && /Unassigned/.test(o.label)), options: opts.length };
  })()`);
  crawl.step('deep bulk table: brand offers an explicit Unassigned that clears',
    !brandCell.error && brandCell.unassigned && brandCell.value === seeded.brandId,
    JSON.stringify(brandCell));

  const sku0 = await crawl.eval(`(document.querySelector('input[data-row="0"][data-col="sku"]') || {}).value || null`);
  const sku1 = await crawl.eval(`(document.querySelector('input[data-row="1"][data-col="sku"]') || {}).value || null`);
  if (!sku0 || !sku1) { crawl.step('deep bulk table: rows carry SKUs', false, JSON.stringify({ sku0, sku1 })); return; }

  /* 1 ── a typed cell holds */
  await crawl.eval(`window.__ui.set('input[data-row="0"][data-col="subcategory"]', 'Crawl A')`);
  await crawl.settle(300);
  const typed = await crawl.eval(`document.querySelector('input[data-row="0"][data-col="subcategory"]').value`);
  crawl.step('deep bulk table: a typed cell holds', typed === 'Crawl A', JSON.stringify({ typed }));

  /* ── v0.1.68 Fix 2: long values wrap and the row grows instead of being
   * clipped. Name/Description are the columns the customer could not read. */
  const longName = 'Bulk table long name — ' + 'the quick brown fox jumps over the lazy dog '.repeat(4).trim();
  const longDesc = 'Long description: ' + 'wrap this value onto several lines so nothing is clipped. '.repeat(3).trim();
  const longCellShape = await crawl.eval(`({
    nameTextarea: !!document.querySelector('textarea[data-row="0"][data-col="name"]'),
    nameInput: !!document.querySelector('input[data-row="0"][data-col="name"]'),
    descTextarea: !!document.querySelector('textarea[data-row="0"][data-col="description"]'),
  })`);
  await crawl.eval(`window.__ui.set('textarea[data-row="0"][data-col="name"]', ${JSON.stringify(longName)})`);
  await crawl.settle(300);
  await crawl.eval(`window.__ui.set('textarea[data-row="0"][data-col="description"]', ${JSON.stringify(longDesc)})`);
  await crawl.settle(300);
  const wrapped = await crawl.eval(`(() => {
    const ta = document.querySelector('textarea[data-row="0"][data-col="name"]');
    const desc = document.querySelector('textarea[data-row="0"][data-col="description"]');
    const row = ta ? ta.closest('tr') : null;
    const cell = ta ? ta.closest('td') : null;
    return {
      name: ta ? ta.value : null,
      nameH: ta ? ta.clientHeight : 0,
      nameScrollH: ta ? ta.scrollHeight : 0,
      nameFits: ta ? ta.scrollHeight <= ta.clientHeight + 1 : false,
      descFits: desc ? desc.scrollHeight <= desc.clientHeight + 1 : false,
      descH: desc ? desc.clientHeight : 0,
      rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
      whiteSpace: cell ? getComputedStyle(cell).whiteSpace : null,
    };
  })()`);
  await crawl.shot('bulk-table-wrapped');
  crawl.step('deep bulk table: long Name/Description values render as a growing textarea, not a clipped input',
    longCellShape.nameTextarea && !longCellShape.nameInput && longCellShape.descTextarea
      && wrapped.name === longName && wrapped.nameFits && wrapped.descFits
      && wrapped.nameH > 35 && wrapped.descH > 35 && wrapped.rowH > 40
      && wrapped.whiteSpace !== 'nowrap',
    `textarea ${longCellShape.nameTextarea} · fits ${wrapped.nameFits}/${wrapped.descFits} · name h ${wrapped.nameH}/${wrapped.nameScrollH} · desc h ${wrapped.descH} · row ${wrapped.rowH} · white-space ${wrapped.whiteSpace}`);

  /* 2 ── a paste WIDER than the room left is refused, and the toast names the
   *      columns that did not fit. Start from the LAST text column, where two
   *      cells cannot fit into one. */
  const wide = await crawl.eval(`(() => {
    const cells = Array.from(document.querySelectorAll('.bulk-table__grid tbody tr[data-row="0"] [data-col]'))
      .filter((el) => el.dataset.col !== 'image' && el.dataset.col !== 'image-count');
    const last = cells[cells.length - 1];
    if (!last) return { error: 'no cells' };
    last.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'x\\ty');
    last.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { col: last.dataset.col };
  })()`);
  await crawl.settle(300);
  const wideToast = await crawl.eval('window.__ui.toastText()');
  await crawl.shot('bulk-table-wide-refused');
  crawl.step('deep bulk table: a too-wide paste is refused and names the columns',
    !wide.error && /2 columns wide/.test(wideToast || '') && String(wideToast).includes(wide.col),
    `last column ${wide.col} · toast: ${wideToast || '(none)'}`);

  /* 3 ── a paste that fits fills the cells from the focused one */
  const filledPaste = await crawl.eval(`(() => {
    const a = document.querySelector('input[data-row="1"][data-col="subcategory"]');
    if (!a) return 'MISS';
    a.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Paste A\\tPaste B');
    a.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
  await crawl.settle(350);
  const filled = await crawl.eval(`({
    a: document.querySelector('input[data-row="1"][data-col="subcategory"]').value,
    b: document.querySelector('input[data-row="1"][data-col="colorFinish"]').value,
  })`);
  crawl.step('deep bulk table: a fitting paste fills the cells',
    filledPaste === 'ok' && filled.a === 'Paste A' && filled.b === 'Paste B',
    JSON.stringify(filled));

  /* 3b ── an edited SKU is a rename. bulkUpsert is keyed by SKU and can only
   *       match or insert, so the save has to rename through products:update
   *       and then find the product under its NEW sku. */
  const renamedSku = `${sku1}-R`;
  await crawl.eval(`window.__ui.set('input[data-row="1"][data-col="sku"]', ${JSON.stringify(renamedSku)})`);
  await crawl.settle(250);
  const skuCellNow = await crawl.eval(`document.querySelector('input[data-row="1"][data-col="sku"]').value`);
  crawl.step('deep bulk table: an edited SKU is accepted in the cell', skuCellNow === renamedSku, JSON.stringify({ skuCellNow }));

  /* 4 ── never edit product images here: paste text into the image cell and it
   *      says so instead of writing anything. */
  const textOnImage = await crawl.eval(`(() => {
    const cell = document.querySelector('[data-col="image"][data-row="0"]');
    if (!cell) return 'MISS;';
    cell.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'zzz');
    cell.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
  await crawl.settle(300);
  const textOnImageToast = await crawl.eval('window.__ui.toastText()');
  crawl.step('deep bulk table: the image cell refuses text',
    textOnImage === 'ok' && /Image cell/i.test(textOnImageToast || ''),
    `toast: ${textOnImageToast || '(none)'}`);

  /* 5 ── a real clipboard image, Add mode: the count rises, the main stays. */
  const addResult = await crawl.eval(`(async () => {
    const cell = document.querySelector('[data-col="image"][data-row="0"]');
    if (!cell) return { error: 'no image cell' };
    cell.focus();
    await new Promise((r) => setTimeout(r, 80));
    const canvas = document.createElement('canvas');
    canvas.width = 48; canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c0392b'; ctx.fillRect(0, 0, 48, 48);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'crawl-add.png', { type: 'image/png' }));
    cell.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { ok: true };
  })()`, true);
  await crawl.settle(2500);
  const afterAddDom = await crawl.eval(`(document.querySelector('.bulk-table__image-count') || {}).textContent || ''`);
  const afterAddToast = await crawl.eval('window.__ui.toastText()');
  await crawl.shot('bulk-table-image-add');
  const countOf = (txt) => { const m = String(txt).match(/(\d+)\s*\/\s*50/); return m ? Number(m[1]) : -1; };
  const countBefore = Number(String(seeded.count));
  const addOk = addResult && !addResult.error && countOf(afterAddDom) === countBefore + 1 && /added/i.test(afterAddToast || '');
  crawl.step('deep bulk table: a pasted photo raises the image count (Add)',
    addOk, `count ${countBefore} → ${afterAddDom} · toast: ${afterAddToast || '(none)'}`);

  /* 6 ── Make main: a second, different photo goes to position 0. */
  const beforeMain = await crawl.eval(`(async () => {
    const ps = await window.api.products.list(await window.api.companies.getActiveId(), {});
    const p = ps.find((x) => x.sku === ${JSON.stringify(sku0)});
    const imgs = await window.api.images.listByProduct(p.id);
    const list = imgs.images || imgs;
    return { count: list.length, first: list[0] ? list[0].filepath : null };
  })()`, true);
  await crawl.eval(`window.__ui.click('.bulk-table__imagectl button', 'Make main')`);
  await crawl.settle(250);
  const modeOn = await crawl.eval(`(() => { const b = Array.from(document.querySelectorAll('.bulk-table__imagectl button')).find((x) => x.innerText === 'Make main'); return b ? b.getAttribute('aria-pressed') : null; })()`);
  const mainResult = await crawl.eval(`(async () => {
    const cell = document.querySelector('[data-col="image"][data-row="0"]');
    if (!cell) return { error: 'no image cell' };
    cell.focus();
    await new Promise((r) => setTimeout(r, 80));
    const canvas = document.createElement('canvas');
    canvas.width = 48; canvas.height = 48;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1e8449'; ctx.fillRect(0, 0, 48, 48);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'crawl-main.png', { type: 'image/png' }));
    cell.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { ok: true };
  })()`, true);
  await crawl.settle(2500);
  const afterMain = await crawl.eval(`(async () => {
    const ps = await window.api.products.list(await window.api.companies.getActiveId(), {});
    const p = ps.find((x) => x.sku === ${JSON.stringify(sku0)});
    const imgs = await window.api.images.listByProduct(p.id);
    const list = imgs.images || imgs;
    return { count: list.length, first: list[0] ? list[0].filepath : null };
  })()`, true);
  const afterMainDom = await crawl.eval(`(document.querySelector('.bulk-table__image-count') || {}).textContent || ''`);
  await crawl.shot('bulk-table-image-main');
  const mainOk = mainResult && !mainResult.error && modeOn === 'true'
    && afterMain.count === beforeMain.count + 1
    && afterMain.first && afterMain.first !== beforeMain.first
    && countOf(afterMainDom) === afterMain.count;
  crawl.step('deep bulk table: Make main moves the pasted photo to position 0', mainOk,
    `mode ${modeOn} · ${beforeMain.count}→${afterMain.count} · first ${String(beforeMain.first).split('/').pop()} → ${String(afterMain.first).split('/').pop()}`);

  /* 7 ── Save all: dry run first, then the summary, then the commit. */
  /* Clearing row 0's brand through the select must send null, which overwrite
   * applies as "clear the field" — the reason the Unassigned option exists. */
  await crawl.eval(`window.__ui.set('select[data-row="0"][data-col="brandId"]', '')`);
  await crawl.settle(250);
  const brandCleared = await crawl.eval(`document.querySelector('select[data-row="0"][data-col="brandId"]').value`);
  crawl.step('deep bulk table: choosing Unassigned clears the cell', brandCleared === '', JSON.stringify({ brandCleared }));

  /* 6b ── two rows renamed to the SAME new SKU must refuse the WHOLE save and
   *       name the row. bulkUpsert is keyed by SKU, so without this check both
   *       rows would silently write the same product. */
  await crawl.eval(`window.__ui.set('input[data-row="0"][data-col="sku"]', ${JSON.stringify(renamedSku)})`);
  await crawl.settle(250);
  await crawl.eval(`window.__ui.clickExact('Save all')`);
  await crawl.waitFor(`!!document.querySelector('.bulk-table__confirm.is-error')`, 15_000, 'the refusal summary');
  await crawl.settle(250);
  const refused = await crawl.eval(`window.__ui.textOf(document.querySelector('.bulk-table__confirm'))`);
  const refusedToast = await crawl.eval('window.__ui.toastText()');
  const originalStillThere = await crawl.eval(`(async () => {
    const ps = await window.api.products.list(await window.api.companies.getActiveId(), {});
    return ps.some((x) => x.sku === ${JSON.stringify(sku0)});
  })()`, true);
  await crawl.shot('bulk-table-duplicate-refused');
  crawl.step('deep bulk table: a duplicate SKU refuses the whole save and names the row',
    /Save refused/.test(refused || '') && /already used by another product/.test(refused || '')
      && /row \d/.test(refused || '') && originalStillThere === true,
    `summary: ${refused || '(none)'} · original SKU still present: ${originalStillThere} · toast: ${refusedToast || '(none)'}`);
  // Put row 0's SKU back so the real save below can proceed.
  await crawl.eval(`window.__ui.set('input[data-row="0"][data-col="sku"]', ${JSON.stringify(sku0)})`);
  await crawl.settle(250);

  const saveAll = await crawl.eval(`window.__ui.clickExact('Save all')`);
  if (saveAll !== 'ok') { crawl.step('deep bulk table: Save all runs a dry run', false, saveAll); return; }
  await crawl.waitFor(`!!document.querySelector('.bulk-table__confirm')`, 15_000, 'the dry-run summary');
  await crawl.settle(300);
  const summary = await crawl.eval(`window.__ui.textOf(document.querySelector('.bulk-table__confirm'))`);
  const summaryToast = await crawl.eval('window.__ui.toastText()');
  await crawl.shot('bulk-table-dry-run');
  crawl.step('deep bulk table: the dry run reports the summary before writing',
    /\d+ updated/.test(summary || '') && /Save 2 products/.test(summary || '') && /updated/.test(summaryToast || ''),
    `summary: ${summary || '(none)'} · toast: ${summaryToast || '(none)'}`);

  /* ── v0.1.68 Fix 3: exactly ONE confirmation, and it names the count ─── */
  const firstPrompt = await crawl.eval(`(() => {
    const blocks = Array.from(document.querySelectorAll('.bulk-table__confirm'));
    const btn = blocks[0] ? Array.from(blocks[0].querySelectorAll('button')).map((b) => b.innerText) : [];
    return { count: blocks.length, buttons: btn };
  })()`);
  crawl.step('deep bulk table: the dry run shows exactly one confirmation naming the product count',
    firstPrompt.count === 1 && firstPrompt.buttons.includes('Save 2 products'),
    `${firstPrompt.count} prompt(s) · buttons ${JSON.stringify(firstPrompt.buttons)}`);

  /* Clicking Close while the summary is open must REPLACE it with the
   * unsaved-edits prompt — never stack a second prompt under it. */
  await crawl.eval(`window.__ui.clickExact('Close')`);
  await crawl.settle(350);
  const afterCloseClick = await crawl.eval(`(() => {
    const blocks = Array.from(document.querySelectorAll('.bulk-table__confirm'));
    return { count: blocks.length, text: blocks.map((b) => b.innerText).join(' || ') };
  })()`);
  crawl.step('deep bulk table: Close with the summary open shows ONE prompt, not two',
    afterCloseClick.count === 1 && /unsaved cell edit/i.test(afterCloseClick.text),
    `${afterCloseClick.count} prompt(s): ${String(afterCloseClick.text).slice(0, 140)}`);
  await crawl.eval(`window.__ui.click('.bulk-table__confirm button', 'Keep editing')`);
  await crawl.settle(300);

  /* Back to a summary for the real commit. */
  const saveAgain = await crawl.eval(`window.__ui.clickExact('Save all')`);
  await crawl.waitFor(`!!document.querySelector('.bulk-table__confirm')`, 15_000, 'the dry-run summary again');
  await crawl.settle(300);

  /* And nothing is written yet. */
  const beforeCommit = await crawl.eval(`(async () => {
    const ps = await window.api.products.list(await window.api.companies.getActiveId(), {});
    const p = ps.find((x) => x.sku === ${JSON.stringify(sku0)});
    return { subcategory: p ? p.subcategory : null };
  })()`, true);
  crawl.step('deep bulk table: the dry run wrote nothing', beforeCommit.subcategory !== 'Crawl A', JSON.stringify(beforeCommit));

  await crawl.eval(`window.__ui.click('.bulk-table__confirm button', 'Save 2 products')`);
  await crawl.waitFor(`!document.querySelector('.bulk-table__grid')`, 15_000, 'the table to close after saving');
  await crawl.settle(900);
  const savedToast = await crawl.eval('window.__ui.toastText()');
  const closedClean = await crawl.eval(`({
    modals: window.__ui.modalCount(),
    confirms: document.querySelectorAll('.bulk-table__confirm').length,
    dirtyPrompt: /unsaved cell edit/i.test(document.body.innerText),
  })`);
  crawl.step('deep bulk table: saving closes cleanly with no second confirmation',
    saveAgain === 'ok' && closedClean.modals === 0 && closedClean.confirms === 0 && closedClean.dirtyPrompt === false,
    JSON.stringify(closedClean));
  const afterSave = await crawl.eval(`(async () => {
    const ps = await window.api.products.list(await window.api.companies.getActiveId(), {});
    const a = ps.find((x) => x.sku === ${JSON.stringify(sku0)});
    const b = ps.find((x) => x.sku === ${JSON.stringify(renamedSku)});
    const old = ps.find((x) => x.sku === ${JSON.stringify(sku1)});
    return {
      a: a ? a.subcategory : null, brand: a ? a.brandId : 'missing',
      b: b ? b.subcategory : null, c: b ? b.colorFinish : null,
      oldSkuStillThere: !!old,
    };
  })()`, true);
  await crawl.shot('bulk-table-saved');
  crawl.step('deep bulk table: Confirm save writes the cells', /Saved 2 products/.test(savedToast || '') && afterSave.a === 'Crawl A' && afterSave.b === 'Paste A' && afterSave.c === 'Paste B',
    `toast: ${savedToast || '(none)'} · rows: ${JSON.stringify(afterSave)}`);
  crawl.step('deep bulk table: the edited SKU renamed the product', afterSave.oldSkuStillThere === false && afterSave.b === 'Paste A',
    `old ${sku1} still present: ${afterSave.oldSkuStillThere} · renamed to ${renamedSku}`);
  crawl.step('deep bulk table: Unassigned cleared the brand in the database', afterSave.brand === null,
    `brandId after save: ${JSON.stringify(afterSave.brand)} (was ${seeded.brandId})`);
}

/**
 * v0.1.67: the two features this release ships — the Library filter column's
 * retract / collapse controls, and the shared list tools on Brands,
 * Categories and Suppliers.
 *
 * The Feature A assertions read the real DOM AND the real localStorage keys,
 * because the point of the fix is that the toolbar button and the panel
 * chevron agree about ONE state (`ProductLibrary.panelVisible`) and one map
 * (`ProductLibrary.filterGroups`). Brands is exercised through to its delete
 * confirm (cancelled — the seeded starters are never deleted). Suppliers is
 * exercised through the refusal path, which needs a real supplier with a real
 * purchase order, so one is created over IPC first.
 */
async function deepListToolsFlow(crawl) {
  /* ── A: the Library filter column ─────────────────────────────────── */
  crawl.phase = 'deep: list tools library';
  await crawl.goto('Product Library');
  await crawl.waitFor(`!!document.querySelector('.lib-filters')`, 10_000, 'the filter column');

  // An active filter makes "Reset all filters" render; a search term is the
  // cheapest one to set, and clear again afterwards.
  await crawl.eval(`window.__ui.set('.page__header input.search-input', 'a')`);
  await crawl.settle(500);
  await crawl.waitFor(`!!document.querySelector('.lib-filters__reset')`, 6000, 'the reset button');
  const order = await crawl.eval(`(() => {
    const reset = document.querySelector('.lib-filters__reset');
    const first = document.querySelector('.filter-group');
    return {
      reset: !!reset, first: !!first,
      before: !!(reset && first && (reset.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  })()`);
  await crawl.shot('listtools-filters-top');
  crawl.step('list tools: Reset all filters sits above the first filter group',
    order.reset && order.first && order.before, JSON.stringify(order));

  // Collapse the Brand group: children hide, aria-expanded flips, the choice
  // is written to ProductLibrary.filterGroups.
  const beforeCollapse = await crawl.eval(`(() => {
    const group = [...document.querySelectorAll('.filter-group')]
      .find((g) => (g.querySelector('.filter-group__label') || {}).textContent === 'Brand');
    if (!group) return { error: 'no Brand group' };
    const before = group.querySelectorAll('.filter-pill').length;
    group.querySelector('.filter-group__toggle').click();
    return { before };
  })()`);
  await crawl.settle(250);
  const afterCollapse = await crawl.eval(`(() => {
    const group = [...document.querySelectorAll('.filter-group')]
      .find((g) => (g.querySelector('.filter-group__label') || {}).textContent === 'Brand');
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('ProductLibrary.filterGroups') || '{}'); } catch {}
    return {
      items: group ? !!group.querySelector('.filter-group__items') : null,
      expanded: group ? group.querySelector('.filter-group__toggle').getAttribute('aria-expanded') : null,
      stored: stored ? stored.Brand : null,
    };
  })()`);
  await crawl.shot('listtools-group-collapsed');
  crawl.step('list tools: a filter group collapses and remembers it',
    !beforeCollapse.error && beforeCollapse.before > 0
      && afterCollapse.items === false && afterCollapse.expanded === 'false' && afterCollapse.stored === false,
    JSON.stringify({ ...beforeCollapse, ...afterCollapse }));
  // Re-open, so the column is left as we found it.
  await crawl.eval(`(() => {
    const group = [...document.querySelectorAll('.filter-group')]
      .find((g) => (g.querySelector('.filter-group__label') || {}).textContent === 'Brand');
    group.querySelector('.filter-group__toggle').click();
  })()`);
  await crawl.settle(200);

  const mainWidth = () => crawl.eval(`Math.round(document.querySelector('.lib-main').getBoundingClientRect().width)`);

  /* Table view: retract, check the rail + the shared state, then expand. */
  const tableExpanded = await mainWidth();
  await crawl.eval(`document.querySelector('.lib-filters__collapse').click()`);
  await crawl.settle(400);
  const rail = await crawl.eval(`(() => ({
    aside: document.querySelector('.lib-filters').classList.contains('is-collapsed'),
    layout: document.querySelector('.lib-layout').classList.contains('lib-layout--filters-collapsed'),
    groups: document.querySelectorAll('.filter-group').length,
    chevron: !!document.querySelector('.lib-filters__collapse'),
    toolbar: (document.querySelector('.lib-panel-toggle') || {}).textContent,
    toolbarPressed: document.querySelector('.lib-panel-toggle') ? document.querySelector('.lib-panel-toggle').getAttribute('aria-pressed') : null,
    stored: localStorage.getItem('ProductLibrary.panelVisible'),
  }))()`);
  const tableCollapsed = await mainWidth();
  await crawl.shot('listtools-filters-rail');
  crawl.step('list tools: the filter column retracts to a rail with a way back',
    rail.aside && rail.layout && rail.groups === 0 && rail.chevron && rail.stored === 'off'
      && /Filters off/.test(rail.toolbar || '') && rail.toolbarPressed === 'false',
    JSON.stringify({ ...rail, tableExpanded, tableCollapsed }));
  crawl.step('list tools: the grid gets the width back in Table view',
    tableCollapsed - tableExpanded > 100, `expanded ${tableExpanded}px → rail ${tableCollapsed}px`);

  await crawl.eval(`document.querySelector('.lib-filters__collapse').click()`);
  await crawl.settle(400);
  const reExpanded = await crawl.eval(`(() => ({
    aside: document.querySelector('.lib-filters').classList.contains('is-collapsed'),
    layout: document.querySelector('.lib-layout').classList.contains('lib-layout--filters-collapsed'),
    groups: document.querySelectorAll('.filter-group').length,
    stored: localStorage.getItem('ProductLibrary.panelVisible'),
  }))()`);
  crawl.step('list tools: the column expands again',
    !reExpanded.aside && !reExpanded.layout && reExpanded.groups === 5 && reExpanded.stored === 'on',
    JSON.stringify(reExpanded));

  /* Grid view: same retract must return the width to the grid. */
  await crawl.eval(`window.__ui.click('.ws-toolbar__group .segment', 'Grid')`);
  await crawl.settle(600);
  const gridExpanded = await mainWidth();
  await crawl.eval(`document.querySelector('.lib-filters__collapse').click()`);
  await crawl.settle(400);
  const gridCollapsed = await mainWidth();
  await crawl.eval(`document.querySelector('.lib-filters__collapse').click()`);
  await crawl.settle(400);
  crawl.step('list tools: the grid gets the width back in Grid view',
    gridCollapsed - gridExpanded > 100, `expanded ${gridExpanded}px → rail ${gridCollapsed}px`);

  // Leave the Library on Table with no search filter.
  await crawl.eval(`window.__ui.click('.ws-toolbar__group .segment', 'Table')`);
  await crawl.settle(300);
  await crawl.eval(`window.__ui.set('.page__header input.search-input', '')`);
  await crawl.settle(500);

  /* ── B: Brands ────────────────────────────────────────────────────── */
  crawl.phase = 'deep: list tools brands';
  const stamp = String(Date.now()).slice(-6);
  const brandNames = [`Crawl Tool A ${stamp}`, `Crawl Tool B ${stamp}`];
  const made = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    const names = ${JSON.stringify(brandNames)};
    const created = [];
    for (const name of names) created.push(await window.api.brands.create({ companyId: cid, name }));
    // Put a real product on the first brand so the bulk delete's confirm has
    // an honest "N products will lose their brand" sentence to show.
    const ps = await window.api.products.list(cid, {});
    if (ps.length) await window.api.products.update(ps[0].id, { brandId: created[0].id });
    return { names, attached: ps.length > 0 };
  })()`, true).catch((err) => ({ error: err.message }));
  if (!made || made.error) { crawl.step('list tools: seed two brands', false, JSON.stringify(made)); return; }
  crawl.step('list tools: seed two brands', true, `${made.names.join(', ')} · product attached: ${made.attached}`);
  await crawl.settle(700);

  await crawl.goto('Brands');
  await crawl.waitFor(`!!document.querySelector('.list-tools input.search-input')`, 8000, 'the Brands search box');
  await crawl.eval(`window.__ui.set('.list-tools input.search-input', ${JSON.stringify(stamp)})`);
  await crawl.waitFor(`document.querySelectorAll('.entity-card').length === 2`, 8000, 'the two seeded brands');
  const brandCount = await crawl.eval(`document.querySelectorAll('.entity-card').length`);
  crawl.step('list tools: the Brands search filters the list', brandCount === 2, `${brandCount} card(s) for "${stamp}"`);
  await crawl.shot('listtools-brands-search');

  // Name Z–A must float "Crawl Tool B" to the top.
  await crawl.eval(`window.__ui.set('.list-tools select', 'nameDesc')`);
  await crawl.settle(400);
  const firstTitle = await crawl.eval(`(document.querySelector('.entity-card__title') || {}).textContent || null`);
  crawl.step('list tools: the Brands sort select reorders', /Crawl Tool B/.test(firstTitle || ''), `first card: ${firstTitle}`);

  // Plain-click the first row, ⌘-click the second: the two documented
  // selection gestures, and it leaves the count at 2.
  await crawl.eval(`(() => {
    const boxes = [...document.querySelectorAll('.entity-card__check')];
    if (boxes[0] && !boxes[0].checked) boxes[0].click();
    if (boxes[1] && !boxes[1].checked) {
      boxes[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    }
    return boxes.length;
  })()`);
  await crawl.settle(300);
  const bulkCount = await crawl.eval(`(document.querySelector('.list-bulk-bar__count') || {}).textContent || null`);
  const chip = await crawl.eval(`(() => {
    const el = document.querySelector('.list-tools__unassigned');
    return el ? el.textContent : null;
  })()`);
  await crawl.shot('listtools-brands-selected');
  crawl.step('list tools: ticking rows shows the bulk count', /2 selected/.test(bulkCount || ''), `bulk bar: ${bulkCount}`);
  crawl.step('list tools: Brands offers the All · Unassigned chip', /Unassigned \(\d+\)/.test(chip || ''), `chip: ${chip}`);

  // Open the delete confirm and CANCEL — the seeded starters are never deleted.
  await crawl.eval(`window.__ui.click('.list-bulk-bar button', 'Delete 2')`);
  await crawl.waitFor(`window.__ui.modalCount() > 0`, 5000, 'the bulk delete confirm');
  const confirmBody = await crawl.eval(`window.__ui.textOf(document.querySelector('.modal'))`);
  crawl.step('list tools: the bulk delete confirm explains the unassign',
    /will lose their brand/.test(confirmBody || ''), `confirm: ${(confirmBody || '').slice(0, 140)}…`);
  await crawl.eval(`window.__ui.click('.modal__footer button', 'Keep')`);
  await crawl.settle(400);
  const stillThere = await crawl.eval(`document.querySelectorAll('.entity-card').length`);
  crawl.step('list tools: cancelling the delete keeps the brands', stillThere === 2, `${stillThere} card(s) still listed`);
  await crawl.eval(`window.__ui.click('.list-bulk-bar button', 'Clear')`);
  await crawl.settle(200);

  /* ── B: Categories reachable from Settings, with the chip ─────────── */
  crawl.phase = 'deep: list tools categories';
  // The Categories toolbar only renders once the list is non-empty, so seed
  // one category before opening the Settings tab.
  const catName = `Crawl Category ${stamp}`;
  const catSeed = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    const c = await window.api.categories.create({ companyId: cid, name: ${JSON.stringify(catName)} });
    return c.name;
  })()`, true).catch((err) => ({ error: err.message }));
  if (!catSeed || catSeed.error) { crawl.step('list tools: seed a category', false, JSON.stringify(catSeed)); return; }
  crawl.step('list tools: seed a category', true, catSeed);
  await crawl.settle(500);
  await crawl.goto('Settings');
  await crawl.eval(`window.__ui.click('.settings-tabs button', 'Categories')`);
  await crawl.waitFor(`!!document.querySelector('.list-tools input.search-input')`, 8000, 'the Categories toolbar');
  const catTools = await crawl.eval(`(() => {
    const chipEl = document.querySelector('.list-tools__unassigned');
    return {
      search: !!document.querySelector('.list-tools input.search-input'),
      sort: !!document.querySelector('.list-tools select'),
      check: !!document.querySelector('.categories-list__check, .list-tools input[type="checkbox"]'),
      chip: chipEl ? chipEl.textContent : null,
      crash: window.__ui.crash(),
    };
  })()`);
  await crawl.shot('listtools-categories');
  crawl.step('list tools: Categories (Settings tab) carries the same toolbar',
    catTools.search && catTools.sort && catTools.check && /Uncategorized \(\d+\)/.test(catTools.chip || '') && !catTools.crash,
    JSON.stringify(catTools));

  /* ── B: Suppliers refuse a delete while POs exist ─────────────────── */
  crawl.phase = 'deep: list tools suppliers';
  const supName = `Crawl Refusal ${stamp}`;
  const poSeed = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    const sup = await window.api.suppliers.create({ companyId: cid, name: ${JSON.stringify(supName)} });
    const po = await window.api.purchaseOrders.create({ companyId: cid, supplierId: sup.id, poNumber: 'CRAWL-1' });
    return { supId: sup.id, poId: po.id };
  })()`, true).catch((err) => ({ error: err.message }));
  if (!poSeed || poSeed.error) { crawl.step('list tools: a supplier with a PO exists', false, JSON.stringify(poSeed)); return; }
  crawl.step('list tools: a supplier with a PO exists', true, `supplier ${poSeed.supId} · PO ${poSeed.poId}`);

  await crawl.goto('Suppliers');
  await crawl.waitFor(`!!document.querySelector('.suppliers-toolbar input.search-input')`, 8000, 'the Suppliers search box');
  const supSort = await crawl.eval(`!!document.querySelector('.suppliers-toolbar select')`);
  crawl.step('list tools: Suppliers has a sort select', supSort, `sort select present: ${supSort}`);
  await crawl.eval(`window.__ui.set('.suppliers-toolbar input.search-input', ${JSON.stringify(supName)})`);
  await crawl.waitFor(`window.__ui.textOf(document.body).includes(${JSON.stringify(supName)})`, 8000, 'the supplier row');
  // The Orders chip only renders once the PO rollup has loaded — which is the
  // data the pre-check reads, so waiting for it makes the refusal deterministic.
  await crawl.waitFor(`!!document.querySelector('.supplier-orders-btn')`, 8000, 'the PO rollup chip');
  await crawl.settle(300);
  const ticked = await crawl.eval(`(() => {
    const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent.includes(${JSON.stringify(supName)}));
    const b = tr && tr.querySelector('input[type="checkbox"]');
    if (b && !b.checked) b.click();
    return !!b;
  })()`);
  await crawl.settle(300);
  const supBulk = await crawl.eval(`(document.querySelector('.list-bulk-bar__count') || {}).textContent || null`);
  crawl.step('list tools: ticking a supplier shows the bulk count', ticked && /1 selected/.test(supBulk || ''), `bulk bar: ${supBulk}`);
  await crawl.eval(`window.__ui.click('.list-bulk-bar button', 'Delete 1')`);
  await crawl.settle(500);
  const refusalToast = await crawl.eval('window.__ui.toastText()');
  const refusalModals = await crawl.eval('window.__ui.modalCount()');
  await crawl.shot('listtools-suppliers-refusal');
  crawl.step('list tools: a supplier with POs is refused by name and PO count',
    /purchase order/i.test(refusalToast || '') && /Archive instead/i.test(refusalToast || '') && refusalModals === 0,
    `toast: ${refusalToast || '(none)'} · modals: ${refusalModals}`);
  await crawl.eval(`window.__ui.click('.list-bulk-bar button', 'Clear')`).catch(() => {});
}

const PAGE_LABELS = [
  ['company', 'Company'],
  ['dashboard', 'Dashboard'],
  ['brands', 'Brands'],
  ['library', 'Product Library'],
  ['workspace', 'Image Workspace'],
  ['aistudio', 'AI Studio'],
  ['overlay', 'Overlay Studio'],
  ['export', 'Export Center'],
  ['labeltemplates', 'Label Templates'],
  ['labelgenerate', 'Generate & Print'],
  ['barcodes', 'Barcode Maker'],
  ['labeljobs', 'Label History'],
  ['catalogtemplates', 'Catalog Templates'],
  ['catalogprojects', 'Catalog Projects'],
  ['socialgrid', 'Social Grid'],
  ['suppliers', 'Suppliers'],
  ['purchaseorders', 'Purchase Orders'],
  ['costcalc', 'Cost Calculator'],
  ['history', 'History'],
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const target = await findPageTarget(args.port);
  process.stdout.write(`Connected to ${target.url}\n`);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const crawl = new Crawl(cdp, args.out, args.verbose);

  // A real photo for the Image Workspace leg. Noise-free flat artwork keeps the
  // file small; the pipeline only needs real pixels with real dimensions.
  const photoPath = path.join(args.out, 'probe-photo.jpg');
  if (!fs.existsSync(photoPath)) {
    const sharp = require('sharp');
    await sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 214, g: 220, b: 230 } } })
      .composite([{ input: Buffer.from('<svg width="900" height="900"><rect x="250" y="250" width="400" height="400" rx="24" fill="#5b7cfa"/><circle cx="450" cy="450" r="120" fill="#f5f7ff"/></svg>'), top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toFile(photoPath);
  }

  await crawl.start();

  /* 1 ── shell is alive */
  crawl.phase = 'shell';
  await crawl.waitFor(`window.__ui.count('.sidebar__item') > 5`, 20_000, 'sidebar to render');
  const version = await crawl.eval(`window.__ui.textOf(document.querySelector('.sidebar__version'))`);
  await crawl.step('shell renders', true, `version chip ${version || '(missing)'}`);
  if (!version || version === 'v0.0.0') crawl.step('version chip is real', false, `got ${version}`);

  /* 2 ── create a company through the UI so the other pages have data */
  crawl.phase = 'seed company';
  try {
  await crawl.goto('Company');
  const already = await crawl.eval(`(async () => {
    const cs = await window.api.companies.list();
    return cs.some((c) => c.name === 'UI Crawl Co') ? 'yes' : 'no';
  })()`, true);
  if (already === 'yes') {
    crawl.step('seed company', true, 'already present');
  } else {
    const opened = await crawl.eval(`window.__ui.click('button', '+ New company')`);
    if (opened !== 'ok') {
      crawl.step('seed company', false, `could not open the New company modal (${opened})`);
    } else {
      await crawl.waitFor(`window.__ui.modalCount() > 0`, 4000, 'company modal');
      await crawl.eval(`window.__ui.set('input[placeholder="e.g. ABC Imports"]', 'UI Crawl Co')`);
      await crawl.settle(150);
      await crawl.eval(`window.__ui.click('button', 'Create')`);
      await crawl.settle(700);
      const closed = await crawl.eval(`window.__ui.modalCount() === 0`);
      const listed = await crawl.eval(`window.__ui.textOf(document.body).includes('UI Crawl Co')`);
      crawl.step('seed company', closed && listed, closed ? 'created and listed' : 'modal stayed open (create failed)');
    }
  }
  await crawl.shot('company');
  } catch (err) {
    crawl.step('seed company', false, `crawl error: ${err.message}`);
  }

  /* 3 ── every page */
  for (const [id, label] of PAGE_LABELS) {
    try {
      await crawl.checkPage(id, label);
    } catch (err) {
      crawl.step(`page ${id}`, false, `crawl error: ${err.message}`);
    }
  }

  /* 4 ── Settings: every tab */
  crawl.phase = 'settings tabs';
  await crawl.goto('Settings');
  const tabs = await crawl.eval(`window.__ui.all('.settings-tabs button').map(window.__ui.textOf)`);
  for (const tab of tabs || []) {
    crawl.phase = `settings:${tab}`;
    try {
    await crawl.eval(`window.__ui.click('.settings-tabs button', ${JSON.stringify(tab)})`);
    await crawl.waitFor(
      `!document.querySelector('.page-fallback') && (document.querySelector('.page__header') || document.querySelector('.page__error'))`,
      15_000,
      `settings tab ${tab}`,
    );
    await crawl.settle(350);
    const crash = await crawl.eval('window.__ui.crash()');
    const bare = await crawl.eval('window.__ui.bareRanges()');
    await crawl.shot(`settings-${tab.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    if (crash) crawl.step(`settings tab ${tab}`, false, `CRASHED: ${crash}`);
    else if (bare.length) crawl.step(`settings tab ${tab}`, false, `bare range: ${JSON.stringify(bare)}`);
    else crawl.step(`settings tab ${tab}`, true);
    } catch (err) {
      crawl.step(`settings tab ${tab}`, false, `crawl error: ${err.message}`);
    }
  }

  /* 5 ── price group → Social Grid picker (the v0.1.55/0.1.56 flow) */
  crawl.phase = 'price groups';
  await crawl.eval(`window.__ui.click('.settings-tabs button', 'General')`);
  await crawl.settle(400);
  let added = false;
  // The label lives in an <input value>, invisible to innerText — ask the rows.
  const existing = await crawl.eval(`window.__ui.all('.price-groups__row input').some((i) => i.value === 'UI Crawl Export')`);
  if (existing) {
    added = true;
    crawl.step('price group add', true, 'already present');
  } else {
    const res = await crawl.eval(`window.__ui.set('input[placeholder="New price group name (e.g. Export)"]', 'UI Crawl Export')`);
    if (res !== 'ok') {
      crawl.step('price group add', false, `input not found (${res})`);
    } else {
      await crawl.settle(150);
      await crawl.eval(`window.__ui.click('button', 'Add group')`);
      await crawl.settle(800);
      // The row's label lives in an <input value>, which innerText cannot see.
      const hasRow = await crawl.eval(`window.__ui.all('.price-groups__row input').some((i) => i.value === 'UI Crawl Export')`);
      const key = await crawl.eval(`window.__ui.all('.price-groups__row').map(window.__ui.textOf).join(' / ')`);
      added = hasRow;
      crawl.step('price group add', hasRow, hasRow ? `stored key row: ${String(key).replace(/\s+/g, ' ')}` : 'row did not appear');
    }
  }
  if (added) {
    crawl.phase = 'price group reaches social grid';
    await crawl.goto('Social Grid');
    // The controls live in a post editor, not on the list screen.
    const openedPost = await crawl.eval(`window.__ui.clickExact('+ New post')`);
    if (openedPost !== 'ok') {
      crawl.step('price group reaches Social Grid', false, `could not open the new-post modal (${openedPost})`);
    } else {
      await crawl.waitFor(`window.__ui.fieldInput('Post name') !== null`, 6000, 'the new-post modal');
      await crawl.eval(`window.__ui.fieldSet('Post name', 'UI Crawl post')`);
      await crawl.eval(`window.__ui.clickExact('Create post')`);
      await crawl.waitFor(`window.__ui.fieldInput('Which price') !== null`, 15_000, 'the grid controls');
      await crawl.settle(500);
    }
    const options = await crawl.eval(`window.__ui.fieldOptions('Which price')`);
    const flat = Array.isArray(options) ? options.join(' | ') : String(options);
    const found = flat.includes('UI Crawl Export');
    crawl.shot('socialgrid-price-options');
    crawl.step('price group reaches Social Grid', found, found ? 'the new group is offered under “Which price”' : `not offered — options: ${flat.slice(0, 200)}`);
  }

  /* 6 ── What's new: Esc and backdrop dismissal (§2) */
  crawl.phase = "what's new";
  const openedWN = await crawl.eval(`window.__ui.click('.sidebar__footer-btn', "What's new")`);
  if (openedWN !== 'ok') {
    crawl.step("What's new opens", false, openedWN);
  } else {
    await crawl.waitFor(`window.__ui.modalCount() > 0`, 4000, "What's new modal");
    const body = await crawl.eval('window.__ui.openModal()');
    await crawl.shot('whats-new');
    const topVersion = (body || '').slice(0, 6);
    crawl.step("What's new opens", true, `top entry starts “${topVersion.replace(/\n/g, ' ')}”`);
    const expected = version ? version.replace(/^v/, '') : '';
    crawl.step("What's new shows the shipped version", expected && (body || '').includes(expected), `looking for ${expected}`);
    await crawl.eval('window.__ui.pressEscape()');
    await crawl.settle(300);
    let closed = await crawl.eval('window.__ui.modalCount() === 0');
    crawl.step("What's new closes on Esc", closed, closed ? '' : 'still open');
    if (!closed) {
      await crawl.eval(`window.__ui.pressEscape()`);
      await crawl.settle(250);
      closed = await crawl.eval('window.__ui.modalCount() === 0');
    }
    // and the backdrop path, from a fresh open
    if (closed) {
      await crawl.eval(`window.__ui.click('.sidebar__footer-btn', "What's new")`);
      await crawl.waitFor(`window.__ui.modalCount() > 0`, 4000, "What's new modal (2nd)");
      await crawl.eval(`window.__ui.mouseDown('.modal-backdrop')`);
      await crawl.settle(300);
      const backdropClosed = await crawl.eval('window.__ui.modalCount() === 0');
      crawl.step('modal closes on backdrop mousedown', backdropClosed, backdropClosed ? '' : 'still open');
      if (!backdropClosed) {
        await crawl.eval(`window.__ui.pressEscape()`);
        await crawl.settle(250);
      }
    }
    const leftover = await crawl.eval('window.__ui.modalCount()');
    if (leftover) {
      await crawl.eval('window.__ui.pressEscape()');
      await crawl.settle(250);
      crawl.step('no modal left open into later steps', false, `${leftover} modal(s) were open`);
    }
  }

  /* 7 ── Support page from the sidebar footer */
  crawl.phase = 'support';
  await crawl.eval(`window.__ui.click('.sidebar__footer-btn', 'Support this app')`);
  await crawl.settle(500);
  const supportCrash = await crawl.eval('window.__ui.crash()');
  await crawl.shot('support');
  crawl.step('support page renders', !supportCrash, supportCrash || '');

  /* 8 ── real data behind the screens that need it */
  try {
    await deepImageFlow(crawl, photoPath);
  } catch (err) {
    crawl.step('deep image flow', false, `crawl error: ${err.message}`);
  }

  /* 9 ── the overlay editor, which no page loop reaches */
  try {
    await deepOverlayFlow(crawl);
  } catch (err) {
    crawl.step('deep overlay flow', false, `crawl error: ${err.message}`);
  }

  /* 10 ── social templates: save one, then apply it from the Library */
  try {
    await deepSocialTemplateFlow(crawl, path.join(args.out, 'social-out'));
  } catch (err) {
    crawl.step('deep social template flow', false, `crawl error: ${err.message}`);
  }

  /* 11 ── catalog templates: build one, save it, use it */
  try {
    await deepCatalogTemplateFlow(crawl);
  } catch (err) {
    crawl.step('deep catalog template flow', false, `crawl error: ${err.message}`);
  }

  /* 12 ── the label designer (ported interaction model) */
  try {
    await deepLabelDesignerFlow(crawl);
  } catch (err) {
    crawl.step('deep label designer flow', false, `crawl error: ${err.message}`);
  }

  /* 13 ── the bulk edit table (v0.1.66) */
  try {
    await deepBulkTableFlow(crawl, photoPath);
  } catch (err) {
    crawl.step('deep bulk table flow', false, `crawl error: ${err.message}`);
  }

  /* 14 ── the Library filter column + the simple-list tools (v0.1.67) */
  try {
    await deepListToolsFlow(crawl);
  } catch (err) {
    crawl.step('deep list tools flow', false, `crawl error: ${err.message}`);
  }

  /* ── report ── */
  const failed = crawl.results.filter((r) => !r.ok);
  // Electron prints a CSP warning in any unpackaged build; it is a build-mode
  // artifact, not an app bug, and it never appears in the DMG.
  // Noise: DevTools/autofill chatter, Electron's unpackaged-build CSP warning,
  // and ONNX's "no crossOriginIsolated" thread notice (Electron never sets
  // COOP/COEP, so the WASM backend always falls back to single-threading).
  const NOISE = /DevTools|Autofill|extension|Electron Security Warning|numThreads is set to|crossOriginIsolated|multi-threading is not supported/i;
  const errors = crawl.errors.filter((e) => !NOISE.test(e.text));
  process.stdout.write(`\n── summary ──\n`);
  process.stdout.write(`${crawl.results.length - failed.length}/${crawl.results.length} steps passed\n`);
  if (failed.length) {
    process.stdout.write(`\nFAILED STEPS\n`);
    for (const f of failed) process.stdout.write(`  - ${f.step}: ${f.detail}\n`);
  }
  if (errors.length) {
    process.stdout.write(`\nCONSOLE / PAGE ERRORS (${errors.length})\n`);
    const seen = new Set();
    for (const e of errors) {
      const line = `  [${e.phase}] ${e.kind}: ${e.text}`;
      if (seen.has(line)) continue;
      seen.add(line);
      process.stdout.write(`${line}\n`);
    }
  } else {
    process.stdout.write(`no console errors or exceptions\n`);
  }
  process.stdout.write(`\nscreenshots: ${args.out}\n`);
  fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify({
    steps: crawl.results, errors, screenshots: crawl.shots,
  }, null, 2));

  cdp.close();
  process.exit(failed.length || errors.length ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`CRAWL FAILED: ${err.stack || err.message}\n`);
  process.exit(1);
});
