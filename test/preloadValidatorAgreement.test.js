/**
 * v0.1.14: the preload wrappers and the validators must agree on argument shape.
 *
 * Why this exists. Adding validation to the local IPC path immediately rejected
 * two working calls — `suppliers:list` and `labels:listTemplates` — because the
 * validators were written against an ASSUMPTION about the argument shape rather
 * than against what the preload actually sends. The shapes are not uniform:
 *
 *     brands.list(cid)        -> invoke('brands:list', cid)              (bare value)
 *     labels.listTemplates(c) -> invoke('labels:listTemplates', { companyId })
 *     suppliers.list(c, f)    -> invoke('suppliers:list', { companyId, filters })
 *
 * Guessing wrong turns validation into an outage that only shows up when the
 * user opens that particular screen, which is the worst possible failure mode
 * for a safety feature.
 *
 * What this asserts — deliberately narrow, to stay free of false positives:
 *   1. Every property NAME the preload constructs is one the validator knows
 *      about. A rename on either side fails here.
 *   2. The parser really did find the wrappers (guards the guard).
 *
 * It does NOT assert on value types. A synthetic value ("sample") will rightly
 * fail a `must be a number` rule, and that tells you nothing — the renderer
 * passes real numbers. Types were verified against the live app instead; see the
 * verification notes in the changelog for v0.1.14.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getValidator } = require('../main/server/validators');
const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'main', 'preload.js');

/**
 * channel -> { keys, bare }
 *   keys: property names the wrapper builds into the payload object
 *   bare: true when the wrapper forwards its parameter directly
 */
function preloadShapes() {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const shapes = new Map();
  const re = /\(([^)]*)\)\s*=>\s*(?:\{[\s\S]*?\})?\s*invoke\(\s*'([^']+)'\s*(?:,\s*([\s\S]*?))?\)/g;

  for (const m of src.matchAll(re)) {
    const params = m[1].split(',').map((s) => s.trim().split(/[=\s]/)[0].trim()).filter(Boolean);
    const channel = m[2];
    const tail = (m[3] || '').trim();

    if (!tail) { shapes.set(channel, { keys: [], bare: false }); continue; }
    if (tail.startsWith('{')) {
      const keys = [];
      for (const part of tail.replace(/^\{/, '').replace(/\}$/, '').split(',')) {
        const k = part.split(':')[0].trim().replace(/^\.\.\./, '');
        if (/^[A-Za-z_]\w*$/.test(k)) keys.push(k);
      }
      shapes.set(channel, { keys, bare: false });
    } else {
      const ident = tail.split(/[\s?|]+/)[0].trim();
      shapes.set(channel, { keys: params.includes(ident) ? [ident] : [], bare: true });
    }
  }
  return shapes;
}

/**
 * Does the validator know this property name at all?
 *
 * Probed by handing it an object where every key is absent. A validator that
 * recognises the names fails on "required" (a value problem); one that does not
 * recognise them fails on "unexpected"/"must be an object" (a shape problem).
 * We only care that it is not the latter.
 */
function validatorKnowsNames(validate, keys) {
  // Probe with `{}` rather than a string: an object satisfies both object-typed
  // and optional fields, so the only complaints left are about NAMES or genuine
  // semantics (a required nested field). A string would wrongly trip
  // "patch must be an object", which is a type statement, not a shape one.
  const args = Object.fromEntries(keys.map((k) => [k, {}]));
  const result = validate(args);
  if (result === true) return true;
  return !/unexpected|unknown/i.test(result);
}

test('preload ↔ validator — property names agree', () => {
  const shapes = preloadShapes();
  assert.ok(shapes.size > 60, `expected many wrappers, parsed ${shapes.size}`);

  const mismatches = [];
  for (const [channel, { keys, bare }] of shapes) {
    const validate = getValidator(channel);
    if (!validate) continue;            // exempt/uncovered — the coverage test owns that
    if (bare || keys.length === 0) continue; // nothing to compare by name

    // A validator may legitimately require a name the wrapper does not send only
    // if the wrapper's parameter is itself the whole payload; skip those.
    if (!validatorKnowsNames(validate, keys)) {
      mismatches.push(`${channel}  preload sends {${keys.join(', ')}}  validator says: ${validate(Object.fromEntries(keys.map((k) => [k, {}])))}`);
    }
  }
  assert.deepEqual(
    mismatches,
    [],
    'Validator and preload disagree about property names — this breaks a working\n' +
    'screen at runtime:\n  ' + mismatches.join('\n  '),
  );
});

