const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { parseVersion, compareVersions, isNewer, findAppEntry, verifyFeedResponse, checkForUpdate } = require('../main/util/feedCheck');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
function signed(feed) {
  const bytes = Buffer.from(JSON.stringify(feed));
  return { feed: bytes.toString('base64'), signature: crypto.sign(null, bytes, privateKey).toString('base64') };
}
function feed(version, bundleID = 'our.id') {
  return { schema: 1, apps: { internal: { bundleID, version, name: 'Example' } } };
}

test('version parsing and numeric comparison', () => {
  assert.deepEqual(parseVersion('1.10.0'), [1, 10, 0]);
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(isNewer('1.0.1', '1'), true);
  for (const value of ['', '1.2.3.4.5.6.7', '1.a', '1..2', '1234567890', '１', '1\n']) {
    assert.equal(parseVersion(value), null);
    assert.equal(isNewer(value, '1'), false);
  }
  assert.equal(compareVersions('1', 'bad'), null);
});

test('finds entries by bundle identifier only', () => {
  const data = feed('1');
  assert.equal(findAppEntry(data, 'our.id').version, '1');
  assert.equal(findAppEntry(data, 'Example'), null);
  assert.equal(findAppEntry(data, 'internal'), null);
});

test('verifies signed bytes and rejects invalid responses', () => {
  const response = signed(feed('1'));
  assert.deepEqual(verifyFeedResponse(response, key), feed('1'));
  assert.throws(() => verifyFeedResponse({ ...response, feed: Buffer.from('tampered').toString('base64') }, key), /signature/i);
  assert.throws(() => verifyFeedResponse(signed({ schema: 2 }), key), /schema/i);
  assert.throws(() => verifyFeedResponse({ ...response, signature: '!' }, key), /base64/i);
  const badJson = Buffer.from('{');
  assert.throws(() => verifyFeedResponse({ feed: badJson.toString('base64'), signature: crypto.sign(null, badJson, privateKey).toString('base64') }, key), /JSON/);
});

test('check returns honest states from verified feeds', async () => {
  const originalRead = fs.readFileSync;
  let publisher;
  fs.readFileSync = (filename, ...args) => {
    if (String(filename).endsWith('/Library/KHUpdater/base/config.json')) {
      if (!publisher) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return JSON.stringify(publisher);
    }
    return originalRead(filename, ...args);
  };
  try {
    let responseFeed = feed('1');
    const check = () => checkForUpdate({ homeDir: '/fictional', bundleID: 'our.id', installedVersion: '1.2', fetchImpl: async () => ({ ok: true, json: async () => signed(responseFeed) }) });
    assert.deepEqual(await check(), { state: 'not-checked', reason: 'This Mac is not connected to an Update Studio' });
    publisher = { feedURL: 'http://example.invalid/release.json', publicKey: key };
    assert.equal((await check()).state, 'up-to-date');
    responseFeed = feed('1.2');
    assert.equal((await check()).state, 'up-to-date');
    responseFeed = feed('1.10');
    assert.deepEqual(await check(), { state: 'available', version: '1.10' });
    responseFeed = feed('2', 'other.id');
    assert.match((await check()).reason, /not offered/i);
    responseFeed = feed('broken');
    assert.deepEqual(await check(), { state: 'failed', reason: 'Invalid feed version' });
    const failed = await checkForUpdate({ homeDir: '/fictional', bundleID: 'our.id', installedVersion: '1', fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(failed.state, 'failed');
    assert.match(failed.reason, /reach.*offline/i);
  } finally {
    fs.readFileSync = originalRead;
  }
});
