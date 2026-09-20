/**
 * v0.1.25 — every relative `require()` in main/ must point at a file that exists.
 *
 * WHY THIS EXISTS. While fixing an unrelated bug I added
 * `require('../../util/fileKinds')` to `main/ipc/ai.js`. The file is at
 * `main/ipc/`, so `../../` climbs out of `main/` entirely and the path does not
 * exist. Nothing caught it:
 *
 *   - `node --check` only parses; it does not resolve imports.
 *   - ESLint has no import-resolution rule configured for CommonJS.
 *   - `npm test` never loads main/ipc/ai.js.
 *   - The native DB tests do not either.
 *
 * It surfaced only when the app was launched, as
 * `Error: Cannot find module '../../util/fileKinds'` — the app refused to boot
 * at all. A one-character mistake in a require path is a total outage, and the
 * whole suite was green.
 *
 * So this is a static resolution pass: for every `require('./…')` or
 * `require('../…')` under main/, assert the target resolves. It is deliberately
 * dumb and cheap — it does not try to type-check anything, it just answers "is
 * this path a real file", which is exactly the failure mode that got through.
 *
 * Bare specifiers (`electron`, `node:fs`, `better-sqlite3`, …) are ignored;
 * they resolve through node_modules and are not ours to validate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Can this relative specifier be resolved the way CommonJS would? */
function resolves(fromFile, spec) {
  const target = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return true;
  for (const candidate of [`${target}.js`, `${target}.json`, path.join(target, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return true;
  }
  return false;
}

test('the scan actually found main/ sources (guards the guard)', () => {
  const files = walk(MAIN);
  assert.ok(files.length > 90, `expected 90+ main/ files, found ${files.length}`);
});

test('every relative require() in main/ resolves to a real file', () => {
  const unresolved = [];
  for (const file of walk(MAIN)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/require\(\s*'(\.[^']*)'/g)) {
      if (!resolves(file, m[1])) {
        unresolved.push(`${path.relative(ROOT, file)}  ->  require('${m[1]}')`);
      }
    }
  }
  assert.deepEqual(
    unresolved,
    [],
    'These requires point at paths that do not exist. Nothing else in the suite\n'
    + 'catches this — the app simply refuses to start with "Cannot find module":\n  '
    + unresolved.join('\n  '),
  );
});

test('the resolver rejects a path that climbs out of main/', () => {
  // Pins the exact mistake: from main/ipc/, '../../util/x' escapes main/.
  const fake = path.join(MAIN, 'ipc', 'ai.js');
  assert.equal(resolves(fake, '../util/fileKinds'), true, '../util/fileKinds is correct');
  assert.equal(resolves(fake, '../../util/fileKinds'), false, '../../util/fileKinds escapes main/');
});