test('preload ↔ validator — the parser found the deliberately-odd wrappers', () => {
  // Guards the guard: if the regex quietly stops matching, the test above would
  // pass while checking nothing.
  const shapes = preloadShapes();
  assert.ok(shapes.has('brands:list'), 'brands:list wrapper not parsed');
  assert.ok(shapes.has('labels:listTemplates'), 'labels:listTemplates wrapper not parsed');
  assert.ok(shapes.has('suppliers:list'), 'suppliers:list wrapper not parsed');
  assert.equal(shapes.get('brands:list').bare, true, 'brands:list forwards its value directly');
  assert.deepEqual(shapes.get('labels:listTemplates').keys, ['companyId']);
  assert.deepEqual(shapes.get('suppliers:list').keys.sort(), ['companyId', 'filters']);
});

/**
 * The name test above deliberately skips bare forwards ("nothing to compare by
 * name") — and that is exactly where the v0.1.14 `ai:listPrompts` outage hid.
 *
 *     main/preload.js   listPrompts: (companyId) => invoke('ai:listPrompts', companyId)
 *     validators.js     'ai:listPrompts': requireFields('companyId')
 *
 * Every layer was individually reasonable, the name test skipped the channel
 * because there were no names to compare, and 221 tests passed — while the AI
 * Studio screen threw `Bad request: expected an object argument` on open.
 *
 * A general "does this bare forward's type match the validator" check is NOT
 * possible from the source: `(companyId) => invoke(ch, companyId)` (a string)
 * and `(input) => invoke(ch, input)` (a whole payload object) are the same
 * shape to any parser. Probing a bare forward with scalars flags 27 channels,
 * 26 of which are false positives — every one of them is a `(payload)` wrapper
 * whose renderer call site passes an object literal.
 *
 * What IS sound is a naming rule the codebase already follows everywhere: a
 * preload parameter named `id`, `xId` or `xIds` is an identifier string, never
 * a payload object. All 44 such channels are checked below. `ai:listPrompts`
 * fails this the moment its validator goes back to demanding an object, which
 * is precisely the regression that shipped.
 */
const BARE_ID_NAME = /^(id|.*Ids?)$/;

test('preload ↔ validator — every bare id argument is accepted, and still type-checked', () => {
  const shapes = preloadShapes();
  const accepted = [];
  const rejectedAString = [];
  const uncheckedType = [];

  for (const [channel, { bare, keys }] of shapes) {
    if (!bare) continue;
    const ident = keys[0];
    if (!ident || !BARE_ID_NAME.test(ident)) continue;

    const validate = getValidator(channel);
    if (!validate) continue;              // exempt/uncovered — the coverage test owns that
    if (channel.startsWith('app:') || channel.startsWith('client:')) continue;

    if (validate('sample-id') !== true) accepted.push(`${channel} (${ident}) -> ${validate('sample-id')}`);
    if (validate(42) === true) rejectedAString.push(`${channel} (${ident}) accepts a number — validation is not doing its job`);
    uncheckedType.push(channel);
  }

  assert.ok(
    uncheckedType.length >= 40,
    `expected ~44 bare id wrappers, checked ${uncheckedType.length} — did the preload parse change?`,
  );
  assert.deepEqual(
    accepted,
    [],
    'These channels are called by the renderer with a bare id string, but the\n'
    + 'validator rejects a string — the screen that calls them is broken:\n  '
    + accepted.join('\n  '),
  );
  assert.deepEqual(rejectedAString, [], rejectedAString.join('\n'));
});

test('preload ↔ validator — a wrapper that sends no argument is accepted', () => {
  // Sound without any naming assumption: `() => invoke('x')` can only ever
  // deliver `undefined`, so a validator that rejects `undefined` makes the
  // channel impossible to call.
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const re = /\(([^)]*)\)\s*=>\s*(?:\{[\s\S]*?\})?\s*invoke\(\s*'([^']+)'\s*(?:,\s*([\s\S]*?))?\)/g;

  const failures = [];
  let checked = 0;
  for (const m of src.matchAll(re)) {
    if (m[1].trim() !== '' || (m[3] || '').trim()) continue;
    const validate = getValidator(m[2]);
    if (!validate) continue;
    checked += 1;
    const result = validate(undefined);
    if (result !== true) failures.push(`${m[2]} -> ${result}`);
  }

  assert.ok(checked >= 10, `expected several no-argument wrappers, checked ${checked}`);
  assert.deepEqual(failures, [], `no-argument channels rejected by their validator:\n  ${failures.join('\n  ')}`);
});

