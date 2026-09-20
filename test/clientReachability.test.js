/**
 * v0.1.19: can the renderer actually REACH every channel it calls, in both modes?
 *
 * WHY THIS FILE WAS REWRITTEN. The first version mapped a renderer call
 * `window.api.<domain>.<method>` to the channel `<domain>:<method>`. That is
 * true for most channels and FALSE for a whole family of them, because
 * main/preload.js renames on the way through:
 *
 *     window.api.purchaseOrders.list(...)   ->  invoke('pos:list', …)
 *     window.api.catalogStudio.remove(...)  ->  invoke('catalogStudio:delete', …)
 *     window.api.ai.promoteGallery(...)     ->  invoke('ai:promoteGalleryToProduct', …)
 *
 * So it reported 23 client-mode gaps, 18 of them "the entire Purchase Orders
 * area is broken on a client Mac". All 18 were false: every `pos:*` channel is
 * proxied, and Purchase Orders works fine on a client. The ledger was measuring
 * method names and calling the result channels.
 *
 * The lesson is the same one that keeps recurring in this codebase: a check
 * built on an ASSUMPTION about a name reports loud nonsense. So the mapping is
 * now READ FROM THE PRELOAD, which is the only place it exists, and a guard
 * fails if any renderer call cannot be resolved through it — the exact
 * condition that used to pass silently.
 *
 * Two channels are genuinely absent from client mode, and both belong to one
 * tool the UI deliberately hides there. Those are declared in MODE_GATED with
 * the gating code that justifies them, and the test fails if that gating ever
 * disappears — so the exemption cannot outlive its reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'main', 'preload.js');
const CLIENT = path.join(ROOT, 'main', 'client', 'index.js');

/**
 * Channels the UI deliberately does not offer in client mode.
 *
 * EMPTY, and that is the point: there are no longer any. The two entries this
 * list held — `templates:applyToExternal` and `files:scanImageFiles`, both from
 * Overlay Studio's "Watermark external photos" tool — are now implemented on the
 * client (main/client/index.js), with the template's logo fetched from the
 * server, and the UI no longer hides the tool.
 *
 * The mechanism is kept because deliberate mode-gating is a legitimate design
 * choice for future features. An entry must name the gating code that hides the
 * feature, and the test below fails if that gating disappears — so an exemption
 * can never outlive its reason.
 */
const MODE_GATED = [];

/** Channels that are broken on a client Mac. Empty, and it must stay empty. */
const KNOWN_CLIENT_GAPS = [];

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * `<domain>.<method>` -> `{ channel, kind }`, read from main/preload.js.
 *
 * preload.js is written in a regular two-level shape — `domain: {` at one
 * indent, `method: …` at the next — so a line-oriented scan is reliable here,
 * and each method's statement is accumulated until the next sibling so that
 * multi-line wrappers are captured whole.
 *
 *   kind 'invoke'     — a request the renderer makes
 *   kind 'on'         — a push subscription (main → renderer)
 *   kind 'fire'       — ipcRenderer.send (no reply, e.g. the OS drag-out)
 */
