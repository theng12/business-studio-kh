/**
 * v0.1.29 — handlers that exist in BOTH modes must apply the same rules.
 *
 * AGENTS.md §15 names this as the consequence that is easy to forget: client
 * mode has its OWN implementation of some local-only handlers, so a rule
 * written only in `main/ipc/<domain>.js` does not exist in
 * `main/client/index.js`. The shared helpers live in `main/util/fileKinds.js`
 * precisely so both can reach them.
 *
 * A concrete instance: `files:readImageThumb` reads a file at a path the
 * renderer chose, so both copies must reject a path that is not absolute and a
 * file that is not an image. The client copy checked only "is this a string",
 * so for a while the same call was validated on a standalone Mac and not on a
 * client Mac — and nothing failed, because the divergence only shows up in the
 * mode nobody was testing.
 *
 * This is deliberately narrow: it pins the shared sink checks for the channels
 * where a divergence would be a security or data-integrity hole. "Does this
 * handler validate enough" is not a question a regex can answer, so the list is
 * the decision and this test makes changing that decision deliberate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'main', 'client', 'index.js');
const FILE_KINDS = path.join(ROOT, 'main', 'util', 'fileKinds.js');

/** The body of one `handleLocal('channel', …)` cell, up to the next one. */
function clientHandlerBody(channel) {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const start = src.indexOf(`handleLocal('${channel}'`);
  assert.notEqual(start, -1, `client mode has no handler for ${channel}`);
  const next = src.indexOf('handleLocal(', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

test('the shared sink-check helpers still exist where both modes import them', () => {
  const kinds = fs.readFileSync(FILE_KINDS, 'utf8');
  for (const helper of ['isAbsolutePath', 'isImagePath']) {
    assert.match(kinds, new RegExp(`function ${helper}\\b`), `${helper} is missing from fileKinds.js`);
    assert.match(kinds, new RegExp(`\\b${helper},`), `${helper} is not exported from fileKinds.js`);
  }
});

test('client files:readImageThumb applies the same path + kind checks as the server', () => {
  const body = clientHandlerBody('files:readImageThumb');
  // Must CALL them, not merely mention them in a comment: strip comments first.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.match(code, /isAbsolutePath\s*\(/, 'the absolute-path check is missing on the client copy');
  assert.match(code, /isImagePath\s*\(/, 'the image-kind check is missing on the client copy');
  assert.match(code, /require\(['"]\.\.\/util\/fileKinds['"]\)/,
    'the client copy should use the shared helpers rather than re-implementing the rule');
});

test('the server twin still enforces them (so the two cannot drift legitimately)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'files.js'), 'utf8');
  const start = src.indexOf("exposeLocal('files:readImageThumb'");
  assert.notEqual(start, -1, 'the server handler was renamed or removed');
  const body = src.slice(start, start + 800);
  assert.match(body, /isAbsolutePath\s*\(/);
  assert.match(body, /isImagePath\s*\(/);
});