/**
 * The other direction of the same outage, and the one that actually shipped
 * seven broken channels in v0.1.14:
 *
 *     main/preload.js   getTemplate: (id) => invoke('labels:getTemplate', { id })
 *     validators.js     'labels:getTemplate': requireStringArg('template id')
 *                                      ^ wants a bare string, preload sends an object
 *
 * `requireStringArg` rejects the object, so Label Studio's get/delete/duplicate
 * template, delete run and open-output all failed with
 * `Bad request: template id must be a string`, and `images:revertMerge` /
 * `purgeMerge` the same way. Nothing noticed, because the name test only looks
 * for *unknown property names* and `{ id }` is not unknown.
 *
 * The rule used here is sound for SINGLE-FIELD wrappers: the validator must
 * accept `{ <thatField>: <some value of any JSON kind> }`. The probe below
 * covers every kind, so a rejection means the validator is looking for
 * something structurally different — not merely a different type. (If a future
 * single-field channel constrains its value to an enum, add that value to the
 * probe list; the failure message names the channel.)
 *
 * Multi-field wrappers are deliberately NOT checked: their fields have mixed
 * types, and no single uniform probe object can satisfy e.g. `{ query: string,
 * limit: number }`. That is a limitation of the probe, not a statement that
 * those channels are fine.
 */
const FIELD_PROBES = ['sample-uuid', 1, 0, true, null, {}, [], ''];

test('preload ↔ validator — a single-field object wrapper accepts its own payload', () => {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const re = /\(([^)]*)\)\s*=>\s*(?:\{[\s\S]*?\})?\s*invoke\(\s*'([^']+)'\s*(?:,\s*([\s\S]*?))?\)/g;

  const failures = [];
  let checked = 0;

  for (const m of src.matchAll(re)) {
    const channel = m[2];
    const tail = (m[3] || '').trim();
    if (!tail.startsWith('{')) continue;

    const keys = [];
    for (const part of tail.replace(/^\{/, '').replace(/\}$/, '').split(',')) {
      const k = part.split(':')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_]\w*$/.test(k)) keys.push(k);
    }
    if (keys.length !== 1) continue;          // see the note above

    const validate = getValidator(channel);
    if (!validate) continue;                  // exempt/uncovered — coverage test owns that

    checked += 1;
    const [field] = keys;
    if (!FIELD_PROBES.some((v) => validate({ [field]: v }) === true)) {
      failures.push(
        `${channel}  preload sends { ${field} }  but the validator rejects every value of it -> `
        + `"${validate({ [field]: FIELD_PROBES[0] })}". This channel cannot be called.`,
      );
    }
  }

  assert.ok(checked >= 15, `expected many single-field wrappers, checked ${checked}`);
  assert.deepEqual(
    failures,
    [],
    'A validator is rejecting the very payload its preload wrapper sends:\n  ' + failures.join('\n  '),
  );
});

/**
 * The third and strongest agreement check: compare the validators against the
 * argument objects the RENDERER actually passes.
 *
 * The two checks above work from main/preload.js. That is not enough, because a
 * bare-forward wrapper hides the real shape behind the renderer:
 *
 *     main/preload.js        autoEnhancePreview: (input) => invoke('images:autoEnhancePreview', input)
 *     AutoEnhanceRunModal    window.api.images.autoEnhancePreview({ productId, filepath, whiteBalance, … })
 *     validators.js          'images:autoEnhancePreview': requireFields('productIds')   <-- plural!
 *
 * Nothing in preload.js mentions `productId` at all, so neither check above had
 * anything to compare — and the validator demanding the PLURAL `productIds`
 * rejected the live preview, which then sat on "Rendering…" forever. The name
 * test missed it because "missing required field" does not contain the word
 * "unexpected", which is all it looked for.
 *
 * So this test reads the call sites instead. For every `window.api.<domain>.<method>({ … })`
 * it can parse, it builds an object with those exact keys and asks the
 * validator. A "missing required field: X" for an X the call site does not pass
 * (or an "unexpected/unknown" complaint) means the channel cannot be called.
 *
 * Deliberately value-agnostic: every key is probed with `{}`, so only shape
 * complaints count. A validator may legitimately reject `{}` for a field that
 * must be a string — that is a type statement, and types are verified against
 * the live app, not here.
 *
 * Reach, stated honestly: 287 renderer calls exist; 131 pass a variable rather
 * than a literal and 8 spread another object, so their keys are not knowable
 * from the source, and 120 channels have no validator (the coverage test owns
 * those). That leaves ~28 call sites checked. It is a real net, not a complete
 * one, and it is the net that catches this specific and twice-shipped mistake.
 */
