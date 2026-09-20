/**
 * v0.1.14: every registered channel must be accounted for.
 *
 * Why this exists. An audit found 108 of 177 channels with no argument
 * validation — the client-mode server validated, but the standalone app (the
 * normal way this is used) did not validate at all. Bad input went straight to
 * SQLite and came back as things like "datatype mismatch", which tells the user
 * nothing. Nothing measured this, so nothing stopped it getting worse.
 *
 * The rule this enforces: a channel is either
 *   - in VALIDATORS, or
 *   - in EXEMPT with a written reason.
 * A new channel that is neither fails this test, so the gap cannot silently
 * reopen. This is a coverage ledger, not a correctness proof — it does not check
 * that a validator is a GOOD validator, only that one was considered.
 *
 * v0.1.17 — the reason this file was rewritten. The v0.1.14 version scanned
 * `expose(...)` calls ONLY, and reported "every channel covered" while **57
 * channels were registered with a bare `ipcMain.handle`** and got no validation
 * at all, 42 of them called by the screens. The coverage number was honest about
 * what it measured and misleading about what it implied.
 *
 * So the ledger now counts every registration style:
 *   - `expose('…')`       local + RPC, validated   (main/ipc/**)
 *   - `exposeLocal('…')`  local only, validated    (main/ipc/**)
 *   - a bare `ipcMain.handle('…')` is now a FAILURE in main/ipc/**, not an
 *     invisible omission, so the pattern cannot come back.
 *
 * `main/client/index.js` is the one deliberate exception: in client mode the
 * same local-only channel names are re-registered so the dialog or file read
 * happens on the CLIENT's Mac. Those are not independent channels — they are
 * the client-side half of channels the server already declares — so the rule
 * there is that every name must already be a known local-only channel or a
 * `client:*` channel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getValidator, EXEMPT } = require('../main/server/validators');

const ROOT = path.join(__dirname, '..');

function walkJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Comments are stripped before scanning. `main/client/index.js` documents the
 * naming convention with a literal `expose('domain:action', handler)` example,
 * and scanning prose would report that placeholder as a real channel.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Channels declared with `expose('…')` or `exposeLocal('…')`. */
function declaredChannels() {
  const found = new Set();
  for (const file of walkJs(path.join(ROOT, 'main'))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/\bexpose(?:Local)?\(\s*'([^']+)'/g)) found.add(m[1]);
  }
  return [...found].sort();
}

/** Bare `ipcMain.handle('literal', …)` registrations, per file. */
function bareHandleChannels() {
  const found = new Map();
  for (const file of walkJs(path.join(ROOT, 'main'))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
      if (!found.has(m[1])) found.set(m[1], path.relative(ROOT, file));
    }
  }
  return found;
}

const ALL_CHANNELS = declaredChannels();

/**
 * Channels `main/client/index.js` handles itself.
 *
 * Two shapes, both of which must be accounted for:
 *   - `handleLocal('chan', …)` — the client-side half of a local-only channel
 *     (v0.1.18; before that they were bare `ipcMain.handle` calls, so a scan
 *     for `ipcMain.handle` used to find them and now would not — hence this
 *     function, so the ledger keeps seeing them).
 *   - the `NOT_YET_PORTABLE` stubs, which always throw "not available in
 *     client mode". They can't run anything, but they are still registered
 *     channels and belong in the ledger.
 */
function clientLocalChannels() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'main', 'client', 'index.js'), 'utf8'));
  const found = new Set();
  for (const m of src.matchAll(/handleLocal\(\s*'([^']+)'/g)) found.add(m[1]);
  const list = src.match(/NOT_YET_PORTABLE\s*=\s*\[([\s\S]*?)\]/);
  if (list) for (const m of list[1].matchAll(/'([^']+)'/g)) found.add(m[1]);
  return [...found].sort();
}

test('validator coverage — every declared channel is validated or exempt', () => {
  const unaccounted = ALL_CHANNELS.filter((ch) => !getValidator(ch) && !(ch in EXEMPT));
  assert.deepEqual(
    unaccounted,
    [],
    `These channels are neither validated nor exempt:\n  ${unaccounted.join('\n  ')}\n\n` +
    'Add a validator in main/server/validators.js, or add an EXEMPT entry with a reason.',
  );
});

test('validator coverage — client-mode local channels are validated or exempt', () => {
  // These register on the CLIENT, so nothing on the server path covers them.
  // They must be in the same ledger, or client mode keeps the hole the
  // standalone path just had closed.
  const local = clientLocalChannels();
  assert.ok(
    local.length >= 35,
    `expected 35+ client-mode local channels, saw ${local.length} — did handleLocal( stop matching?`,
  );
  const unaccounted = local.filter((ch) => !getValidator(ch) && !(ch in EXEMPT));
  assert.deepEqual(
    unaccounted,
    [],
    `Client-mode local channels with no validator or exemption:\n  ${unaccounted.join('\n  ')}`,
  );
});

