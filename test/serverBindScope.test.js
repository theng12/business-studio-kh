/**
 * 0.1.116: the multi-Mac server must never listen on a plain Wi-Fi/LAN address.
 *
 * Every request carries the user's bearer token and the event socket carries it
 * in the URL, so a listener on the LAN hands that token to anything on the
 * network that can read traffic. The server listens on loopback and on this
 * Mac's Tailscale addresses (WireGuard-encrypted); `serverBind: 'lan'` is the
 * explicit, warned way back to the old 0.0.0.0 listener.
 *
 * The decisive check is the socket one: with the old 0.0.0.0 bind, a connection
 * to this Mac's own Wi-Fi address succeeds, and this test fails.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const server = require('../main/server');
const config = require('../main/config');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-bind-'));
test.after(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

const TAILNET = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** This Mac's plain LAN address (not loopback, not Tailscale), or null. */
function plainLanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (TAILNET.test(iface.address)) continue;
      return iface.address;
    }
  }
  return null;
}

/** Resolves true when a TCP connection to this address:port is accepted. */
function canConnect(address, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

test('auto binds loopback and Tailscale only, never a plain LAN address', async (t) => {
  const info = await server.bootServer({ port: 0, dataDir });
  t.after(() => server.stopServer());

  assert.equal(info.bind, 'auto', 'plain Wi-Fi is off unless someone turns it on');
  assert.ok(info.bound.includes('127.0.0.1'), 'this Mac can always reach its own server');
  assert.ok(!info.bound.includes('0.0.0.0'), 'nothing listens on every interface');

  for (const address of info.bound) {
    if (address === '127.0.0.1') continue;
    assert.match(address, TAILNET, `${address} is only bound because it is a Tailscale address`);
  }

  // The behavioural half: loopback answers, the Wi-Fi address refuses.
  assert.equal(await canConnect('127.0.0.1', info.port), true, 'loopback is reachable');
  const lan = plainLanAddress();
  if (lan) {
    assert.equal(await canConnect(lan, info.port), false, `a client on Wi-Fi cannot connect (${lan}) and so never sends its token`);
  }
});

test('serverBind "lan" restores the warned 0.0.0.0 listener', async (t) => {
  const info = await server.bootServer({ port: 0, dataDir, bind: 'lan' });
  t.after(() => server.stopServer());

  assert.equal(info.bind, 'lan');
  assert.deepEqual(info.bound, ['0.0.0.0'], 'the explicit choice listens on everything');
  assert.equal(await canConnect('127.0.0.1', info.port), true);

  const lan = plainLanAddress();
  if (lan) assert.equal(await canConnect(lan, info.port), true, 'Wi-Fi clients work only with the switch on');
});

test('the address list only offers places the server is listening', () => {
  const auto = server.reachableAddresses('auto');
  for (const address of auto) assert.equal(address.kind, 'tailscale', `${address.ip} is not listening under auto`);

  const lan = server.reachableAddresses('lan');
  assert.ok(lan.length >= auto.length, 'the lan mode offers at least everything auto does');
  for (const address of lan) assert.ok(['tailscale', 'mdns', 'lan'].includes(address.kind));
});

test('bindTargets never produces a plain LAN address under auto', () => {
  const targets = server.bindTargets('auto');
  assert.deepEqual(targets[0], '127.0.0.1', 'loopback is always first');
  for (const address of targets) {
    assert.ok(address === '127.0.0.1' || TAILNET.test(address), `${address} must be loopback or Tailscale`);
  }
  assert.deepEqual(server.bindTargets('lan'), ['0.0.0.0']);
  assert.deepEqual(server.bindTargets(undefined), server.bindTargets('auto'), 'an unknown value fails safe');
});

test('serverBind is an off-by-default setting a person can switch, and junk is refused', () => {
  // defaultConfig is the allowlist assertKnownConfigKeys builds from, so a key
  // that is in here is a key the settings setter accepts.
  const defaults = config.defaultConfig();
  assert.equal(defaults.serverBind, 'auto', 'ships with Wi-Fi connections off');
  assert.throws(() => config.assertValidConfigValues({ serverBind: 'everything' }), /either on or off/);
  assert.doesNotThrow(() => config.assertValidConfigValues({ serverBind: 'lan' }));
});