function rendererCallSites() {
  const rendererDir = path.join(ROOT, 'renderer');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(p);
    }
  })(rendererDir);

  const sites = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /api\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const channel = `${m[1]}:${m[2]}`;
      let i = m.index + m[0].length;
      while (/\s/.test(src[i])) i += 1;
      if (src[i] !== '{') continue;               // variable / no argument
      const body = readBalanced(src, i);
      if (body === null || body.includes('...')) continue; // keys not knowable
      const keys = splitTopLevel(body)
        .map((part) => part.split(':')[0].trim())
        .filter((k) => /^[A-Za-z_]\w*$/.test(k));
      if (!keys.length) continue;
      const line = src.slice(0, m.index).split('\n').length;
      sites.push({ channel, keys, where: `${path.relative(ROOT, file)}:${line}` });
    }
  }
  return sites;
}

/** The text strictly inside the brace/paren group starting at `start`. */
function readBalanced(src, start) {
  let depth = 0;
  let quote = null;
  let body = '';
  for (let j = start; j < src.length; j += 1) {
    const c = src[j];
    if (quote) {
      if (c === '\\') { j += 1; continue; }
      if (c === quote) quote = null;
      body += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; body += c; continue; }
    if (c === '{' || c === '(' || c === '[') { depth += 1; if (depth === 1) { body = ''; continue; } }
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1;
      if (depth === 0) return body;
    }
    if (depth >= 1) body += c;
  }
  return null;
}

/** Split on commas that sit at the top level of an object literal. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let buf = '';
  for (let j = 0; j < body.length; j += 1) {
    const c = body[j];
    if (quote) {
      if (c === '\\') { j += 1; continue; }
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; buf += c; continue; }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

test('preload ↔ validator — object literals the renderer passes are accepted', () => {
  const sites = rendererCallSites();
  const failures = [];
  let probed = 0;

  for (const { channel, keys, where } of sites) {
    const validate = getValidator(channel);
    if (!validate) continue;                 // exempt/uncovered — coverage test owns that
    probed += 1;
    const result = validate(Object.fromEntries(keys.map((k) => [k, {}])));
    if (result === true) continue;
    if (/missing required field|unexpected|unknown/i.test(result)) {
      failures.push(
        `${channel}  (${where})\n     call passes: {${keys.join(', ')}}\n     validator:   ${result}`,
      );
    }
  }

  assert.ok(
    probed >= 20,
    `expected to probe ~28 renderer call sites, probed ${probed} — did the parser stop matching?`,
  );
  assert.deepEqual(
    failures,
    [],
    'These call sites pass an object the validator rejects, so the screen that\n'
    + 'makes the call is broken at runtime:\n  ' + failures.join('\n  '),
  );
});

test('preload ↔ validator — the call-site parser finds the known bare-forward calls', () => {
  // Guards the guard. Both of these pass an object literal whose keys appear
  // NOWHERE in preload.js, which is the whole reason this check exists.
  const sites = rendererCallSites();
  const channels = new Set(sites.map((s) => s.channel));
  assert.ok(channels.has('images:autoEnhancePreview'), 'autoEnhancePreview call site not parsed');
  assert.ok(channels.has('images:reencodeProducts'), 'reencodeProducts call site not parsed');

  const enhance = sites.find((s) => s.channel === 'images:autoEnhancePreview');
  assert.ok(enhance.keys.includes('productId'), 'the preview call passes a SINGULAR productId');
  assert.ok(!enhance.keys.includes('productIds'), 'the preview call does not pass productIds');
});
