const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'webclient/index.html'), 'utf8');

function browserNormalizer() {
  const start = source.indexOf('  function normalizeServerAddress(raw) {');
  const end = source.indexOf('\n  var storedBaseUrl', start);
  assert.ok(start >= 0 && end > start, 'browser URL normalizer should be present');
  const fnSource = source.slice(start, end);
  const context = { URL, Error };
  vm.createContext(context);
  vm.runInContext(`${fnSource}; result = normalizeServerAddress;`, context);
  return context.result;
}

test('web viewer normalizes saved viewer URLs to the API origin', () => {
  const normalize = browserNormalizer();
  assert.equal(normalize('http://server.local:13180/m/'), 'http://server.local:13180');
  assert.equal(normalize('server.local:13180'), 'http://server.local:13180');
  assert.equal(normalize('https://server.local:8443/path?x=1#viewer'), 'https://server.local:8443');
  assert.throws(() => normalize('ftp://server.local:13180'), /http|https/i);
  assert.throws(() => normalize('not a URL'), /valid/i);
});

test('web viewer guards session, company, and image-cache responses by generation', () => {
  assert.match(source, /var sessionGeneration = 0/);
  assert.match(source, /var companyGeneration = 0/);
  assert.match(source, /var imageCacheGeneration = 0/);
  assert.match(source, /var companySwitchChain = Promise\.resolve\(\)/);
  assert.match(source, /function sessionRequestCurrent\(request\)/);
  assert.match(source, /function imageRequestCurrent\(request\)/);
  assert.match(source, /request\.cache === imageCacheGeneration/);
  assert.match(source, /request\.session === sessionGeneration/);
  assert.match(source, /request\.company === companyGeneration/);
  assert.match(source, /function switchCompany\(id\)/);
  assert.match(source, /rpcAt\(request\.baseUrl, request\.token, 'companies:setActive', request\.id\)/);
  assert.match(source, /lastConfirmedCompany = companySnapshot\(request\.id, \[\], \[\]\)/);
  assert.match(source, /function loadCompanyData\(request\)/);
  assert.match(source, /if \(!imageRequestCurrent\(request\)\) return null/);
  assert.match(source, /if \(currentDetail && currentDetail\.id !== productId\) return;/);
  assert.match(source, /!imageRequestCurrent\(request\) \|\| \(currentDetail && currentDetail\.id !== productId\)/);
  assert.equal((source.match(/for \(var k in blobCache\)/g) || []).length, 1);
  assert.doesNotMatch(source, /delete imgListCache\[(?:productId|pid|ctx\.productId)\]; delete mainImgCache\[/);
  assert.match(source, /clearImageCaches\(productId\);/);
  assert.match(source, /clearImageCaches\(ctx\.productId\);/);
  assert.match(source, /clearImageCaches\(pid\);/);
  assert.match(source, /clearImageCaches\(\);/);
  assert.match(source, /companySwitchChain = Promise\.resolve\(\);/);
  assert.match(source, /if \(u !== baseUrl \|\| t !== token\) resetSessionState\(\)/);
});

test('generated web viewer is built from the checked-in source', () => {
  const generated = fs.readFileSync(path.join(root, 'main/webclientHtml.js'), 'utf8');
  assert.ok(generated.includes(JSON.stringify(source)), 'main/webclientHtml.js is stale; run scripts/build-webclient.js');
});