function preloadChannelMap() {
  const lines = stripComments(fs.readFileSync(PRELOAD, 'utf8')).split('\n');
  const map = new Map();
  let domain = null;
  let method = null;
  let buf = '';

  const flush = () => {
    if (!method || !domain) { method = null; buf = ''; return; }
    const patterns = [
      [/invoke\(\s*'([^']+)'/, 'invoke'],
      [/ipcRenderer\.on\(\s*'([^']+)'/, 'on'],
      [/ipcRenderer\.send\(\s*'([^']+)'/, 'fire'],
    ];
    for (const [re, kind] of patterns) {
      const m = re.exec(buf);
      if (m) { map.set(`${domain}.${method}`, { channel: m[1], kind }); break; }
    }
    method = null;
    buf = '';
  };

  for (const line of lines) {
    const d = /^ {2}([A-Za-z_]\w*):\s*\{\s*$/.exec(line);
    if (d) { flush(); domain = d[1]; continue; }
    const m = /^ {4}([A-Za-z_]\w*):/.exec(line);
    if (m) { flush(); method = m[1]; buf = line; continue; }
    if (method) buf += `\n${line}`;
  }
  flush();
  return map;
}

/** Channels client mode can serve: proxied, stubbed, or handled locally. */
function clientServedChannels() {
  const src = stripComments(fs.readFileSync(CLIENT, 'utf8'));
  const list = (name) => {
    const block = src.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    return block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  };
  return new Set([
    ...list('PROXIED_CHANNELS'),
    ...list('NOT_YET_PORTABLE'),
    ...list('NOT_PORTABLE'),
    ...list('CLIENT_ONLY_STUBS'),
    ...[...src.matchAll(/handleLocal\(\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/ipcMain\.on\(\s*'([^']+)'/g)].map((m) => m[1]),
  ]);
}

/** Every `window.api.<domain>.<method>(…)` the renderer calls. */
function rendererCalls() {
  const found = new Map();
  for (const file of walkFiles(path.join(ROOT, 'renderer'))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/api\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g)) {
      const key = `${m[1]}.${m[2]}`;
      if (!found.has(key)) found.set(key, path.relative(ROOT, file));
    }
  }
  return found;
}

test('client reachability — every renderer call resolves to a real channel', () => {
  // Guards the guard, and guards against the exact bug that produced the false
  // report: a renderer call whose channel cannot be resolved means this file is
  // guessing again, and every conclusion below is worthless.
  const map = preloadChannelMap();
  assert.ok(map.size > 200, `expected 200+ preload methods, mapped ${map.size}`);

  const unresolved = [...rendererCalls()]
    .filter(([key]) => !map.has(key))
    .map(([key, file]) => `${key}  (called from ${file})`);

  assert.deepEqual(
    unresolved,
    [],
    'The renderer calls these api methods but main/preload.js declares no such\n'
    + 'method, so their channel cannot be determined:\n  ' + unresolved.join('\n  '),
  );
});

test('client reachability — the mapping is read from the preload, not assumed', () => {
  // Pins the three renames that broke the first version of this file. If the
  // mapping ever goes back to `<domain>:<method>`, these fail immediately.
  const map = preloadChannelMap();
  assert.equal(map.get('purchaseOrders.list')?.channel, 'pos:list');
  assert.equal(map.get('catalogStudio.remove')?.channel, 'catalogStudio:delete');
  assert.equal(map.get('ai.promoteGallery')?.channel, 'ai:promoteGalleryToProduct');
  assert.equal(map.get('images.startDragOut')?.kind, 'fire');
  assert.equal(map.get('ai.onTaskUpdate')?.kind, 'on');
});

test('client reachability — the served lists are read in full, not truncated', () => {
  // Pins the channels involved in the false alarm, so a truncating extraction
  // (the first ad-hoc analysis stopped at a `]` inside a comment) cannot make
  // this file report gaps that do not exist.
  const served = clientServedChannels();
  for (const ch of ['pos:list', 'pos:create', 'templates:get', 'catalogStudio:delete', 'ai:promoteGalleryToProduct']) {
    assert.ok(served.has(ch), `client served list is missing ${ch} — extraction truncated?`);
  }
  assert.ok(served.size > 220, `expected 220+ served channels, saw ${served.size}`);
});

test('client reachability — every channel the renderer invokes is served', () => {
  const map = preloadChannelMap();
  const served = clientServedChannels();
  const gated = new Set(MODE_GATED.map((g) => g.channel));
  const known = new Set(KNOWN_CLIENT_GAPS);

  const unreachable = [];
  for (const [key, file] of rendererCalls()) {
    const entry = map.get(key);
    if (!entry || entry.kind !== 'invoke') continue;   // subscriptions are not requests
    if (served.has(entry.channel) || gated.has(entry.channel) || known.has(entry.channel)) continue;
    unreachable.push(`${entry.channel}  (via api.${key}, called from ${file})`);
  }

  assert.ok(served.size > 200, `expected the client to serve 200+ channels, saw ${served.size}`);
  assert.deepEqual(
    unreachable,
    [],
    'These channels are invoked by the UI but client mode neither proxies them,\n'
    + 'handles them locally, nor stubs them — so on a client Mac they fail with\n'
    + "Electron's bare \"No handler registered\":\n  " + unreachable.join('\n  '),
  );
});

test('client reachability — every mode-gated exemption still has its gate', () => {
  // An exemption must not outlive the thing that justifies it. If the UI stops
  // hiding the feature, this fails and the channel has to be made to work.
  const broken = [];
  for (const entry of MODE_GATED) {
    const abs = path.join(ROOT, entry.gate.file);
    if (!fs.existsSync(abs)) { broken.push(`${entry.channel}: gate file missing (${entry.gate.file})`); continue; }
    const src = fs.readFileSync(abs, 'utf8');
    if (!src.includes(entry.gate.mustContain)) {
      broken.push(`${entry.channel}: ${entry.gate.file} no longer contains ${JSON.stringify(entry.gate.mustContain)}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    'A channel is exempted from client mode because the UI hides its feature, but\n'
    + 'the gating that hides it is gone — so make the channel work in client mode:\n  '
    + broken.join('\n  '),
  );
});

test('client reachability — the broken-feature list is empty', () => {
  // This list held 23 entries once, all but two of them false. Anything real
  // belongs in MODE_GATED (deliberate, with a gate) — not here.
  assert.deepEqual(
    KNOWN_CLIENT_GAPS,
    [],
    `These are genuinely broken on a client Mac and must be fixed: ${KNOWN_CLIENT_GAPS.join(', ')}`,
  );
});
