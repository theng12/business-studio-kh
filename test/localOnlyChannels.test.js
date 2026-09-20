/**
 * v0.1.27 — local-machine channels must not be reachable over RPC.
 *
 * AGENTS.md §15 draws the line: `expose()` puts a channel in the server's RPC
 * registry so a remote client can call it; `exposeLocal()` does not. Anything
 * that acts on the Mac RUNNING the handler — opening a folder, printing to an
 * attached printer, writing into a caller-supplied absolute path, reading a
 * local file, opening a native dialog — must be `exposeLocal()`.
 *
 * Twelve channels were on the wrong side of that line. They had been registered
 * with `expose()`, so a client holding a token could drive them on the SERVER:
 *
 *   POST { channel: 'labels:print' }             → paper out of the server's printer
 *   POST { channel: 'labels:generate', outputFolder: '…' }
 *                                                → files written into a
 *                                                  server-side directory at a
 *                                                  path the client chose
 *   POST { channel: 'images:copyImagesToFolder' } → a native folder dialog opened
 *                                                  on the server, then files
 *                                                  copied there
 *
 * The shipped client never proxied any of them (each has its own `handleLocal`
 * implementation), so no user hit this — which is exactly why it survived. It
 * was latent ACL widening, and nothing in the suite guarded it.
 *
 * This test pins the specific channels, and also fails if one of them gains a
 * client-side proxy without being deliberately re-examined. A curated list is
 * the honest approach here: "does this handler touch the local machine" is not
 * something a regex can answer, so the list is the decision, and the test makes
 * changing that decision deliberate rather than accidental.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const IPC_DIR = path.join(ROOT, 'main', 'ipc');
const CLIENT = path.join(ROOT, 'main', 'client', 'index.js');

/** Channels that act on the machine running the handler. */
const MUST_BE_LOCAL = [
  'labels:saveBarcode',        // writes outputFolder
  'labels:importAsset',        // reads a local sourcePath
  'labels:listPrinters',       // this Mac's printers
  'labels:openOutput',         // opens a file in Finder
  'labels:generate',           // writes outputFolder (and can print)
  'labels:print',              // prints on this Mac's printer
  'catalogStudio:export',      // writes outputFolder
  'socialGrid:export',         // writes outputFolder
  'templates:applyToExternal', // reads inputPaths, writes outputFolder
  'images:copyImagesToFolder', // native dialog + writes on this Mac
  'images:prepareDrag',        // returns this Mac's absolute asset paths
  'exports:checkCollisions',   // fs.existsSync against a caller-supplied path
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** channel -> registration style, for every main/ipc module. */
function registrations() {
  const map = new Map();
  for (const file of fs.readdirSync(IPC_DIR)) {
    if (!file.endsWith('.js')) continue;
    const src = stripComments(fs.readFileSync(path.join(IPC_DIR, file), 'utf8'));
    for (const m of src.matchAll(/\b(expose|exposeLocal)\(\s*'([^']+)'/g)) {
      map.set(m[2], m[1]);
    }
  }
  return map;
}

function clientSideLocalChannels() {
  const src = stripComments(fs.readFileSync(CLIENT, 'utf8'));
  return new Set([...src.matchAll(/handleLocal\(\s*'([^']+)'/g)].map((m) => m[1]));
}

test('the scan found the registrations (guards the guard)', () => {
  const regs = registrations();
  assert.ok(regs.size > 200, `expected 200+ registered channels, parsed ${regs.size}`);
  assert.ok(regs.has('labels:print'), 'labels:print not parsed — the regex has drifted');
});

test('every local-machine channel is registered with exposeLocal, not expose', () => {
  const regs = registrations();
  const wrong = [];
  for (const channel of MUST_BE_LOCAL) {
    const style = regs.get(channel);
    if (style === undefined) { wrong.push(`${channel}  — NOT REGISTERED AT ALL`); continue; }
    if (style !== 'exposeLocal') wrong.push(`${channel}  — registered with ${style}()`);
  }
  assert.deepEqual(
    wrong,
    [],
    'These channels act on the Mac running the handler, so expose() puts them in\n'
    + 'the RPC registry and lets a remote client drive them on the WRONG computer.\n'
    + 'Use exposeLocal():\n  ' + wrong.join('\n  '),
  );
});

test('every local-machine channel still has a client-side implementation', () => {
  // The other half of the contract: making these local-only is only safe
  // because client mode implements each one itself. If that ever stops being
  // true, a client Mac loses the feature silently.
  const clientLocal = clientSideLocalChannels();
  const missing = MUST_BE_LOCAL.filter((c) => !clientLocal.has(c));
  assert.deepEqual(
    missing,
    [],
    'These are server-local now but client mode has no handleLocal for them, so a\n'
    + 'client Mac would fail with "No handler registered":\n  ' + missing.join('\n  '),
  );
});
