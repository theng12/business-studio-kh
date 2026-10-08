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
 *   2. visits every page, one by one — through its Home tile, then the module
 *      sidebar (2026-10-08: the sidebar lists one module) — recording a screenshot, the page
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
    /* 2026-10 audit: the label designer's number boxes are NumberFields that
     * commit on Enter / blur, never per keystroke — type, then press Enter. */
    fieldCommit: (label, value) => {
      const el = api.fieldInput(label);
      if (!el) return 'MISS field ' + label;
      el.focus();
      setNative(el, String(value));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      el.blur();
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
    /* v0.1.69: the operations menu is two-level now. Find an item wherever it
     * lives — flat (search active) or inside whichever section submenu holds
     * it — and click it, so callers do not have to know the section. */
    bulkMenuItem: async (label) => {
      const inPanel = all('.lib-bulk-menu__panel .lib-bulk-menu__item').find((i) => textOf(i).includes(label));
      if (inPanel) { inPanel.click(); return 'ok'; }
      for (const trigger of all('.lib-bulk-menu__section-trigger')) {
        trigger.click();
        await new Promise((r) => setTimeout(r, 140));
        const item = all('.lib-bulk-menu__submenu .lib-bulk-menu__item').find((i) => textOf(i).includes(label));
        if (item) { item.click(); return 'ok'; }
      }
      return 'MISS ' + label;
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
    /* Real drag gestures. React's synthetic handlers listen on the root, and
     * both the mouse-based screens and the pointer-based label designer (v0.1.72)
     * listen on window, so dispatch BOTH a PointerEvent and the MouseEvent the
     * older screens still use — the same pair a real mouse produces. Neither
     * type double-fires a component, because each component subscribes to one
     * of them. A pointerdown target is also given pointer capture best-effort,
     * which the designer's synthetic events cannot actually take (it catches
     * the throw); the window listeners carry the drag either way. */
    mouseDragPoint: async (target, fromX, fromY, toX, toY) => {
      const fire = (node, type, cx, cy) => {
        const common = {
          bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
        };
        if (typeof PointerEvent === 'function') {
          node.dispatchEvent(new PointerEvent(type.replace('mouse', 'pointer'), {
            ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          }));
        }
        node.dispatchEvent(new MouseEvent(type, common));
      };
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
     * multi-selection without depending on where the boxes happen to sit.
     * v0.1.72: the designer selects on pointerdown, so send the pointer pair
     * as well as the mouse pair (see mouseDragPoint). */
    clickElAt: (index, shift) => {
      const list = all('.ld-el');
      const el = list[index];
      if (!el) return 'MISS index ' + index;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      const fire = (node, type, buttons) => {
        const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, shiftKey: !!shift };
        if (typeof PointerEvent === 'function') {
          node.dispatchEvent(new PointerEvent(type.replace('mouse', 'pointer'), {
            ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          }));
        }
        node.dispatchEvent(new MouseEvent(type, common));
      };
      fire(el, 'mousedown', 1);
      fire(window, 'mouseup', 0);
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
    // A toolkit helper that cannot find its target returns 'MISS …'. Many
    // navigation clicks are not asserted, so print every miss: a renamed
    // button otherwise goes stale silently (the 2026-10 "Cancel" → "Close").
    const value = res.result.value;
    if (typeof value === 'string' && value.startsWith('MISS')) {
      process.stdout.write(`  miss [${this.phase || '-'}] ${value}\n`);
    }
    return value;
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

  /* Click the sidebar item with this exact label; 'absent' when the sidebar
   * shows another module (not a 'MISS': goto then goes through Home). */
  async clickSidebar(label) {
    return this.eval(`(() => {
      const item = window.__ui.all('.sidebar__item').find((el) => window.__ui.textOf(el.querySelector('span:not(.sidebar__item-shortcut)')) === ${JSON.stringify(label)});
      if (!item) return 'absent';
      item.click();
      return 'ok';
    })()`);
  }

  /* The module the sidebar is showing ('' on Home). */
  async sidebarModule() {
    return this.eval(`(document.querySelector('.sidebar__nav [data-module]:not(.sidebar__item)')?.dataset?.module) || ''`);
  }

  /* Home through the sidebar's Home item, then wait for the tiles. */
  async goHome() {
    const res = await this.eval(`window.__ui.click('.sidebar__home')`);
    if (res !== 'ok') throw new Error(`Home item not found (${res})`);
    await this.waitFor(`document.querySelectorAll('.home-tile').length > 0 && !!document.querySelector('.sidebar__home.is-active')`, 10_000, 'the Home grid');
    await this.settle(200);
  }

  /* Open a module by clicking its Home tile, as a user does. */
  async openModule(moduleId) {
    await this.goHome();
    const res = await this.eval(`(() => {
      const tile = document.querySelector('.home-tile[data-module=${JSON.stringify(moduleId)}]');
      if (!tile) return 'MISS tile ${moduleId}';
      if (tile.getAttribute('aria-disabled') === 'true') return 'MISS tile ${moduleId} is disabled';
      tile.click();
      return 'ok';
    })()`);
    if (res !== 'ok') throw new Error(res);
    await this.waitFor(`(document.querySelector('.sidebar__nav [data-module]:not(.sidebar__item)')?.dataset?.module) === ${JSON.stringify(moduleId)}`, 10_000, `the ${moduleId} sidebar`);
  }

  /* A real key press through CDP (focus, activation and React all see it). */
  async key(key, { code = key, keyCode = 0, modifiers = 0, text } = {}) {
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    if (text) await this.cdp.send('Input.dispatchKeyEvent', { type: 'char', key, code, text, windowsVirtualKeyCode: keyCode, modifiers });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }

  /* Navigate by clicking the real sidebar button. The sidebar shows one
   * module (2026-10-08), so a page in another module is reached the way a user
   * reaches it: Home → the module's tile → the page in its sidebar. */
  async goto(label, moduleId = MODULE_OF_LABEL[label]) {
    let res = await this.clickSidebar(label);
    if (res !== 'ok' && moduleId) {
      await this.openModule(moduleId);
      res = await this.clickSidebar(label);
    }
    if (res !== 'ok') throw new Error(`sidebar item not found: ${label} (${res})`);
    await this.waitFor(
      `!document.querySelector('.page-fallback') && (document.querySelector('.page__header') || document.querySelector('.page__error'))`,
      15_000,
      `page ${label} to render`,
    );
    await this.settle();
  }

  async checkPage(id, label, moduleId) {
    this.phase = `page:${id}`;
    await this.goto(label, moduleId);
    if (moduleId) {
      const side = await this.sidebarModule();
      if (side !== moduleId) {
        this.step(`page ${id}`, false, `the sidebar shows ${side || 'Home'}, not ${moduleId}`);
        return;
      }
    }
    const crash = await this.eval('window.__ui.crash()');
    const header = await this.eval('window.__ui.header()');
    if (id === 'history') {
      const globalHistory = await this.eval(`!!document.querySelector('.page--history') && window.__ui.textOf(document.querySelector('.page--history .page__title')) === 'History'`);
      if (!globalHistory) {
        this.step('page history', false, `Expected global History, got ${header || '(no header)'}`);
        return;
      }
    }
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
  // user takes. `Create` leaves the form open on purpose. 2026-10 audit: once
  // the product exists (and auto-saves) the panel's button reads "Close" —
  // "Cancel" only appears on an unsaved draft.
  const closedPanel = await crawl.eval(`window.__ui.clickExact('Close')`);
  await crawl.settle(600);
  const panelGone = await crawl.eval(`!!document.querySelector('.lib-inspector') && document.querySelector('.lib-inspector').hidden`);
  crawl.step("deep: a saved product's panel closes with Close", closedPanel === 'ok' && panelGone,
    `${closedPanel} · details hidden: ${panelGone}`);
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
  /* UI pass 2026-10: posts and templates are both shared `.card`s now; a post
   * is the card whose eyebrow is its grid ("3 × 3 grid"), a template's says
   * "Template". The eyebrow is CSS-uppercased, so read textContent. */
  const hasPost = await crawl.eval(`window.__ui.all('.social-card').some((c) => /grid/i.test((c.querySelector('.card__eyebrow') || {}).textContent || ''))`);
  if (!hasPost) {
    await crawl.eval(`window.__ui.clickExact('+ New post')`);
    await crawl.waitFor(`window.__ui.fieldInput('Post name') !== null`, 6000, 'the new-post modal');
    await crawl.eval(`window.__ui.fieldSet('Post name', 'UI Crawl post')`);
    await crawl.eval(`window.__ui.clickExact('Create post')`);
    await crawl.waitFor(`!!document.querySelector('.social-editor')`, 12_000, 'the Social Grid editor');
    await crawl.settle(700);
  } else {
    await crawl.eval(`(() => {
      const card = window.__ui.all('.social-card').find((c) => /grid/i.test((c.querySelector('.card__eyebrow') || {}).textContent || ''));
      const open = card && Array.from(card.querySelectorAll('.card__actions button')).find((b) => b.textContent.trim() === 'Open');
      if (!open) return 'MISS Open';
      open.click();
      return 'ok';
    })()`);
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
  // The PageHeader `backTo` button is the editor's only way back.
  await crawl.eval(`window.__ui.click('.page__back', 'Social Grid')`);
  await crawl.settle(1200);
  const listed = await crawl.eval(`(() => {
    const card = Array.from(document.querySelectorAll('.social-card'))
      .filter((c) => ((c.querySelector('.card__eyebrow') || {}).textContent || '').trim() === 'Template')
      .find((c) => c.innerText.includes(${JSON.stringify(tplName)}));
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
  // UI pass 2026-10: the count lives once, in the bar's "N selected"; the
  // "Image operations ▾" button no longer repeats it.
  const selectedCount = await crawl.eval(`(() => {
    const count = document.querySelector('.lib-bulk-toolbar__count');
    const btn = Array.from(document.querySelectorAll('.lib-bulk-toolbar button')).find((b) => String(b.innerText).startsWith('Image operations'));
    return count && btn && /^[1-9]\\d* selected/.test(count.textContent.trim()) ? count.textContent.trim() : null;
  })()`);
  if (!selectedCount) {
    crawl.step('deep: select products + open the bulk menu', false, `found ${picked} row checkbox(es), no toolbar`);
    return;
  }
  await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.settle(400);
  const menuItem = await crawl.eval(`window.__ui.bulkMenuItem('Social post')`, true);
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
  // UI pass 2026-10: the controls column is `.catalog-sidebar`, one
  // `.catalog-sidebar__section` per group (Template, Cover, Layout, Style, Card fields).
  const sections = await crawl.eval(`window.__ui.all('.catalog-sidebar section h3, .catalog-design-section > summary .section-title').map((h) => h.textContent)`);
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
  // Optional design groups are native disclosures; exercise their visible controls.
  await crawl.eval(`(() => { for (const d of document.querySelectorAll('.catalog-design-section')) { const label = d.querySelector('summary .section-title')?.textContent; if (['Style', 'Cover', 'Card fields'].includes(label) && !d.open) d.querySelector('summary').click(); } })()`);
  await crawl.settle(100);
  await crawl.eval(`window.__ui.click('.theme-choices button', 'Minimal')`);
  await crawl.settle(200);
  const coverOff = await crawl.eval(`(() => {
    const label = Array.from(document.querySelectorAll('.catalog-sidebar .catalog-check')).find((l) => /cover page/i.test(l.textContent));
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
    // "My templates" is the section whose title says so; its cards are shared .card elements.
    const mine = Array.from(document.querySelectorAll('.catalog-section'))
      .find((sec) => /My templates/.test((sec.querySelector('.section-title') || {}).textContent || ''));
    const card = mine && Array.from(mine.querySelectorAll('.card')).find((c) => c.innerText.includes(${JSON.stringify(name)}));
    return card ? card.innerText.replace(/\\n+/g, ' | ') : null;
  })()`);
  await crawl.shot('catalog-templates-saved');
  crawl.step('deep: the template is saved and listed', !!listed, listed || `not found under My templates · toast: ${savedToast || '(none)'}`);

  /* Create a catalog from it and verify the project picked up the design. */
  crawl.phase = 'deep: catalog from template';
  const usedIt = await crawl.eval(`(() => {
    // "My templates" is the section whose title says so; its cards are shared .card elements.
    const mine = Array.from(document.querySelectorAll('.catalog-section'))
      .find((sec) => /My templates/.test((sec.querySelector('.section-title') || {}).textContent || ''));
    const card = mine && Array.from(mine.querySelectorAll('.card')).find((c) => c.innerText.includes(${JSON.stringify(name)}));
    if (!card) return 'MISS';
    const btn = Array.from(card.querySelectorAll('.card__actions button')).find((b) => b.textContent.trim() === 'Use template');
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
  await crawl.waitFor(`!!document.querySelector('.catalog-editor-page .segments')`, 15_000, 'the catalog editor');
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
  await crawl.waitFor(`!!document.querySelector('.catalog-editor-page .catalog-sidebar') && window.__ui.fieldInput('Name') !== null && /template/.test(window.__ui.fieldValue('Name') || '')`, 6000, 'the builder from a project');
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
  // UI pass 2026-10: the header's primary is "+ New template" (the page title
  // already says Label Templates) and the modal commits with "Create template".
  const opened = await crawl.eval(`window.__ui.clickExact('+ New template')`);
  if (opened !== 'ok') { crawl.step('deep: open a label template', false, opened); return; }
  await crawl.waitFor(`window.__ui.fieldInput('Template name') !== null`, 8000, 'the new-template modal');
  await crawl.eval(`window.__ui.fieldSet('Template name', 'UI Crawl Label')`);
  await crawl.eval(`window.__ui.clickExact('Create template')`);
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

  /* ── v0.1.72: shift-click TOGGLES, and the element toggled off must not
   *      move (it used to stay selected and get dragged). ─────────────── */
  const beforeToggle = await crawl.eval(`({
    label: (document.querySelector('.ld-align__label') || {}).innerText || '',
    lefts: Array.from(document.querySelectorAll('.ld-el')).map((el) => el.style.left),
  })`);
  await crawl.eval(`window.__ui.clickElAt(0, true)`, true);
  await crawl.settle(300);
  const afterToggleOff = await crawl.eval(`({
    label: (document.querySelector('.ld-align__label') || {}).innerText || '',
    lefts: Array.from(document.querySelectorAll('.ld-el')).map((el) => el.style.left),
  })`);
  await crawl.eval(`window.__ui.clickElAt(0, true)`, true);
  await crawl.settle(300);
  const afterToggleOn = await crawl.eval(`(document.querySelector('.ld-align__label') || {}).innerText || ''`);
  crawl.step('deep: shift-click toggles a selected element off without moving it',
    /2 selected/.test(beforeToggle.label) && /1 selected/.test(afterToggleOff.label)
      && JSON.stringify(beforeToggle.lefts) === JSON.stringify(afterToggleOff.lefts)
      && /2 selected/.test(afterToggleOn),
    `“${beforeToggle.label}” → “${afterToggleOff.label}” → “${afterToggleOn}” · positions ${JSON.stringify(beforeToggle.lefts) === JSON.stringify(afterToggleOff.lefts) ? 'unchanged' : 'CHANGED'}`);

  /* ── v0.1.72: a rotated element is only reachable through its rotated
   *      bounds. Rotate one 45°, then marquee a tiny box at the corner of its
   *      AABB — empty space in the unrotated box, so the old raw-box hit test
   *      would miss it. ──────────────────────────────────────────────── */
  await crawl.eval(`(async () => {
    const canvas = document.querySelector('.ld-canvas');
    const r = canvas.getBoundingClientRect();
    await window.__ui.mouseDragPoint(canvas, r.right - 6, r.bottom - 6, r.right - 6, r.bottom - 6);
  })()`, true);
  await crawl.settle(250);
  await crawl.eval(`window.__ui.clickElAt(0, false)`, true);
  await crawl.settle(250);
  await crawl.eval(`window.__ui.fieldCommit('Rotation', '45')`);
  await crawl.settle(450);
  const rotated = await crawl.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const el = document.querySelectorAll('.ld-el')[0];
    const canvas = document.querySelector('.ld-canvas');
    if (!el || !canvas) return { error: 'no element or canvas' };
    const r = el.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const x0 = r.left + 1.5; const y0 = r.top + 1.5;
    const x1 = r.left + 6; const y1 = r.top + 6;
    const under = document.elementFromPoint(x0 + 1, y0 + 1);
    const fire = (node, type, cx, cy, buttons) => {
      const common = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons };
      node.dispatchEvent(new PointerEvent(type.replace('mouse', 'pointer'), Object.assign({}, common, { pointerId: 1, pointerType: 'mouse', isPrimary: true })));
      node.dispatchEvent(new MouseEvent(type, common));
    };
    fire(canvas, 'mousedown', cr.right - 4, cr.bottom - 4, 1);
    fire(window, 'mouseup', cr.right - 4, cr.bottom - 4, 0);
    await sleep(150);
    const cleared = (document.querySelector('.ld-align__label') || {}).innerText || '';
    fire(canvas, 'mousedown', x0, y0, 1);
    fire(window, 'mousemove', x1, y1, 1);
    fire(window, 'mouseup', x1, y1, 0);
    await sleep(300);
    return {
      under: under ? String(under.className || under.tagName) : null,
      cleared,
      label: (document.querySelector('.ld-align__label') || {}).innerText || '',
      rotation: el.style.transform || null,
    };
  })()`, true);
  crawl.step('deep: a rotated element is selectable through its rotated bounds',
    !!rotated && !rotated.error && typeof rotated.under === 'string' && !/ld-el/.test(rotated.under)
      && !/selected/.test(rotated.cleared || '') && /selected/.test(rotated.label || ''),
    JSON.stringify(rotated));

  /* ── v0.1.72: Space-drag pans the stage — and a pan is never a marquee and
   *      never moves the selection. Zoom in until the stage must scroll. ── */
  const pan = await crawl.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const plus = Array.from(document.querySelectorAll('.ld-bar__tools button')).find((b) => b.title === 'Zoom in');
    for (let i = 0; i < 20 && plus; i += 1) { plus.click(); await sleep(60); }
    await sleep(500);
    const stage = document.querySelector('.ld-stage');
    if (!stage) return { error: 'no stage' };
    stage.scrollLeft = 120; stage.scrollTop = 120;
    await sleep(80);
    const fire = (node, type, cx, cy, buttons) => {
      const common = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons };
      node.dispatchEvent(new PointerEvent(type.replace('mouse', 'pointer'), Object.assign({}, common, { pointerId: 1, pointerType: 'mouse', isPrimary: true })));
      node.dispatchEvent(new MouseEvent(type, common));
    };
    const sr = stage.getBoundingClientRect();
    const cx = sr.left + sr.width / 2; const cy = sr.top + sr.height / 2;
    const before = { x: stage.scrollLeft, y: stage.scrollTop, label: (document.querySelector('.ld-align__label') || {}).innerText || '' };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    await sleep(150);
    const ready = stage.classList.contains('is-pan-ready');
    const cursor = getComputedStyle(stage).cursor;
    fire(stage, 'mousedown', cx, cy, 1);
    fire(window, 'mousemove', cx - 45, cy - 35, 1);
    fire(window, 'mouseup', cx - 45, cy - 35, 0);
    await sleep(180);
    const after = {
      x: stage.scrollLeft, y: stage.scrollTop,
      marquee: !!document.querySelector('.ld-marquee'),
      label: (document.querySelector('.ld-align__label') || {}).innerText || '',
    };
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
    await sleep(150);
    const released = stage.classList.contains('is-pan-ready');
    return { ready, cursor, released, before, after };
  })()`, true);
  crawl.step('deep: Space-drag pans the stage without marqueeing or moving the selection',
    !!pan && !pan.error && pan.ready && !pan.released && pan.cursor === 'grab'
      && pan.before.label === pan.after.label && pan.after.marquee === false
      && pan.after.x === pan.before.x + 45 && pan.after.y === pan.before.y + 35,
    JSON.stringify(pan));
  // Back to Fit so the rest of the leg is measured at a stable zoom.
  await crawl.eval(`(() => {
    const b = Array.from(document.querySelectorAll('.ld-bar__tools button')).find((x) => (x.title || '').startsWith('Fit'));
    if (b) b.click();
    return 'ok';
  })()`);
  await crawl.settle(300);

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
  const item = await crawl.eval(`window.__ui.bulkMenuItem('Edit in table')`, true);
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
  const reopenedItem = await crawl.eval(`window.__ui.bulkMenuItem('Edit in table')`, true);
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

  /* ── v0.1.71: column selection, saved sets, and widths surviving a set ──
   * The picker is the shared ColumnsControl. Hide a column, prove it goes,
   * close + reopen the table and prove the choice stuck (localStorage), save a
   * named company-scoped set, switch between the built-in sets, then confirm a
   * resize still works. Reset back to Everything at the end so the rest of the
   * flow sees every column. */
  await crawl.eval(`(() => { try { localStorage.removeItem('BulkTable.columns'); } catch {} return 'ok'; })()`);
  const pickerOpen = await crawl.eval(`window.__ui.click('button', 'Columns ▾')`);
  await crawl.waitFor(`!!document.querySelector('.lib-columns__pop')`, 5000, 'the bulk Columns popover');
  const picker = await crawl.eval(`({
    rows: document.querySelectorAll('.lib-columns__pop .lib-columns__item').length,
    sets: Array.from(document.querySelectorAll('select[aria-label="Column set"] option')).map((o) => o.textContent),
    moveButtons: document.querySelectorAll('.lib-columns__move-btn').length,
    trigger: (Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').includes('Columns ▾')) || {}).innerText || null,
  })`);
  const hideVariant = await crawl.eval(`(() => {
    const box = document.querySelector('.lib-columns__item[data-col-key="variant"] input[type="checkbox"]');
    if (!box) return 'MISS variant checkbox';
    box.click();
    return 'ok';
  })()`);
  await crawl.settle(350);
  const hidden = await crawl.eval(`({
    header: !!document.querySelector('.bulk-table__grid thead th[title="Variant"]'),
    stored: localStorage.getItem('BulkTable.columns'),
  })`);
  await crawl.shot('bulk-table-columns-hidden');
  crawl.step('deep bulk table: Columns ▾ hides a column and remembers it',
    pickerOpen === 'ok' && hideVariant === 'ok'
      && picker.rows > 20 && picker.moveButtons > 0
      && ['Everything', 'Basics', 'Prices', 'Logistics'].every((s) => picker.sets.includes(s))
      && hidden.header === false
      && Array.isArray(JSON.parse(hidden.stored)) && !JSON.parse(hidden.stored).includes('variant'),
    `trigger “${picker.trigger}” · ${picker.rows} rows · ${picker.moveButtons} move arrows · sets ${JSON.stringify(picker.sets)} · stored ${hidden.stored}`);

  /* The choice must survive closing and reopening the table. */
  await crawl.eval(`window.__ui.pressEscape()`);
  await crawl.settle(200);
  await crawl.eval(`window.__ui.clickExact('Close')`);
  await crawl.waitFor(`!document.querySelector('.bulk-table__grid')`, 10_000, 'the table to close');
  await crawl.settle(350);
  await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.settle(300);
  const reopenedCols = await crawl.eval(`window.__ui.bulkMenuItem('Edit in table')`, true);
  await crawl.waitFor(`!!document.querySelector('.bulk-table__grid')`, 10_000, 'the table to reopen');
  await crawl.settle(450);
  const afterReopenCols = await crawl.eval(`({
    variant: !!document.querySelector('.bulk-table__grid thead th[title="Variant"]'),
    sku: !!document.querySelector('.bulk-table__grid thead th[title="SKU"]'),
  })`);
  crawl.step('deep bulk table: a hidden column stays hidden after close and reopen',
    reopenedCols === 'ok' && afterReopenCols.variant === false && afterReopenCols.sku === true,
    JSON.stringify(afterReopenCols));

  /* Save the current selection as a named, company-scoped set. */
  const setName = 'Crawl set ' + String(Date.now()).slice(-6);
  await crawl.eval(`window.__ui.click('button', 'Columns ▾')`);
  await crawl.waitFor(`!!document.querySelector('.lib-columns__pop')`, 5000, 'the popover for saving a set');
  const saveAs = await crawl.eval(`window.__ui.click('.bulk-columns__set-actions button', 'Save as set')`);
  await crawl.waitFor(`!!document.querySelector('input[aria-label="Set name"]')`, 4000, 'the set-name input');
  await crawl.eval(`window.__ui.set('input[aria-label="Set name"]', ${JSON.stringify(setName)})`);
  await crawl.eval(`window.__ui.click('.bulk-columns__set-form button', 'Save set')`);
  await crawl.waitFor(`window.__ui.toastText().includes(${JSON.stringify(setName)})`, 8000, 'the saved-set toast').catch(() => {});
  await crawl.settle(400);
  const savedSet = await crawl.eval(`(() => {
    const sel = document.querySelector('select[aria-label="Column set"]');
    return { options: sel ? Array.from(sel.options).map((o) => o.textContent) : [], value: sel ? sel.value : null };
  })()`);
  crawl.step('deep bulk table: a named set saves and becomes the active set',
    saveAs === 'ok' && savedSet.options.includes(setName) && savedSet.value && savedSet.value !== '__custom',
    `${setName} · active ${savedSet.value} · options ${JSON.stringify(savedSet.options)}`);

  /* Switch between sets: Basics narrows, Prices brings the money columns. */
  const readHeaders = () => crawl.eval(`Array.from(document.querySelectorAll('.bulk-table__grid thead th')).map((t) => t.getAttribute('title'))`);
  await crawl.eval(`window.__ui.set('select[aria-label="Column set"]', 'basics')`);
  await crawl.settle(400);
  const basicsHeaders = await readHeaders();
  await crawl.eval(`window.__ui.set('select[aria-label="Column set"]', 'prices')`);
  await crawl.settle(400);
  const pricesHeaders = await readHeaders();
  crawl.step('deep bulk table: switching built-in sets swaps the visible columns',
    basicsHeaders.includes('SKU') && basicsHeaders.includes('Name') && !basicsHeaders.includes('Description')
      && pricesHeaders.includes('Retail price') && pricesHeaders.includes('Wholesale price')
      && !pricesHeaders.includes('Description') && basicsHeaders.length !== pricesHeaders.length,
    `Basics ${JSON.stringify(basicsHeaders)} · Prices ${JSON.stringify(pricesHeaders)}`);

  /* Reset returns to Everything (and clears the localStorage selection). */
  await crawl.eval(`window.__ui.click('.lib-columns__head .lib-columns__reset', 'Reset')`);
  await crawl.settle(400);
  const afterColsReset = await crawl.eval(`({
    headers: Array.from(document.querySelectorAll('.bulk-table__grid thead th')).map((t) => t.getAttribute('title')),
    stored: localStorage.getItem('BulkTable.columns'),
    pop: !!document.querySelector('.lib-columns__pop'),
  })`);
  crawl.step('deep bulk table: the picker Reset restores Every column and drops the stored selection',
    afterColsReset.headers.includes('Variant') && afterColsReset.headers.includes('Image')
      && afterColsReset.headers.length > 20 && afterColsReset.stored === null && afterColsReset.pop === false,
    `${afterColsReset.headers.length} columns · stored ${afterColsReset.stored}`);

  /* Resize must still work after all that set switching. */
  await crawl.settle(200);
  const colsWidthBefore = await crawl.eval(`(() => { const c = document.querySelector('col[data-col="name"]'); return c ? parseFloat(c.style.width) : null; })()`);
  await crawl.eval(`window.__ui.mouseDrag('[data-col-resize="name"]', 90, 0)`, true);
  await crawl.settle(300);
  const colsWidthAfter = await crawl.eval(`(() => {
    const c = document.querySelector('col[data-col="name"]');
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem('BulkTable.columnWidths') || '{}').name ?? null; } catch {}
    return { col: c ? parseFloat(c.style.width) : null, stored };
  })()`);
  crawl.step('deep bulk table: resizing still works after switching sets',
    colsWidthBefore != null && colsWidthAfter.col >= colsWidthBefore + 70 && colsWidthAfter.stored === colsWidthAfter.col,
    `${colsWidthBefore} → ${colsWidthAfter.col}px · stored ${colsWidthAfter.stored}`);
  // Leave the widths at their defaults for the rest of the flow.
  await crawl.eval(`window.__ui.clickExact('Reset columns')`);
  await crawl.settle(250);

  /* ── v0.1.72: a width lives with the company, not just this Mac ─────────
   * Drag the Name column wider, let the debounced company-scoped DB write
   * land, then wipe the localStorage cache — what a second Mac sees on its
   * first open — close the table and reopen it. The width must come back from
   * the database, not from this Mac's cache. */
  await crawl.eval(`window.__ui.mouseDrag('[data-col-resize="name"]', 120, 0)`, true);
  await crawl.settle(900);
  const companyWidth = await crawl.eval(`(() => { const c = document.querySelector('col[data-col="name"]'); return c ? parseFloat(c.style.width) : null; })()`);
  await crawl.eval(`(() => { try { localStorage.removeItem('BulkTable.columnWidths'); } catch {} return 'ok'; })()`);
  await crawl.eval(`window.__ui.pressEscape()`);
  await crawl.settle(200);
  // Esc already closes the (clean) table through the shared Modal; Close is
  // only needed if it is still open.
  await crawl.eval(`document.querySelector('.bulk-table__grid') ? window.__ui.clickExact('Close') : 'already closed'`);
  await crawl.waitFor(`!document.querySelector('.bulk-table__grid')`, 10_000, 'the table to close for the width round-trip');
  await crawl.settle(350);
  await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.settle(300);
  const reopenedWidths = await crawl.eval(`window.__ui.bulkMenuItem('Edit in table')`, true);
  await crawl.waitFor(`!!document.querySelector('.bulk-table__grid')`, 10_000, 'the table to reopen for the width round-trip');
  await crawl.settle(800);
  const adoptedWidth = await crawl.eval(`(() => {
    const c = document.querySelector('col[data-col="name"]');
    return { col: c ? parseFloat(c.style.width) : null, cache: localStorage.getItem('BulkTable.columnWidths') };
  })()`);
  crawl.step('deep bulk table: a width stored for the company is adopted on a fresh client',
    reopenedWidths === 'ok' && companyWidth != null && adoptedWidth.col === companyWidth,
    `dragged ${companyWidth}px · cache wiped · reopened ${adoptedWidth.col}px · cache ${adoptedWidth.cache}`);

  /* ── v0.1.72: the saved set can be duplicated ────────────────────────── */
  await crawl.eval(`window.__ui.click('button', 'Columns ▾')`);
  await crawl.waitFor(`!!document.querySelector('.lib-columns__pop')`, 5000, 'the popover for duplicating a set');
  const activateSet = await crawl.eval(`(() => {
    const sel = document.querySelector('select[aria-label="Column set"]');
    if (!sel) return 'MISS set select';
    const opt = Array.from(sel.options).find((o) => o.textContent === ${JSON.stringify(setName)});
    if (!opt) return 'MISS saved set option';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await crawl.settle(400);
  const duplicateClicked = await crawl.eval(`window.__ui.click('.bulk-columns__set-actions button', 'Duplicate')`);
  await crawl.settle(600);
  const duplicated = await crawl.eval(`(() => {
    const sel = document.querySelector('select[aria-label="Column set"]');
    return sel ? Array.from(sel.options).map((o) => o.textContent) : [];
  })()`);
  crawl.step('deep bulk table: Duplicate makes a copy of the saved set',
    activateSet === 'ok' && duplicateClicked === 'ok' && duplicated.includes(`${setName} copy`),
    `${setName} · options ${JSON.stringify(duplicated)}`);

  // Back to every column and default widths for the rest of the flow. The
  // picker's Reset restores Every column AND closes the popover (the set
  // dropdown's own change may close it too, so never press Esc here — that
  // would reach the modal and close the whole table).
  await crawl.eval(`window.__ui.click('.lib-columns__head .lib-columns__reset', 'Reset')`);
  await crawl.settle(400);
  await crawl.eval(`window.__ui.clickExact('Reset columns')`);
  await crawl.settle(250);

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

  /* v0.1.69 fix: typing must survive keystroke by keystroke. The step above
   * sets the whole value in ONE synthetic event, which is exactly why the
   * "one character then focus lost" regression slipped through. Focus the
   * cell, then dispatch REAL char key events and check focus after each. */
  const perKey = await (async () => {
    const selector = 'input[data-row="0"][data-col="unit"]';
    await crawl.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      el.focus(); setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    const steps = [];
    const text = 'Typed';
    for (const ch of text) {
      await crawl.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
      await crawl.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await crawl.settle(80);
      const state = await crawl.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return { focused: document.activeElement === el, value: el ? el.value : null };
      })()`);
      steps.push(state);
    }
    return { text, steps };
  })();
  crawl.step('deep bulk table: every keystroke keeps focus and accumulates in the cell',
    perKey.steps.length === perKey.text.length
      && perKey.steps.every((s, i) => s.focused && s.value === perKey.text.slice(0, i + 1)),
    JSON.stringify({ text: perKey.text, got: perKey.steps.map((s) => (s.focused ? s.value : `LOST@${s.value}`)) }));

  /* The same, for a long-text cell that wraps: focus must survive AND the
   * row must grow as the value wraps onto more lines. */
  const wrapFocus = await (async () => {
    const selector = 'textarea[data-row="0"][data-col="tags"]';
    const shape = () => crawl.eval(`(() => {
      const ta = document.querySelector(${JSON.stringify(selector)});
      return {
        row: document.querySelector('tr[data-row="0"]').getBoundingClientRect().height,
        ta: ta ? ta.getBoundingClientRect().height : 0,
      };
    })()`);
    await crawl.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      el.focus(); setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    const before = await shape();
    // Long enough that the 190px tags column must wrap onto several lines.
    const text = 'wrap this tag list onto several lines so the cell grows tall and the row grows with it';
    const steps = [];
    for (const ch of text) {
      await crawl.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
      await crawl.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await crawl.settle(35);
      const state = await crawl.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return { focused: document.activeElement === el, value: el ? el.value : null };
      })()`);
      steps.push(state);
    }
    const after = await shape();
    return { before, after, text, steps };
  })();
  crawl.step('deep bulk table: a wrapping cell keeps focus while the row grows',
    wrapFocus.steps.every((s) => s.focused)
      && wrapFocus.steps[wrapFocus.steps.length - 1]?.value === wrapFocus.text
      && wrapFocus.after.row > wrapFocus.before.row
      && wrapFocus.after.ta > wrapFocus.before.ta,
    JSON.stringify({ before: wrapFocus.before, after: wrapFocus.after, last: wrapFocus.steps[wrapFocus.steps.length - 1] }));

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
 * chevron agree about the independent filter state (`ProductLibrary.filtersVisible`) and one map
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
  // UI pass 2026-10: the search box lives in the `.toolbar` row under the header.
  await crawl.eval(`window.__ui.set('.lib-toolbar input.search-input', 'a')`);
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
    toolbar: document.querySelector('.lib-filter-toggle') ? document.querySelector('.lib-filter-toggle').getAttribute('aria-label') : null,
    toolbarPressed: document.querySelector('.lib-filter-toggle') ? document.querySelector('.lib-filter-toggle').getAttribute('aria-pressed') : null,
    stored: localStorage.getItem('ProductLibrary.filtersVisible'),
  }))()`);
  const tableCollapsed = await mainWidth();
  await crawl.shot('listtools-filters-rail');
  crawl.step('list tools: the filter column retracts to a rail with a way back',
    rail.aside && rail.layout && rail.groups === 0 && rail.chevron && rail.stored === 'off'
      && /Show filters/.test(rail.toolbar || '') && rail.toolbarPressed === 'false',
    JSON.stringify({ ...rail, tableExpanded, tableCollapsed }));
  crawl.step('list tools: the grid gets the width back in Table view',
    tableCollapsed - tableExpanded > 100, `expanded ${tableExpanded}px → rail ${tableCollapsed}px`);

  await crawl.eval(`document.querySelector('.lib-filters__collapse').click()`);
  await crawl.settle(400);
  const reExpanded = await crawl.eval(`(() => ({
    aside: document.querySelector('.lib-filters').classList.contains('is-collapsed'),
    layout: document.querySelector('.lib-layout').classList.contains('lib-layout--filters-collapsed'),
    groups: document.querySelectorAll('.filter-group').length,
    stored: localStorage.getItem('ProductLibrary.filtersVisible'),
  }))()`);
  crawl.step('list tools: the column expands again',
    !reExpanded.aside && !reExpanded.layout && reExpanded.groups === 5 && reExpanded.stored === 'on',
    JSON.stringify(reExpanded));

  /* Grid view: same retract must return the width to the grid. */
  await crawl.eval(`window.__ui.click('.lib-toolbar .segments .segment', 'Grid')`);
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
  await crawl.eval(`window.__ui.click('.lib-toolbar .segments .segment', 'Table')`);
  await crawl.settle(300);
  await crawl.eval(`window.__ui.set('.lib-toolbar input.search-input', '')`);
  await crawl.settle(500);

  // Independent details controls must retain a hidden new-product draft and its DOM.
  await crawl.eval(`window.__ui.clickExact('+ New product')`);
  await crawl.waitFor(`window.__ui.fieldInput('Name') !== null`, 6000, 'new product draft');
  await crawl.eval(`window.__ui.fieldSet('Name', 'Crawl hidden draft')`);
  await crawl.eval(`window.__uxDraftPanel = document.querySelector('.lib-inspector .lib-panel'); document.querySelector('.lib-panel-toggle').click()`);
  await crawl.settle(200);
  await crawl.eval(`window.__ui.pressEscape()`);
  await crawl.eval(`document.querySelector('.lib-panel-toggle').click()`);
  await crawl.settle(200);
  const draftPanel = await crawl.eval(`({ name: window.__ui.fieldValue('Name'), same: window.__uxDraftPanel === document.querySelector('.lib-inspector .lib-panel'), filters: localStorage.getItem('ProductLibrary.filtersVisible'), details: localStorage.getItem('ProductLibrary.panelVisible') })`);
  crawl.step('list tools: Details preserves hidden draft and does not change Filters', draftPanel.name === 'Crawl hidden draft' && draftPanel.same && draftPanel.filters === 'on' && draftPanel.details === 'on', JSON.stringify(draftPanel));
  await crawl.eval(`window.__ui.pressEscape()`);
  await crawl.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await crawl.settle(200);
  // 2026-10 audit: the Details column only exists while a product is open, so
  // measure both states — nothing open (table takes the room, Details hidden)
  // and a product open (Details ≥320px beside a still-usable table).
  const measureLibrary = `(() => { const r = document.querySelector('.lib-layout').getBoundingClientRect(); const main = document.querySelector('.lib-main').getBoundingClientRect(); const details = document.querySelector('.lib-inspector').getBoundingClientRect(); return { width: innerWidth, right: Math.round(r.right), table: Math.round(main.width), details: Math.round(details.width) }; })()`;
  const narrowEmpty = await crawl.eval(measureLibrary);
  await crawl.shot('library-1100-none-open');
  await crawl.eval(`(() => { const row = document.querySelector('.lib-main tr.lib-row'); if (!row) return 'MISS row'; row.click(); return 'ok'; })()`);
  await crawl.waitFor(`document.querySelector('.lib-inspector') && !document.querySelector('.lib-inspector').hidden`, 6000, 'the Details column for an open product');
  await crawl.settle(300);
  const narrowOpen = await crawl.eval(measureLibrary);
  await crawl.shot('library-1100');
  const narrowLibrary = { empty: narrowEmpty, open: narrowOpen };
  crawl.step('list tools: Library panels fit a 1100px viewport with a scrollable table',
    narrowEmpty.right <= 1100 && narrowEmpty.details === 0 && narrowEmpty.table > 600
      && narrowOpen.right <= 1100 && narrowOpen.table > 150 && narrowOpen.details >= 320,
    JSON.stringify(narrowLibrary));
  await crawl.eval(`window.__ui.pressEscape()`);
  await crawl.settle(300);
  await crawl.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

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
  // UI pass 2026-10: list tools sit in the shared `.toolbar`; brand cards are
  // shared `.card`s, each still carrying its `.entity-card__check` box.
  const brandCards = `document.querySelectorAll('.card-grid .card .entity-card__check')`;
  await crawl.waitFor(`!!document.querySelector('.toolbar input.search-input')`, 8000, 'the Brands search box');
  await crawl.eval(`window.__ui.set('.toolbar input.search-input', ${JSON.stringify(stamp)})`);
  await crawl.waitFor(`${brandCards}.length === 2`, 8000, 'the two seeded brands');
  const brandCount = await crawl.eval(`${brandCards}.length`);
  crawl.step('list tools: the Brands search filters the list', brandCount === 2, `${brandCount} card(s) for "${stamp}"`);
  await crawl.shot('listtools-brands-search');

  // Name Z–A must float "Crawl Tool B" to the top.
  await crawl.eval(`window.__ui.set('.toolbar select.list-tools__sort', 'nameDesc')`);
  await crawl.settle(400);
  const firstTitle = await crawl.eval(`(document.querySelector('.card-grid .card .card__title') || {}).textContent || null`);
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
  const stillThere = await crawl.eval(`${brandCards}.length`);
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
  await crawl.waitFor(`!!document.querySelector('.toolbar input.search-input')`, 8000, 'the Categories toolbar');
  const catTools = await crawl.eval(`(() => {
    const chipEl = document.querySelector('.list-tools__unassigned');
    return {
      search: !!document.querySelector('.toolbar input.search-input'),
      sort: !!document.querySelector('.toolbar select.list-tools__sort'),
      check: !!document.querySelector('.categories-list__check, .toolbar .list-tools__all input[type="checkbox"]'),
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
  await crawl.waitFor(`!!document.querySelector('.toolbar input.search-input')`, 8000, 'the Suppliers search box');
  const supSort = await crawl.eval(`!!document.querySelector('.toolbar select.list-tools__sort')`);
  crawl.step('list tools: Suppliers has a sort select', supSort, `sort select present: ${supSort}`);
  await crawl.eval(`window.__ui.set('.toolbar input.search-input', ${JSON.stringify(supName)})`);
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

/**
 * v0.1.69 — the two customer-reported fixes.
 *
 * A. The "Image operations ▾" panel could not scroll and ran off the bottom of
 *    the window, so the last section was unreachable. We open it, scroll it to
 *    the bottom and assert the last item is actually inside the panel AND the
 *    panel inside the viewport.
 *
 * B. "Apply to which images" gained Specific positions. We apply position 2 to
 *    a product that has exactly one image and assert the toast reports the
 *    skip ("no 2nd image") instead of silently doing nothing.
 *
 * Non-fatal like its siblings: the caller wraps it in try/catch.
 */
async function deepOverlayPositionsFlow(crawl, photoPath) {
  crawl.phase = 'deep: overlay positions';

  /* A fresh product with exactly one image — the case the customer cares
   * about (ask for the 2nd photo; there is no 2nd photo). */
  const seeded = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    const stamp = String(Date.now()).slice(-6);
    const p = await window.api.products.create({ companyId: cid, sku: 'UI-POS-' + stamp, name: 'Position widget', status: 'active' });
    let imgs = await window.api.images.listByProduct(p.id);
    let list = imgs.images || imgs;
    if (list.length === 0) {
      await window.api.images.importForProduct(p.id, ${JSON.stringify(photoPath)});
      imgs = await window.api.images.listByProduct(p.id);
      list = imgs.images || imgs;
    }
    return { id: p.id, sku: p.sku, count: list.length };
  })()`, true).catch((err) => ({ error: err.message }));
  if (!seeded || seeded.error || seeded.count !== 1) {
    crawl.step('deep positions: one-image product exists', false, JSON.stringify(seeded));
    return;
  }
  crawl.step('deep positions: one-image product exists', true, `${seeded.sku} · ${seeded.count} image`);

  await crawl.goto('Product Library');
  await crawl.eval(`window.__ui.set('.lib-toolbar input.search-input', ${JSON.stringify(seeded.sku)})`);
  await crawl.waitFor(`window.__ui.textOf(document.body).includes(${JSON.stringify(seeded.sku)})`, 10_000, 'the one-image product row');
  await crawl.settle(400);
  const picked = await crawl.eval(`(() => {
    const boxes = Array.from(document.querySelectorAll('tbody input[type="checkbox"], .lib-grid input[type="checkbox"], .product-tile input[type="checkbox"]')).filter((b) => !b.closest('thead'));
    boxes.slice(0, 1).forEach((b) => { if (!b.checked) b.click(); });
    return boxes.length;
  })()`);
  await crawl.settle(400);

  /* ── A: submenus, bounds, scroll and the flattening search ───────────── */
  const menuOpened = await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.waitFor(`!!document.querySelector('.lib-bulk-menu__panel')`, 5_000, 'the image operations menu');
  await crawl.settle(300);
  const topLevel = await crawl.eval(`(() => {
    const panel = document.querySelector('.lib-bulk-menu__panel');
    if (!panel) return { error: 'no panel' };
    const triggers = Array.from(panel.querySelectorAll('.lib-bulk-menu__section-trigger'));
    const pr = panel.getBoundingClientRect();
    return {
      triggers: triggers.map((t) => t.innerText.replace(/\\s+/g, ' ').trim()),
      allHaspopup: triggers.every((t) => t.getAttribute('aria-haspopup') === 'menu'),
      itemCount: panel.querySelectorAll('.lib-bulk-menu__item').length,
      overflowY: getComputedStyle(panel).overflowY,
      panelInsideViewport: pr.top >= -1 && pr.bottom <= window.innerHeight + 1,
      searchShown: !!panel.querySelector('.lib-bulk-menu__search-input'),
    };
  })()`);
  // Open the last section's submenu, after scrolling the main panel to the
  // bottom so that trigger is the worst case for bounds.
  const submenu = await crawl.eval(`(async () => {
    const panel = document.querySelector('.lib-bulk-menu__panel');
    const triggers = Array.from(panel.querySelectorAll('.lib-bulk-menu__section-trigger'));
    const last = triggers[triggers.length - 1];
    last.scrollIntoView({ block: 'nearest' });
    await new Promise((r) => setTimeout(r, 60));
    last.click();
    await new Promise((r) => setTimeout(r, 300));
    const sub = document.querySelector('.lib-bulk-menu__submenu');
    if (!sub) return { error: 'no submenu' };
    const items = Array.from(sub.querySelectorAll('.lib-bulk-menu__item'));
    const lastItem = items[items.length - 1];
    if (!lastItem) return { error: 'no submenu items' };
    // Force the submenu to its bottom, then prove the last item is on screen
    // inside both the submenu and the window.
    const before = sub.scrollTop;
    sub.scrollTop = sub.scrollHeight;
    await new Promise((r) => setTimeout(r, 60));
    const sr = sub.getBoundingClientRect();
    const ir = lastItem.getBoundingClientRect();
    const scrollable = sub.scrollHeight > sub.clientHeight + 1;
    return {
      count: items.length,
      labels: items.map((i) => i.innerText.split('\\n')[0]),
      lastInside: ir.top >= sr.top - 1 && ir.bottom <= sr.bottom + 1,
      subInsideViewport: sr.top >= -1 && sr.bottom <= window.innerHeight + 1 && sr.left >= -1 && sr.right <= window.innerWidth + 1,
      subScrollable: scrollable,
      subScrolled: !scrollable || sub.scrollTop !== before,
    };
  })()`, true);
  await crawl.shot('overlay-menu-submenu');
  const menuOk = menuOpened === 'ok' && !topLevel.error && !submenu.error
    && topLevel.triggers.length >= 3 && topLevel.allHaspopup && topLevel.itemCount === 0
    && topLevel.overflowY === 'auto' && topLevel.panelInsideViewport && topLevel.searchShown
    && submenu.count > 0 && submenu.lastInside && submenu.subInsideViewport
    && (!submenu.subScrollable || submenu.subScrolled);
  crawl.step('deep positions: section submenus open and every item is reachable on screen',
    menuOk,
    menuOk ? `${topLevel.triggers.length} triggers · last submenu “${(submenu.labels || []).join(', ')}”`
      : JSON.stringify({ topLevel, submenu }));

  /* Search flattens the tree into one filtered list. */
  const flat = await crawl.eval(`(async () => {
    const panel = document.querySelector('.lib-bulk-menu__panel');
    const input = panel.querySelector('.lib-bulk-menu__search-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const type = async (v) => {
      input.focus();
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 220));
    };
    const read = () => ({
      triggers: panel.querySelectorAll('.lib-bulk-menu__section-trigger').length,
      items: Array.from(panel.querySelectorAll('.lib-bulk-menu__item')).map((i) => i.innerText.replace(/\\s+/g, ' ').trim()),
      metas: Array.from(panel.querySelectorAll('.lib-bulk-menu__flat-meta')).map((m) => m.innerText.trim()),
      submenus: document.querySelectorAll('.lib-bulk-menu__submenu').length,
    });
    await type('overlay');
    const first = read();
    await type('resize');
    const second = read();
    await type('');
    const cleared = read();
    return { first, second, cleared };
  })()`, true);
  const flatOk = flat.first.triggers === 0 && flat.first.items.length === 1 && /Apply overlay/i.test(flat.first.items[0])
    && flat.first.metas.length === 1 && flat.first.submenus === 0
    && flat.second.items.length === 1 && /Resize/i.test(flat.second.items[0])
    && flat.cleared.triggers >= 3 && flat.cleared.items.length === 0;
  crawl.step('deep positions: the menu search flattens the tree and narrows it', flatOk, JSON.stringify(flat));

  /* ── v0.1.72: the search field is always present, sits inside the arrow-key
   *      cycle, and Escape clears a query before it closes the menu. ────── */
  const keyCycle = await crawl.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const panel = document.querySelector('.lib-bulk-menu__panel');
    const input = panel && panel.querySelector('.lib-bulk-menu__search-input');
    if (!panel || !input) return { error: 'no search field' };
    const press = (key) => {
      const t = document.activeElement || document.body;
      t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    };
    const compact = Math.round(input.getBoundingClientRect().height);
    input.focus();
    await sleep(60);
    const start = document.activeElement === input;
    press('ArrowDown');
    await sleep(90);
    const afterDown = document.activeElement ? String(document.activeElement.className || document.activeElement.tagName) : null;
    press('ArrowUp');
    await sleep(90);
    const backToSearch = document.activeElement === input;
    // A typed query must put the flattened rows in the cycle.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'overlay');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(240);
    input.focus();
    press('ArrowDown');
    await sleep(90);
    const inFlat = document.activeElement ? String(document.activeElement.className || document.activeElement.tagName) : null;
    // Two-step Escape: clear the query, then close.
    input.focus();
    press('Escape');
    await sleep(240);
    const firstEsc = {
      open: !!document.querySelector('.lib-bulk-menu__panel'),
      value: (document.querySelector('.lib-bulk-menu__search-input') || {}).value ?? null,
    };
    press('Escape');
    await sleep(260);
    const secondEsc = {
      open: !!document.querySelector('.lib-bulk-menu__panel'),
      focus: (document.activeElement && (document.activeElement.innerText || '').trim().slice(0, 30)) || null,
    };
    return { compact, start, afterDown, backToSearch, inFlat, firstEsc, secondEsc };
  })()`, true);
  crawl.step('deep positions: the search field is in the arrow-key cycle and Escape clears it first',
    !!keyCycle && !keyCycle.error && keyCycle.compact <= 34 && keyCycle.start
      && /section-trigger/.test(keyCycle.afterDown || '') && keyCycle.backToSearch === true
      && /lib-bulk-menu__item/.test(keyCycle.inFlat || '')
      && keyCycle.firstEsc.open === true && keyCycle.firstEsc.value === ''
      && keyCycle.secondEsc.open === false,
    JSON.stringify(keyCycle));

  /* Esc closes the whole menu. */
  await crawl.eval(`window.__ui.pressEscape()`);
  await crawl.settle(250);
  const closedAfterEsc = await crawl.eval(`({ panel: !!document.querySelector('.lib-bulk-menu__panel'), submenu: !!document.querySelector('.lib-bulk-menu__submenu') })`);
  crawl.step('deep positions: Esc closes the whole menu',
    closedAfterEsc.panel === false && closedAfterEsc.submenu === false, JSON.stringify(closedAfterEsc));

  /* ── B: Specific positions 2 on a one-image product is a reported skip ── */
  const overlayOpened = await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.settle(300);
  const overlayItem = await crawl.eval(`(async () => {
    const trigger = Array.from(document.querySelectorAll('.lib-bulk-menu__section-trigger'))
      .find((t) => /Non-destructive/.test(t.innerText));
    if (!trigger) return 'MISS trigger';
    trigger.click();
    await new Promise((r) => setTimeout(r, 250));
    const item = Array.from(document.querySelectorAll('.lib-bulk-menu__submenu .lib-bulk-menu__item'))
      .find((i) => /Apply overlay/.test(i.innerText));
    if (!item) return 'MISS item';
    item.click();
    return 'ok';
  })()`, true);
  if (overlayOpened !== 'ok' || overlayItem !== 'ok' || picked === 0) {
    crawl.step('deep positions: open the apply-overlay dialog', false, `menu ${overlayOpened} · item ${overlayItem} · ${picked} row checkbox(es)`);
    return;
  }
  await crawl.waitFor(`window.__ui.fieldInput('Template') !== null`, 8_000, 'the apply-overlay dialog');
  await crawl.settle(300);
  const positioned = await crawl.eval(`(() => {
    const label = Array.from(document.querySelectorAll('.bulk-overlay-run__radio')).find((x) => /Specific positions/.test(x.innerText));
    if (!label) return 'MISS';
    const radio = label.querySelector('input[type="radio"]');
    if (!radio) return 'MISS radio';
    radio.click();
    return 'ok';
  })()`);
  await crawl.settle(200);
  const setPos = await crawl.eval(`window.__ui.set('input[aria-label="Specific positions"]', '2')`);
  await crawl.settle(200);
  const state = await crawl.eval(`(() => {
    const checked = document.querySelector('input[name="overlay-image-scope"]:checked');
    const input = document.querySelector('input[aria-label="Specific positions"]');
    const applyBtn = Array.from(document.querySelectorAll('.bulk-overlay-run__footer button')).find((b) => /Apply to/.test(b.innerText));
    return {
      radioOn: !!(checked && checked.closest('label') && /Specific positions/.test(checked.closest('label').innerText)),
      ticks: document.querySelectorAll('.image-scope__tick input').length,
      positionsText: input ? input.value : null,
      applyEnabled: !!(applyBtn && !applyBtn.disabled),
    };
  })()`);
  const applied = await crawl.eval(`window.__ui.click('.bulk-overlay-run__footer button', 'Apply to')`);
  await crawl.waitFor(`/skipped/i.test(window.__ui.toastText())`, 15_000, 'the skip-reporting toast').catch(() => {});
  const toast = await crawl.eval('window.__ui.toastText()');
  await crawl.shot('overlay-positions-skip');
  crawl.step('deep positions: position 2 on a one-image product reports the skip',
    positioned === 'ok' && setPos === 'ok' && applied === 'ok'
      && state.radioOn && state.positionsText === '2' && state.applyEnabled
      && /skipped/i.test(toast) && /no 2nd image/i.test(toast),
    `radio ${positioned} · set ${setPos} · apply ${applied} · ${JSON.stringify(state)} · toast: ${toast || '(none)'}`);

  /* Leave the Library as we found it. */
  await crawl.eval(`window.__ui.pressEscape()`).catch(() => {});
  await crawl.eval(`window.__ui.set('.lib-toolbar input.search-input', '')`).catch(() => {});
  await crawl.settle(250);
}

/**
 * v0.1.71 — the Overlay Studio editor must not warp the artwork.
 *
 * The customer had to switch the real preview off to place elements because a
 * photo whose aspect differed from its box looked stretched. The positions were
 * never the problem; the ARTWORK FITTING was. The renderer resizes a photo into
 * its box with sharp `fit: 'contain'`. This leg builds the deliberately
 * mismatched case — the crawl's 900×900 photo in a 3:1 image-element box —
 * renders it through the real renderer, opens it in the editor with
 * placeholders OFF (the real preview), and asserts the plain `<img>`s the
 * editor draws use the SAME rule (`object-fit: contain`), so the visible
 * artwork keeps the photo's aspect ratio in both. Screenshot for the eyeball.
 *
 * Non-fatal like its siblings: the caller wraps it in try/catch.
 */
async function deepOverlayFitFlow(crawl, photoPath) {
  crawl.phase = 'deep: overlay artwork fit';

  const seeded = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    const stamp = String(Date.now()).slice(-6);
    const p = await window.api.products.create({ companyId: cid, sku: 'UI-FIT-' + stamp, name: 'Fit widget', status: 'active' });
    let imgs = await window.api.images.listByProduct(p.id);
    let list = imgs.images || imgs;
    if (list.length === 0) {
      await window.api.images.importForProduct(p.id, ${JSON.stringify(photoPath)});
      imgs = await window.api.images.listByProduct(p.id);
      list = imgs.images || imgs;
    }
    // 0.75 × 0.25 of a 1200×1200 canvas = a 3:1 box holding a square photo.
    const tpl = await window.api.templates.create({
      name: 'UI Fit 3to1 ' + stamp,
      canvasWidth: 1200, canvasHeight: 1200,
      elements: [{
        id: 'fit-img', type: 'image', source: 'product-image:0',
        x: 0.5, y: 0.5, anchor: 'c', width: 0.75, height: 0.25, opacity: 1,
      }],
    });
    return { id: p.id, sku: p.sku, images: list.length, templateId: tpl.id, templateName: tpl.name };
  })()`, true).catch((err) => ({ error: err.message }));
  if (!seeded || seeded.error || !seeded.templateId) {
    crawl.step('deep overlay fit: a 3:1 template over the square photo exists', false, JSON.stringify(seeded));
    return;
  }
  crawl.step('deep overlay fit: a 3:1 template over the square photo exists', true,
    `${seeded.sku} · ${seeded.templateName} · ${seeded.images} image`);

  /* The renderer half: the real compose produces bytes for this pair. */
  const rendered = await crawl.eval(`(async () => {
    const res = await window.api.templates.renderPreview({ templateId: ${JSON.stringify(seeded.templateId)}, productId: ${JSON.stringify(seeded.id)}, maxPx: 400 });
    const bytes = res && res.bytes;
    let dims = null;
    if (bytes) {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      dims = { w: bmp.width, h: bmp.height };
      bmp.close();
    }
    return { hasBytes: !!bytes, dims };
  })()`, true).catch((err) => ({ error: err.message }));
  crawl.step('deep overlay fit: the real renderer composes the pair without throwing',
    !!rendered && !rendered.error && rendered.hasBytes && !!rendered.dims,
    JSON.stringify(rendered));

  await crawl.goto('Overlay Studio');
  await crawl.waitFor(`window.__ui.textOf(document.body).includes(${JSON.stringify(seeded.templateName)})`, 10_000, 'the fit template card');
  await crawl.settle(400);
  const openedTemplate = await crawl.eval(`(() => {
    // UI pass 2026-10: template cards are shared .card elements; Edit is the primary action.
    const card = Array.from(document.querySelectorAll('.card')).find((c) => (c.querySelector('.card__title') || {}).textContent === ${JSON.stringify(seeded.templateName)});
    const edit = card && Array.from(card.querySelectorAll('.card__actions button')).find((b) => b.textContent.trim() === 'Edit');
    if (!edit) return 'MISS';
    edit.click();
    return 'ok';
  })()`);
  if (openedTemplate !== 'ok') { crawl.step('deep overlay fit: open the fit template in the editor', false, openedTemplate); return; }
  await crawl.waitFor(`!!document.querySelector('.ovl-canvas')`, 15_000, 'the overlay editor');
  await crawl.settle(600);

  /* Pick the square-ish product as the backdrop; placeholders stay OFF (the
   * real preview is the default) so the editor draws its plain <img>s. */
  // 2026-10 audit: "Preview against" is a searchable ProductCombobox now (a
  // native <select> of ~2,500 products cannot be searched) — open it, search
  // the SKU, pick the row, and confirm the trigger shows the pick.
  const picked = await crawl.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sku = ${JSON.stringify(seeded.sku)};
    const trigger = document.querySelector('.ovl-editor__backdrop-picker .product-combobox__trigger');
    if (!trigger) return 'MISS backdrop combobox';
    trigger.click();
    await sleep(150);
    const search = document.querySelector('.ovl-editor__backdrop-picker .product-combobox__search');
    if (!search) return 'MISS combobox search';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(search, sku);
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    const row = Array.from(document.querySelectorAll('.ovl-editor__backdrop-picker .product-combobox__row'))
      .find((r) => (r.querySelector('.product-combobox__sku') || {}).textContent === sku);
    if (!row) return 'MISS row ' + sku;
    row.click();
    await sleep(150);
    const label = (document.querySelector('.ovl-editor__backdrop-picker .product-combobox__label') || {}).textContent || '';
    return label.startsWith(sku) ? 'ok' : 'trigger shows ' + label;
  })()`, true);
  await crawl.settle(1600);
  const fit = await crawl.eval(`(() => {
    const read = (el) => el ? {
      fit: getComputedStyle(el).objectFit,
      dataFit: el.getAttribute('data-fit'),
      natural: el.naturalWidth + 'x' + el.naturalHeight,
      box: Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height),
    } : null;
    return {
      backdrop: read(document.querySelector('.ovl-canvas__backdrop')),
      element: read(document.querySelector('.ovl-element__image img')),
      placeholders: !!document.querySelector('.ovl-canvas--placeholders'),
    };
  })()`);
  await crawl.shot('overlay-fit-mismatch');
  const boxParts = fit.element ? fit.element.box.split('x').map(Number) : [0, 0];
  const boxAspect = boxParts[1] ? boxParts[0] / boxParts[1] : 0;
  crawl.step('deep overlay fit: a square photo in a 3:1 box stays contained in the editor',
    openedTemplate === 'ok' && picked === 'ok'
      && fit.placeholders === false
      && !!fit.backdrop && fit.backdrop.fit === 'contain' && fit.backdrop.dataFit === 'contain'
      && !!fit.element && fit.element.fit === 'contain' && fit.element.dataFit === 'contain'
      && fit.element.natural === '900x900' && boxAspect > 2.5,
    `picked ${picked} · placeholders ${fit.placeholders} · backdrop ${JSON.stringify(fit.backdrop)} · element ${JSON.stringify(fit.element)} · box aspect ${boxAspect.toFixed(2)}`);

  /* v0.1.72: the truthful preview is the server-composed PNG at the canvas
   * aspect. It used `object-fit: cover`, which silently crops the moment that
   * aspect drifts (rounding, a render-size change) — the "skewed" class of bug
   * the customer reported. It must contain, exactly like the letterboxed
   * backdrop beside it. */
  let truthful;
  try {
    await crawl.waitFor(`!!document.querySelector('.ovl-canvas__truthful')`, 10_000, 'the truthful preview layer');
    truthful = await crawl.eval(`(() => {
      const el = document.querySelector('.ovl-canvas__truthful');
      return el ? {
        fit: getComputedStyle(el).objectFit,
        box: Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height),
      } : null;
    })()`);
  } catch { truthful = null; }
  crawl.step('deep overlay fit: the truthful preview contains the composed PNG (never crops)',
    !!truthful && truthful.fit === 'contain', JSON.stringify(truthful));

  /* Leave Overlay Studio. */
  await crawl.eval(`window.__ui.pressEscape()`).catch(() => {});
  await crawl.settle(250);
}

/**
 * v0.1.70 — the "which images" control on a DESTRUCTIVE image operation.
 *
 * v0.1.69 proved Specific positions on Apply overlay (non-destructive, adds a
 * new image). This leg drives the same choice through Compress, which rewrites
 * the source bytes and therefore exercises the shared rule on the op the
 * customer is most likely to fire on a big selection. It seeds a product with
 * exactly ONE image, asks Compress for position 2, and asserts:
 *
 *   - the modal's own positions warning appears,
 *   - the field accepts "2" and the run button is enabled,
 *   - the run is a reported SKIP ("1 product skipped: no 2nd image"), not a
 *     failure and not a silent no-op.
 *
 * Static coverage for the other five lives in test/imageScopeAllWiring.test.js.
 * Non-fatal like its siblings: the caller wraps it in try/catch.
 */
async function deepImageScopeFlow(crawl, photoPath) {
  crawl.phase = 'deep: image scope all ops';

  /* A fresh product with exactly one image (ask for the 2nd; it has none). */
  const seeded = await crawl.eval(`(async () => {
    const cid = await window.api.companies.getActiveId();
    const stamp = String(Date.now()).slice(-6);
    const p = await window.api.products.create({ companyId: cid, sku: 'UI-SCOPE-' + stamp, name: 'Image scope widget', status: 'active' });
    let imgs = await window.api.images.listByProduct(p.id);
    let list = imgs.images || imgs;
    if (list.length === 0) {
      await window.api.images.importForProduct(p.id, ${JSON.stringify(photoPath)});
      imgs = await window.api.images.listByProduct(p.id);
      list = imgs.images || imgs;
    }
    return { id: p.id, sku: p.sku, count: list.length };
  })()`, true).catch((err) => ({ error: err.message }));
  if (!seeded || seeded.error || seeded.count !== 1) {
    crawl.step('deep scope: one-image product exists', false, JSON.stringify(seeded));
    return;
  }
  crawl.step('deep scope: one-image product exists', true, `${seeded.sku} · ${seeded.count} image`);

  await crawl.goto('Product Library');
  await crawl.eval(`window.__ui.set('.lib-toolbar input.search-input', ${JSON.stringify(seeded.sku)})`);
  await crawl.waitFor(`window.__ui.textOf(document.body).includes(${JSON.stringify(seeded.sku)})`, 10_000, 'the one-image product row');
  await crawl.settle(400);
  const picked = await crawl.eval(`(() => {
    const boxes = Array.from(document.querySelectorAll('tbody input[type="checkbox"], .lib-grid input[type="checkbox"], .product-tile input[type="checkbox"]')).filter((b) => !b.closest('thead'));
    boxes.slice(0, 1).forEach((b) => { if (!b.checked) b.click(); });
    return boxes.length;
  })()`);
  await crawl.settle(400);

  const openedMenu = await crawl.eval(`window.__ui.click('button', 'Image operations')`);
  await crawl.settle(300);
  const openedItem = picked > 0
    ? await crawl.eval(`window.__ui.bulkMenuItem('Compress')`, true)
    : 'MISS selection';
  await crawl.waitFor(`!!document.querySelector('input[name="compress-image-scope"]')`, 8_000, 'the Compress dialog')
    .catch(() => {});
  await crawl.settle(300);

  const positioned = await crawl.eval(`(() => {
    const radio = document.querySelector('input[name="compress-image-scope"][type="radio"]:not(:checked)');
    const labels = Array.from(document.querySelectorAll('.bulk-overlay-run__radio'));
    const target = labels.find((l) => /Specific positions/.test(l.innerText));
    if (!target) return 'MISS label';
    const input = target.querySelector('input[type="radio"]');
    if (!input) return 'MISS radio';
    input.click();
    return 'ok';
  })()`);
  await crawl.settle(250);
  const setPos = await crawl.eval(`window.__ui.set('input[aria-label="Specific positions"]', '2')`);
  await crawl.settle(250);

  const state = await crawl.eval(`(() => {
    const checked = document.querySelector('input[name="compress-image-scope"]:checked');
    const input = document.querySelector('input[aria-label="Specific positions"]');
    const box = document.querySelector('.image-scope__positions');
    const hint = box ? box.querySelector('.field__hint') : null;
    const runBtn = Array.from(document.querySelectorAll('.modal button')).find((b) => /^Compress /.test(b.innerText));
    return {
      radioOn: !!(checked && /Specific positions/.test(checked.closest('label').innerText)),
      ticks: document.querySelectorAll('.image-scope__tick input').length,
      positionsText: input ? input.value : null,
      warning: hint ? hint.innerText : null,
      runEnabled: !!(runBtn && !runBtn.disabled),
    };
  })()`);

  /* The modal's own warning must update to the skip contract. */
  const warningOk = /skipped and reported/i.test(state.warning || '');
  await crawl.shot('image-scope-compress');

  const ran = await crawl.eval(`window.__ui.click('.modal button', 'Compress ')`);
  await crawl.waitFor(`/skipped/i.test(window.__ui.toastText())`, 15_000, 'the skip-reporting toast').catch(() => {});
  const toast = await crawl.eval('window.__ui.toastText()');
  await crawl.shot('image-scope-compress-skip');

  crawl.step('deep scope: Compress position 2 on a one-image product reports the skip',
    openedMenu === 'ok' && openedItem === 'ok' && positioned === 'ok' && setPos === 'ok'
      && state.radioOn && state.positionsText === '2' && state.ticks >= 2
      && warningOk && state.runEnabled && ran === 'ok'
      && /skipped/i.test(toast) && /no 2nd image/i.test(toast),
    `menu ${openedMenu} · item ${openedItem} · radio ${positioned} · set ${setPos} · run ${ran} · ${JSON.stringify(state)} · toast: ${toast || '(none)'}`);

  await crawl.eval(`window.__ui.pressEscape()`).catch(() => {});
  await crawl.eval(`window.__ui.set('.lib-toolbar input.search-input', '')`).catch(() => {});
  await crawl.settle(250);
}

/**
 * v0.1.69 — cross-modal proof for the shared Modal focus fix.
 *
 * The bulk-table leg proves the SYMPTOM. This one proves the shared CAUSE is
 * gone: open a DIFFERENT modal with an inline onClose and type a multi-char
 * string with real per-key events, asserting focus survives every key. It
 * fails if anyone re-introduces an `[open, onClose]`-keyed focus effect in
 * renderer/components/ui.jsx, because the New-company form lives inside that
 * same shared Modal.
 */
async function deepModalFocusFlow(crawl) {
  crawl.phase = 'deep: modal focus';
  await crawl.goto('Company');
  await crawl.settle(400);
  const opened = await crawl.eval(`window.__ui.click('button', '+ New company')`);
  if (opened !== 'ok') { crawl.step('deep modal focus: open a second dialog', false, opened); return; }
  await crawl.waitFor(`window.__ui.modalCount() > 0`, 5_000, 'the New company modal');
  await crawl.settle(250);

  const selector = 'input[placeholder="e.g. ABC Imports"]';
  await crawl.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'MISS';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    el.focus(); setter.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  const text = 'Focused';
  const steps = [];
  for (const ch of text) {
    await crawl.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
    await crawl.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await crawl.settle(70);
    const state = await crawl.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return { focused: document.activeElement === el, value: el ? el.value : null };
    })()`);
    steps.push(state);
  }
  const focusedAfter = await crawl.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return { focused: document.activeElement === el, value: el ? el.value : null };
  })()`);
  await crawl.shot('modal-focus-company');
  // Close without creating a second company.
  await crawl.eval(`window.__ui.pressEscape()`).catch(() => {});
  await crawl.settle(200);
  const closed = await crawl.eval(`window.__ui.modalCount() === 0`);

  crawl.step('deep modal focus: a different dialog keeps the caret on every keystroke',
    steps.length === text.length
      && steps.every((s) => s.focused)
      && focusedAfter.value === text
      && closed === true,
    JSON.stringify({ focusedAfter, steps: steps.map((s) => (s.focused ? s.value : `LOST@${s.value}`)) }));
}

/**
 * Fixed Assets (A1 + A2) on the crawl's own empty company: the empty
 * register, "+ New asset" → a draft → Activate with its preview of what posts
 * → the register's totals row → Dispose with the live gain / loss preview →
 * the Depreciation page and "Check the books" → Tax year (the estimate notice)
 * → every report. Settings → Assets / Branches are covered by the tab leg.
 */
async function deepAssetsFlow(crawl) {
  crawl.phase = 'deep: assets';
  await crawl.goto('Register', 'assets');
  const empty = await crawl.eval(`window.__ui.textOf(document.querySelector('.empty__title'))`);
  crawl.step('deep assets: an empty register says so, with one action', /No assets yet/.test(empty), empty);
  const opened = await crawl.eval(`window.__ui.clickExact('+ New asset')`);
  if (opened !== 'ok') { crawl.step('deep assets: + New asset opens', false, opened); return; }
  await crawl.waitFor(`window.__ui.fieldInput('Category') !== null && !!document.querySelector('.modal .assets-kinds')`, 8000, 'the new-asset modal');
  const catId = await crawl.eval(`(Array.from(window.__ui.fieldInput('Category').options).find((o) => /Computers/.test(o.text)) || {}).value || ''`);
  const day = new Date().toISOString().slice(0, 10); // UTC is never ahead of Phnom Penh
  await crawl.eval(`window.__ui.fieldSet('Category', ${JSON.stringify(catId)})`);
  await crawl.eval(`window.__ui.fieldSet('Name', 'UI Crawl laptop')`);
  await crawl.eval(`window.__ui.fieldSet('Cost', '950')`);
  await crawl.eval(`window.__ui.fieldSet('Bought on', ${JSON.stringify(day)})`);
  await crawl.eval(`window.__ui.fieldSet('In use since', ${JSON.stringify(day)})`);
  await crawl.settle(200);
  const explain = await crawl.eval(`window.__ui.textOf(document.querySelector('.modal .assets-choice__explain'))`);
  crawl.step('deep assets: "Depreciate this item" explains the threshold', /\$950\.00, which is \$300\.00 or more/.test(explain), explain);
  await crawl.shot('assets-new');
  await crawl.eval(`window.__ui.clickExact('Save draft')`);
  await crawl.waitFor(`window.__ui.modalCount() === 0 && !!document.querySelector('.assets-tabs')`, 10_000, 'the draft page');
  await crawl.eval(`window.__ui.clickExact('Activate…')`);
  await crawl.waitFor(`!!document.querySelector('.modal .assets-entry')`, 10_000, 'the activation preview');
  const preview = await crawl.eval(`window.__ui.textOf(document.querySelector('.modal .assets-entry'))`);
  crawl.step('deep assets: activation previews a balanced entry', /Cost/.test(preview) && /Clearing/.test(preview) && /\$950\.00\s+\$950\.00/.test(preview.replace(/\s+/g, ' ')), preview.replace(/\s+/g, ' ').slice(0, 160));
  await crawl.shot('assets-activate');
  await crawl.eval(`window.__ui.clickExact('Activate and post')`);
  await crawl.waitFor(`window.__ui.modalCount() === 0 && !!document.querySelector('.assets-stats')`, 10_000, 'activated');
  await crawl.settle(300);
  const stats = await crawl.eval(`window.__ui.textOf(document.querySelector('.assets-stats'))`);
  crawl.step('deep assets: activated — on the books at cost', /\$950\.00/.test(stats), stats.replace(/\s+/g, ' ').slice(0, 120));
  for (const tab of ['Photos & documents', 'Schedule', 'History', 'Journal', 'Details']) {
    await crawl.eval(`window.__ui.click('.assets-tabs button', ${JSON.stringify(tab)})`);
    await crawl.settle(450);
    const crash = await crawl.eval('window.__ui.crash()');
    if (crash) crawl.step(`deep assets: tab ${tab}`, false, `CRASHED: ${crash}`);
  }
  await crawl.shot('assets-asset-page');
  // Dispose of it with the live preview.
  await crawl.eval(`window.__ui.clickExact('Actions')`);
  await crawl.settle(150);
  await crawl.eval(`window.__ui.click('.assets-menu button', 'Dispose…')`);
  await crawl.waitFor(`!!document.querySelector('.modal .assets-preview')`, 6000, 'the dispose dialog');
  await crawl.eval(`window.__ui.fieldSet('Sold for', '900')`);
  await crawl.waitFor(`/Loss|Gain/.test(window.__ui.textOf(document.querySelector('.modal .assets-preview')))`, 8000, 'the disposal preview');
  const disp = await crawl.eval(`window.__ui.textOf(document.querySelector('.modal .assets-preview'))`);
  crawl.step('deep assets: disposal previews the loss', /Loss\s*\$50\.00/.test(disp.replace(/\s+/g, ' ')), disp.replace(/\s+/g, ' ').slice(0, 160));
  await crawl.shot('assets-dispose');
  await crawl.eval(`window.__ui.clickExact('Dispose of it')`);
  await crawl.waitFor(`window.__ui.modalCount() === 0`, 8000, 'disposed');
  await crawl.settle(400);
  const badge = await crawl.eval(`window.__ui.textOf(document.querySelector('.assets-head-badges'))`);
  crawl.step('deep assets: disposed', /Disposed/.test(badge), badge);
  // The register's totals row covers every matching asset.
  await crawl.eval(`window.__ui.click('.page__back')`);
  await crawl.waitFor(`!!document.querySelector('.assets-register')`, 8000, 'the register');
  const totals = await crawl.eval(`window.__ui.textOf(document.querySelector('.assets-totals'))`);
  crawl.step('deep assets: the register has a totals row', /Totals/.test(totals) && /1 asset/.test(totals), totals.replace(/\s+/g, ' ').slice(0, 120));
  // Depreciation, the books check, Tax year and the reports.
  await crawl.goto('Depreciation', 'assets');
  await crawl.eval(`window.__ui.clickExact('Check the books')`);
  await crawl.waitFor(`/check out|do not check out/.test(window.__ui.textOf(document.body))`, 8000, 'the books check');
  const books = await crawl.eval(`/The books check out/.test(window.__ui.textOf(document.body))`);
  crawl.step('deep assets: the books check out', books === true);
  await crawl.shot('assets-depreciation');
  await crawl.goto('Tax year', 'assets');
  const est = await crawl.eval(`window.__ui.textOf(document.querySelector('.assets-notice'))`);
  crawl.step('deep assets: the tax view says it is an estimate', /Estimate — confirm with an accountant/.test(est), est.slice(0, 80));
  await crawl.goto('Reports', 'assets');
  const pills = await crawl.eval(`window.__ui.all('.assets-report-pick__item').map(window.__ui.textOf)`);
  let bad = [];
  for (const pill of pills || []) {
    await crawl.eval(`window.__ui.click('.assets-report-pick__item', ${JSON.stringify(pill)})`);
    await crawl.settle(500);
    const crash = await crawl.eval('window.__ui.crash()');
    if (crash) bad.push(`${pill}: ${crash}`);
  }
  crawl.step('deep assets: all eight reports render', (pills || []).length === 8 && !bad.length, bad.join('; ') || `${(pills || []).length} reports`);
  await crawl.shot('assets-reports');
}

/* [page id, sidebar label, module] — the module is the Home tile that holds
 * the page (renderer/lib/modules.js). test/launcher.test.js checks this list
 * against the registry, so a moved or renamed page fails there first. */
const PAGE_LABELS = [
  ['company', 'Company', 'products'],
  ['dashboard', 'Dashboard', 'products'],
  ['brands', 'Brands', 'products'],
  ['library', 'Product Library', 'products'],
  ['workspace', 'Image Workspace', 'media'],
  ['aistudio', 'AI Studio', 'media'],
  ['overlay', 'Overlay Studio', 'media'],
  ['export', 'Export Center', 'media'],
  ['socialgrid', 'Social Grid', 'media'],
  ['labeltemplates', 'Label Templates', 'labels'],
  ['labelgenerate', 'Generate & Print', 'labels'],
  ['barcodes', 'Barcode Maker', 'labels'],
  ['labeljobs', 'Label History', 'labels'],
  ['catalogtemplates', 'Catalog Templates', 'labels'],
  ['catalogprojects', 'Catalog Projects', 'labels'],
  ['suppliers', 'Suppliers', 'purchasing'],
  ['purchaseorders', 'Purchase Orders', 'purchasing'],
  ['costcalc', 'Cost Calculator', 'purchasing'],
  // Fuel F1 + the thin staff list.
  ['fueloverview', 'Overview', 'fuel'],
  ['fuelassets', 'Vehicles & machines', 'fuel'],
  ['fuelfills', 'Fill-ups', 'fuel'],
  ['fueltanks', 'Tanks & dips', 'fuel'],
  ['fuelprices', 'Prices', 'fuel'],
  ['fuelreports', 'Reports', 'fuel'],
  // Fixed Assets A1 + A2.
  ['assetregister', 'Register', 'assets'],
  ['assetdepreciation', 'Depreciation', 'assets'],
  ['assettax', 'Tax year', 'assets'],
  ['assetreports', 'Reports', 'assets'],
  ['staff', 'Staff', 'people'],
  ['history', 'History', 'system'],
];
/* Labels are unique except across modules; the deep flows name pages by
 * label, so the first module listed for a label wins. Settings is pinned in
 * every sidebar, so it needs no module. */
const MODULE_OF_LABEL = Object.fromEntries([...PAGE_LABELS].reverse().map(([, label, mod]) => [label, mod]));

/**
 * The Home grid and the module sidebar (2026-10-08): tiles render, a tile
 * opens its module, the Home item returns, arrow keys + Enter open a tile,
 * ⌘K "Go to" switches the sidebar to another module, ⌘⇧H comes home, and the
 * grid fits 1280 × 800 without scrolling. Screenshots at 1280 × 800 and
 * 1920 × 1080 of Home and two modules.
 */
async function launcherFlow(crawl) {
  crawl.phase = 'launcher';
  await crawl.goHome();
  const tiles = await crawl.eval(`window.__ui.all('.home-tile').map((t) => t.dataset.module)`);
  const title = await crawl.eval(`window.__ui.textOf(document.querySelector('.page__title'))`);
  crawl.step('launcher: Home renders module tiles', title === 'Home' && Array.isArray(tiles) && tiles.length >= 6
    && ['products', 'media', 'fuel', 'system'].every((m) => tiles.includes(m)), `${title} · ${JSON.stringify(tiles)}`);
  const chip = await crawl.eval(`window.__ui.textOf(document.querySelector('.page__header .context-chip'))`);
  crawl.step('launcher: Home shows the company chip', !!chip, chip || '(none)');

  await crawl.eval(`document.querySelector('.home-tile[data-module="fuel"]').click()`);
  await crawl.waitFor(`!document.querySelector('.page-fallback') && !!document.querySelector('.page__header') && !document.querySelector('.home-tile')`, 15_000, 'the Fuel page');
  const fuelSide = await crawl.sidebarModule();
  const fuelItems = await crawl.eval(`window.__ui.all('.sidebar__nav:not(.sidebar__nav--pinned) .sidebar__item').map((el) => window.__ui.textOf(el.querySelector('span:not(.sidebar__item-shortcut)')))`);
  crawl.step('launcher: a tile opens its module', fuelSide === 'fuel' && fuelItems.includes('Fill-ups') && !fuelItems.includes('Product Library'),
    `sidebar ${fuelSide}: ${JSON.stringify(fuelItems)}`);
  const settingsPinned = await crawl.eval(`window.__ui.all('.sidebar__nav--pinned .sidebar__item').map(window.__ui.textOf).some((t) => t.startsWith('Settings'))`);
  crawl.step('launcher: Settings is reachable inside a module', settingsPinned);

  await crawl.goHome();
  const back = await crawl.eval(`document.querySelectorAll('.home-tile').length > 0 && (document.querySelector('.sidebar__nav [data-module]:not(.sidebar__item)') === null)`);
  crawl.step('launcher: the Home item returns to the grid', back);

  // Keyboard: focus the first tile, → moves to the second, Enter opens it.
  await crawl.eval(`document.querySelector('.home-tile[tabindex="0"]')?.focus()`);
  const first = await crawl.eval(`document.activeElement?.dataset?.module || ''`);
  await crawl.key('ArrowRight', { keyCode: 39 });
  await crawl.settle(150);
  const second = await crawl.eval(`document.activeElement?.dataset?.module || ''`);
  await crawl.key('Enter', { keyCode: 13, text: '\r' });
  await crawl.waitFor(`!document.querySelector('.home-tile')`, 10_000, 'Enter to open a tile');
  await crawl.settle(300);
  const opened = await crawl.sidebarModule();
  crawl.step('launcher: arrow keys move between tiles, Enter opens one', first && second && first !== second && opened === second,
    `${first} → ${second}, opened ${opened}`);

  // ⌘K "Go to Purchasing" from inside another module switches the sidebar.
  await crawl.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`);
  await crawl.waitFor(`!!document.querySelector('.palette__input')`, 4000, 'the search palette');
  await crawl.eval(`window.__ui.set('.palette__input', 'purchas')`);
  await crawl.waitFor(`window.__ui.all('.palette__row').some((r) => window.__ui.textOf(r).includes('Go to Purchasing'))`, 4000, '"Go to Purchasing"');
  await crawl.shot('launcher-palette-goto');
  await crawl.eval(`document.querySelector('.palette__input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await crawl.waitFor(`!document.querySelector('.palette__input')`, 6000, 'the palette to close');
  await crawl.settle(400);
  const viaPalette = await crawl.sidebarModule();
  crawl.step('launcher: ⌘K "Go to" switches the sidebar to that module', viaPalette === 'purchasing', `sidebar ${viaPalette}`);

  // ⌘⇧H from anywhere.
  await crawl.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', metaKey: true, shiftKey: true, bubbles: true }))`);
  await crawl.waitFor(`document.querySelectorAll('.home-tile').length > 0`, 6000, '⌘⇧H to Home');
  crawl.step('launcher: ⌘⇧H goes Home', true);

  // Sizes the owner uses: Home must fit 1280 × 800 without scrolling.
  for (const [w, h] of [[1280, 800], [1920, 1080]]) {
    await crawl.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await crawl.goHome();
    await crawl.settle(400);
    const fit = await crawl.eval(`(() => { const p = document.querySelector('.page--home'); const g = document.querySelector('.home-grid').getBoundingClientRect(); return { scroll: p.scrollHeight - p.clientHeight, bottom: Math.round(g.bottom), cols: getComputedStyle(document.querySelector('.home-grid')).gridTemplateColumns.split(' ').length, tile: Math.round(document.querySelector('.home-tile').getBoundingClientRect().width) }; })()`);
    crawl.step(`launcher: Home fits ${w}×${h} without scrolling`, fit && fit.scroll <= 1 && fit.bottom <= h, JSON.stringify(fit));
    await crawl.shot(`launcher-home-${w}x${h}`);
    for (const [mod, label] of [['fuel', 'Fill-ups'], ['media', 'Overlay Studio']]) {
      await crawl.goto(label, mod);
      await crawl.shot(`launcher-${mod}-${w}x${h}`);
    }
  }
  await crawl.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await crawl.goHome();
}

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

  /* 1b ── first run (no company yet): Home welcomes and offers one action */
  crawl.phase = 'first run';
  try {
    const companyCount = await crawl.eval(`(async () => (await window.api.companies.list()).length)()`, true);
    if (companyCount > 0) {
      crawl.step('first run: Home welcome', true, `skipped — this profile already has ${companyCount} company(ies); use a fresh profile`);
    } else {
      await crawl.goHome();
      const first = await crawl.eval(`(() => {
        const intro = document.querySelector('.home-intro');
        const fuel = document.querySelector('.home-tile[data-module="fuel"]');
        return {
          title: window.__ui.textOf(intro?.querySelector('.empty__title') || intro),
          primaries: intro ? intro.querySelectorAll('.btn--primary').length : 0,
          action: window.__ui.textOf(intro?.querySelector('.btn--primary')),
          aboveGrid: !!intro && !!(intro.compareDocumentPosition(document.querySelector('.home-grid')) & Node.DOCUMENT_POSITION_FOLLOWING),
          fuelLocked: fuel?.getAttribute('aria-disabled') === 'true',
          fuelText: window.__ui.textOf(fuel?.querySelector('.home-tile__desc')),
        };
      })()`);
      await crawl.shot('first-run-home');
      crawl.step('first run: Home welcomes with one action above the grid',
        /Welcome to Media Studio KH/.test(first.title) && first.primaries === 1 && /Create your first company/.test(first.action) && first.aboveGrid,
        JSON.stringify(first));
      crawl.step('first run: locked tiles say "Create a company first"', first.fuelLocked && first.fuelText === 'Create a company first.', first.fuelText);
      await crawl.eval(`document.querySelector('.home-intro .btn--primary').click()`);
      await crawl.waitFor(`!document.querySelector('.home-tile') && !!document.querySelector('.page__header')`, 10_000, 'the Company page');
      const landed = await crawl.eval(`window.__ui.textOf(document.querySelector('.page__title'))`);
      crawl.step('first run: the action opens the Company page', landed === 'Company', landed);
    }
  } catch (err) {
    crawl.step('first run', false, `crawl error: ${err.message}`);
  }

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

  /* 2b ── the Home grid + module sidebar (2026-10-08) */
  try {
    await launcherFlow(crawl);
  } catch (err) {
    crawl.step('launcher flow', false, `crawl error: ${err.message}`);
  }

  /* 3 ── every page, each reached through its module */
  for (const [id, label, moduleId] of PAGE_LABELS) {
    try {
      await crawl.checkPage(id, label, moduleId);
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
    await deepAssetsFlow(crawl);
  } catch (err) {
    crawl.step('deep assets', false, `crawl error: ${err.message}`);
  }
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

  /* 15 ── the scrollable Image operations menu + Specific positions (v0.1.69) */
  try {
    await deepOverlayPositionsFlow(crawl, photoPath);
  } catch (err) {
    crawl.step('deep overlay positions flow', false, `crawl error: ${err.message}`);
  }

  /* 16 ── the shared Modal focus fix, in a second dialog (v0.1.69) */
  try {
    await deepModalFocusFlow(crawl);
  } catch (err) {
    crawl.step('deep modal focus flow', false, `crawl error: ${err.message}`);
  }

  /* 17 ── the image-scope control on a destructive op — Compress (v0.1.70) */
  try {
    await deepImageScopeFlow(crawl, photoPath);
  } catch (err) {
    crawl.step('deep image scope flow', false, `crawl error: ${err.message}`);
  }

  /* 18 ── the editor's artwork fit — a square photo in a 3:1 box (v0.1.71) */
  try {
    await deepOverlayFitFlow(crawl, photoPath);
  } catch (err) {
    crawl.step('deep overlay fit flow', false, `crawl error: ${err.message}`);
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
