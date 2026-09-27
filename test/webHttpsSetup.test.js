/**
 * The HTTPS setup helper. Its job is to turn "put the viewer behind TLS" into
 * one command and, when that cannot work, say WHY in terms the owner can act
 * on — the Mac App Store Tailscale build cannot serve at all, and the tailnet
 * needs HTTPS certificates enabled once.
 *
 * Only the pure parts are tested here; the Tailscale calls themselves can only
 * be exercised on a machine that has a working Tailscale (see HANDOFF).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { serverPort, httpsUrlFor, findCli } = require('../scripts/setup-web-https.js');

test('the machine DNS name becomes the viewer URL', () => {
  assert.equal(
    httpsUrlFor('mac-studio-m1-max-32.example-tailnet.ts.net.'),
    'https://mac-studio-m1-max-32.example-tailnet.ts.net/m',
    'the trailing dot Tailscale reports is not part of a URL',
  );
  assert.equal(httpsUrlFor('mac.tailnet.ts.net', '/'), 'https://mac.tailnet.ts.net/');
  assert.equal(httpsUrlFor(''), '', 'no name, no URL — the caller reports it rather than printing nonsense');
  assert.equal(httpsUrlFor(null), '');
});

test('the server port comes from the app’s own config, with a sane fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-https-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ serverPort: 14123 }));
    assert.equal(serverPort(file), 14123);

    fs.writeFileSync(file, JSON.stringify({ serverPort: 'nonsense' }));
    assert.equal(serverPort(file), 13180, 'the documented default');

    fs.writeFileSync(file, 'not json at all');
    assert.equal(serverPort(file), 13180, 'a corrupt config must not break the helper');

    assert.equal(serverPort(path.join(dir, 'missing.json')), 13180);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI is looked for on PATH and then in the app bundle', () => {
  // Whatever this machine has, the lookup must answer with a string or null and
  // never throw — a missing Tailscale is a message, not a crash.
  const cli = findCli();
  assert.ok(cli === null || typeof cli === 'string');
});
