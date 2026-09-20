/**
 * v0.1.31 — a pasted server address must work, whatever form it is copied in.
 *
 * WHAT WENT WRONG. Settings shows two lists of the SAME addresses three lines
 * apart, differing only by a path:
 *
 *   client connection   http://100.118.161.120:13180      (the desktop app)
 *   mobile web viewer   http://100.118.161.120:13180/m    (a phone browser)
 *
 * Pasting the second into the client's Connection field was ACCEPTED —
 * `validateServerUrl` checks scheme, host and protocol but never the path — and
 * the address was saved verbatim. Every request then went to
 * `/m/api/rpc`, which the server does not serve, so the client failed on every
 * screen with nothing pointing at the cause.
 *
 * The fix is to store and use the ORIGIN: scheme + host + port, with any path,
 * query or fragment dropped. The port is the part that must survive — 13180 is
 * not 80 — and `new URL().host` keeps it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeServerUrl } = require('../main/util/fetchErrors');

test('a bare origin is left alone', () => {
  assert.equal(normalizeServerUrl('http://100.118.161.120:13180'), 'http://100.118.161.120:13180');
  assert.equal(normalizeServerUrl('http://macmini.local:13180'), 'http://macmini.local:13180');
});

test('the mobile-viewer address collapses to the app address — the reported bug', () => {
  assert.equal(normalizeServerUrl('http://100.118.161.120:13180/m'), 'http://100.118.161.120:13180');
  assert.equal(normalizeServerUrl('http://100.118.161.120:13180/m/'), 'http://100.118.161.120:13180');
  // Any other path is treated the same way: only the origin is meaningful.
  assert.equal(normalizeServerUrl('http://10.0.0.5:13180/api/rpc'), 'http://10.0.0.5:13180');
});

test('the PORT survives — 13180 is not 80', () => {
  assert.equal(normalizeServerUrl('http://192.168.1.4:13180'), 'http://192.168.1.4:13180');
  assert.equal(normalizeServerUrl('http://192.168.1.4:13180/m'), 'http://192.168.1.4:13180');
});

test('a trailing slash and stray whitespace are removed', () => {
  assert.equal(normalizeServerUrl('  http://10.0.0.5:13180/  '), 'http://10.0.0.5:13180');
  assert.equal(normalizeServerUrl('http://10.0.0.5:13180///'), 'http://10.0.0.5:13180');
});

test('https is preserved, and a REDUNDANT default port is dropped', () => {
  // `new URL()` removes a port that is already the scheme's default (443 for
  // https, 80 for http). That is not a loss — the address still resolves
  // identically — so the test records the behaviour rather than fighting it.
  assert.equal(normalizeServerUrl('https://example.test'), 'https://example.test');
  assert.equal(normalizeServerUrl('https://example.test:443'), 'https://example.test');
  assert.equal(normalizeServerUrl('http://example.test:80'), 'http://example.test');
  // A NON-default port must survive, which is the case that matters here.
  assert.equal(normalizeServerUrl('https://example.test:8443'), 'https://example.test:8443');
});

test('query strings and fragments are dropped', () => {
  assert.equal(normalizeServerUrl('http://10.0.0.5:13180/?x=1'), 'http://10.0.0.5:13180');
  assert.equal(normalizeServerUrl('http://10.0.0.5:13180/#top'), 'http://10.0.0.5:13180');
});

test('an unparseable value is passed through so validation can complain', () => {
  // Deliberately NOT "fixed up" — the validator's message is more useful than
  // this silently turning a typo into something that looks plausible.
  assert.equal(normalizeServerUrl('100.118.161.120:13180'), '100.118.161.120:13180');
  assert.equal(normalizeServerUrl('not a url'), 'not a url');
});

test('empty and non-string input are handled without throwing', () => {
  assert.equal(normalizeServerUrl(''), '');
  assert.equal(normalizeServerUrl('   '), '');
  assert.equal(normalizeServerUrl(null), null);
  assert.equal(normalizeServerUrl(undefined), undefined);
  assert.equal(normalizeServerUrl(42), 42);
});

test('normalising is idempotent', () => {
  const once = normalizeServerUrl('http://100.118.161.120:13180/m');
  assert.equal(normalizeServerUrl(once), once);
});
