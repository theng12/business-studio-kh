/**
 * Fuel phone set-up on the Mac (renderer/modules/Fuel/FuelPhoneSetup.jsx):
 * the pure parts — the QR link (token in the fragment only), which accounts may
 * pair a fuel phone, and which address a phone uses on a server vs a client Mac.
 * Plain `npm test` (esbuild bundles the module with React stubbed).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

async function load() {
  const esbuild = require('esbuild');
  const out = await esbuild.build({
    stdin: { contents: "export { fuelPhoneUrl, fuelPhoneAccounts, phoneAccounts, fuelPhoneAddresses, PhoneSetup, FuelPhoneSetup } from './renderer/modules/Fuel/FuelPhoneSetup.jsx';", resolveDir: ROOT, loader: 'js' },
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'bwip-js'],
  });
  const mod = { exports: {} };
  const stubs = {
    react: { useEffect() {}, useMemo: (fn) => fn(), useState: (v) => [v, () => {}] },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' },
    'bwip-js': { toSVG: () => '<svg/>' },
  };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)((id) => stubs[id] || {}, mod, mod.exports);
  return mod.exports;
}

test('the QR link carries the token in the fragment, never the query', async () => {
  const { fuelPhoneUrl } = await load();
  const url = fuelPhoneUrl('http://100.64.0.5:13180/', 'abc+/=');
  assert.equal(url, 'http://100.64.0.5:13180/f#t=abc%2B%2F%3D');
  assert.equal(new URL(url).search, '');
  assert.equal(new URL(url).pathname, '/f');
});

test('only active accounts whose role records or manages fuel; admin last and marked', async () => {
  const { fuelPhoneAccounts } = await load();
  const roles = [
    { key: 'admin', name: 'Admin', permissions: ['*'] },
    { key: 'editor', name: 'Editor', permissions: ['products.edit'] },
    { key: 'pump', name: 'Pump phone', permissions: ['fuel.record'] },
    { key: 'fuelboss', name: 'Fuel manager', permissions: ['fuel.manage'] },
  ];
  const users = [
    { id: 'a', name: 'Owner', role: 'admin', token: 't-a' },
    { id: 'e', name: 'Editor', role: 'editor', token: 't-e' },
    { id: 'p', name: 'Pump', role: 'pump', token: 't-p' },
    { id: 'd', name: 'Dara', role: 'pump', token: 't-d', deactivatedAt: 5 },
    { id: 'm', name: 'Manager', role: 'fuelboss', token: 't-m' },
    { id: 'n', name: 'No token', role: 'pump' },
  ];
  const list = fuelPhoneAccounts(users, roles);
  assert.deepEqual(list.map((a) => a.id), ['m', 'p', 'a']);
  assert.equal(list[2].admin, true);
  assert.equal(list[1].roleName, 'Pump phone');
  assert.deepEqual(fuelPhoneAccounts(null, null), []);
});

test('addresses: the server Mac lists its own; a client Mac uses its saved server address; standalone explains', async () => {
  const { fuelPhoneAddresses } = await load();
  const server = fuelPhoneAddresses({
    mode: 'server',
    status: { running: true, port: 13180, addresses: [{ ip: '192.168.1.10', kind: 'lan' }, { ip: '100.64.0.5', kind: 'tailscale' }, { ip: 'shop.local', kind: 'mdns' }] },
  });
  assert.deepEqual(server.list.map((a) => a.origin), ['http://192.168.1.10:13180', 'http://100.64.0.5:13180', 'http://shop.local:13180']);
  assert.match(server.list[1].label, /^Tailscale/);
  assert.equal(fuelPhoneAddresses({ mode: 'server', status: { running: false } }).error, 'not-running');
  const client = fuelPhoneAddresses({ mode: 'client', clientServerUrl: 'http://100.64.0.5:13180' });
  assert.deepEqual(client.list.map((a) => [a.origin, a.kind]), [['http://100.64.0.5:13180', 'tailscale']]);
  assert.equal(fuelPhoneAddresses({ mode: 'client', clientServerUrl: 'http://office.local:13180/' }).list[0].kind, 'mdns');
  assert.equal(fuelPhoneAddresses({ mode: 'client', clientServerUrl: '' }).error, 'no-server-url');
  assert.equal(fuelPhoneAddresses({ mode: 'standalone' }).error, 'standalone');
});

test('HR1: "Set up a phone" lists fuel AND attendance accounts, with each one\'s staff link', async () => {
  const { phoneAccounts, PhoneSetup, FuelPhoneSetup } = await load();
  assert.equal(FuelPhoneSetup, PhoneSetup, 'the Fuel slot and People mount the same screen');
  const roles = [
    { key: 'admin', name: 'Admin', permissions: ['*'] },
    { key: 'pump', name: 'Pump phone', permissions: ['fuel.record'] },
    { key: 'staff', name: 'Clock-in phone', permissions: ['attendance.self'] },
    { key: 'driver', name: 'Driver', permissions: ['fuel.record', 'attendance.self'] },
    { key: 'sup', name: 'Supervisor', permissions: ['attendance.supervise', 'attendance.self'] },
    { key: 'kiosk', name: 'Shop kiosk', permissions: ['attendance.kiosk'] },
  ];
  const users = [
    { id: 'a', name: 'Owner', role: 'admin', token: 't-a' },
    { id: 'p', name: 'Pump', role: 'pump', token: 't-p' },
    { id: 's', name: 'Sophal', role: 'staff', token: 't-s' },
    { id: 'd', name: 'Dara', role: 'driver', token: 't-d' },
    { id: 'v', name: 'Visal', role: 'sup', token: 't-v' },
    { id: 'k', name: 'Kiosk', role: 'kiosk', token: 't-k' },
  ];
  const staff = [
    { id: 'e1', nameEn: 'Keo Sophal', userId: 's', status: 'active' },
    { id: 'e2', nameEn: 'Sok Dara', userId: 'd', status: 'suspended' },
    { id: 'e3', nameEn: 'Old Visal', userId: 'v', status: 'left' },
  ];
  const all = phoneAccounts(users, roles, { staff });
  assert.deepEqual(all.map((a) => a.id), ['d', 'p', 's', 'v', 'a'], 'the kiosk account is not a phone account');
  const by = Object.fromEntries(all.map((a) => [a.id, a]));
  assert.deepEqual(by.d.uses.map((u) => u.key), ['fuel', 'self'], 'a driver: fuel and clock-in');
  assert.deepEqual(by.v.uses.map((u) => u.key), ['self', 'crew']);
  assert.deepEqual(by.s.link, { name: 'Keo Sophal', suspended: false });
  assert.deepEqual(by.d.link, { name: 'Sok Dara', suspended: true });
  assert.equal(by.v.link, null, 'a record that has left does not count: not linked');
  assert.equal(by.p.link, null, 'a fuel-only account needs no link');
  assert.equal(by.p.attendance, false);
  assert.equal(by.a.admin, true);
  assert.equal(by.a.attendance, false, 'the owner is not nagged about a link');
  // Only attendance accounts (People), only fuel accounts (the old list).
  assert.deepEqual(phoneAccounts(users, roles, { only: 'attendance', staff }).map((a) => a.id), ['d', 's', 'v', 'a']);
  assert.deepEqual(phoneAccounts(users, roles, { only: 'fuel', staff }).map((a) => a.id), ['d', 'p', 'a']);
  // A staff list without account ids (tiles) or none at all: the link is unknown, not "not linked".
  assert.equal(phoneAccounts(users, roles, { staff: [{ id: 'e1', nameEn: 'Keo' }] }).find((a) => a.id === 's').link, undefined);
  assert.equal(phoneAccounts(users, roles, { staff: null }).find((a) => a.id === 's').link, undefined);
});