test('validator coverage — the ledger actually sees both registration styles', () => {
  // Guards the guard. If either pattern stops matching, the test above would
  // pass while checking nothing — which is exactly the v0.1.14 failure.
  const src = walkJs(path.join(ROOT, 'main', 'ipc'))
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(/expose\(\s*'/.test(src), 'no expose( calls found in main/ipc');
  assert.ok(/exposeLocal\(\s*'/.test(src), 'no exposeLocal( calls found in main/ipc');
  assert.ok(
    ALL_CHANNELS.length > 200,
    `expected 200+ declared channels, saw ${ALL_CHANNELS.length}`,
  );
  // Both styles must be represented in the ledger, not just one.
  const localOnly = new Set();
  for (const file of walkJs(path.join(ROOT, 'main', 'ipc'))) {
    const s = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of s.matchAll(/exposeLocal\(\s*'([^']+)'/g)) localOnly.add(m[1]);
  }
  assert.ok(localOnly.size > 40, `expected 40+ local-only channels, saw ${localOnly.size}`);
});

test('validator coverage — no bare ipcMain.handle with a channel name anywhere', () => {
  // The regression this whole rewrite is about: a bare handle is local-only AND
  // unvalidated, and nothing noticed for 57 channels.
  //
  //   main/ipc/**    → expose() (local + RPC) or exposeLocal() (local only)
  //   main/client/** → handleLocal()
  //
  // All three validate. Anywhere else that needs a local channel should get the
  // same treatment rather than a bare handle. Variable-based registrations
  // (the proxy loop, the not-yet-portable stubs, the helpers themselves) are
  // not matched and are fine.
  const offenders = [...bareHandleChannels()].map(([ch, file]) => `${ch}  (${file})`);
  assert.deepEqual(
    offenders,
    [],
    'Use expose() / exposeLocal() from main/ipc/helpers.js — or handleLocal() in\n'
    + 'main/client/index.js — instead of a bare ipcMain.handle. A bare handle\n'
    + 'skips validation entirely:\n  ' + offenders.join('\n  '),
  );
});

test('validator coverage — client-mode local handlers mirror known channels', () => {
  // main/client/index.js re-registers the local-only channels so they act on the
  // client's Mac. That is legitimate, but it must not invent channels: a name it
  // registers has to be either the client's own (client:*) or one the server
  // also declares. Otherwise a client-only channel could exist with no validator
  // anywhere and no ledger entry.
  //
  // Scans `handleLocal('…')` AND any bare `ipcMain.handle('…')`, so this cannot
  // pass by matching nothing — which is what happened when the client switched
  // from the latter to the former and the scan was not updated with it.
  const known = new Set(ALL_CHANNELS);
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'main', 'client', 'index.js'), 'utf8'));
  const registered = [
    ...[...src.matchAll(/handleLocal\(\s*'([^']+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]),
  ];
  assert.ok(
    registered.length >= 35,
    `expected 35+ registrations to inspect, found ${registered.length} — did the scan stop matching?`,
  );

  const orphans = registered.filter((ch) => !ch.startsWith('client:') && !known.has(ch));
  assert.deepEqual(
    orphans,
    [],
    'These client-mode handlers register a channel the server never declares,\n'
    + 'so nothing validates them:\n  ' + orphans.join('\n  '),
  );
});

test('validator coverage — exempt entries state a real reason', () => {
  const vague = Object.entries(EXEMPT)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 8)
    .map(([ch]) => ch);
  assert.deepEqual(vague, [], `Exempt channels need a written reason: ${vague.join(', ')}`);
});

test('validator coverage — no channel is both validated and exempt', () => {
  // Listing a channel in both places means one of the two is dead, and which one
  // wins is not obvious to the next reader.
  const both = Object.keys(EXEMPT).filter((ch) => getValidator(ch));
  assert.deepEqual(both, [], `Both validated AND exempt (pick one): ${both.join(', ')}`);
});

test('validator coverage — a validator returns true or a string, never throws', () => {
  // The contract the dispatchers rely on. A validator that throws turns a bad
  // request into a 500 instead of a readable rejection.
  const probes = [undefined, null, 0, '', 'x', [], {}, { id: 1 }, true];
  const checked = [];
  for (const ch of ALL_CHANNELS) {
    const v = getValidator(ch);
    if (!v) continue;
    checked.push(ch);
    for (const probe of probes) {
      let result;
      assert.doesNotThrow(() => { result = v(probe); }, `${ch} threw on ${JSON.stringify(probe)}`);
      assert.ok(
        result === true || typeof result === 'string',
        `${ch} returned ${typeof result} for ${JSON.stringify(probe)}; expected true or a string`,
      );
    }
  }
  // Sanity: the test actually looked at something.
  assert.ok(checked.length > 200, `expected many validators to check, saw ${checked.length}`);
});
