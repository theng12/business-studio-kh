const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function parseVersion(version) {
  if (typeof version !== 'string' || /[^0-9.]/.test(version) || !/^[0-9]{1,9}(\.[0-9]{1,9}){0,5}$/.test(version)) return null;
  return version.split('.').map(Number);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function isNewer(feedVersion, installedVersion) {
  return compareVersions(feedVersion, installedVersion) === 1;
}

function findAppEntry(feed, bundleID) {
  if (!feed || !feed.apps || typeof feed.apps !== 'object') return null;
  return Object.values(feed.apps).find((entry) => entry && entry.bundleID === bundleID) || null;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Malformed base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Malformed base64');
  return bytes;
}

function verifyFeedResponse(response, publicKeyBase64) {
  const bytes = decodeBase64(response && response.feed);
  const signature = decodeBase64(response && response.signature);
  const rawKey = decodeBase64(publicKeyBase64);
  if (rawKey.length !== 32 || signature.length !== 64) throw new Error('Invalid signature or public key');
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' });
  if (!crypto.verify(null, bytes, key, signature)) throw new Error('Invalid feed signature');
  let feed;
  try { feed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Malformed feed JSON'); }
  if (!feed || feed.schema !== 1) throw new Error('Unsupported feed schema');
  return feed;
}

function readPublisher(homeDir) {
  let text;
  try { text = fs.readFileSync(path.join(homeDir, 'Library', 'KHUpdater', 'base', 'config.json'), 'utf8'); }
  catch (error) { return { reason: error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  let publisher;
  try { publisher = JSON.parse(text); } catch { return { reason: 'incomplete' }; }
  if (!publisher || typeof publisher.feedURL !== 'string' || !publisher.feedURL.trim() || typeof publisher.publicKey !== 'string' || !publisher.publicKey.trim()) {
    return { reason: 'incomplete' };
  }
  return { publisher };
}

async function checkForUpdate({ homeDir, bundleID, installedVersion, fetchImpl }) {
  const result = readPublisher(homeDir);
  if (result.reason === 'missing' || result.reason === 'unreadable') {
    return { state: 'not-checked', reason: 'This Mac is not connected to an Update Studio' };
  }
  if (result.reason) return { state: 'failed', reason: 'Update Studio connection is incomplete' };
  let response;
  try {
    response = await fetchImpl(result.publisher.feedURL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    return { state: 'failed', reason: `Could not reach the Update Studio: ${error.message}` };
  }
  try {
    let body;
    try { body = await response.json(); } catch { throw new Error('Malformed response JSON'); }
    const feed = verifyFeedResponse(body, result.publisher.publicKey);
    const entry = findAppEntry(feed, bundleID);
    if (!entry) throw new Error('Not offered by this Update Studio');
    if (!parseVersion(entry.version)) throw new Error('Invalid feed version');
    if (!parseVersion(installedVersion)) throw new Error('Invalid installed version');
    return isNewer(entry.version, installedVersion)
      ? { state: 'available', version: entry.version }
      : { state: 'up-to-date', version: entry.version };
  } catch (error) {
    return { state: 'failed', reason: error.message };
  }
}

module.exports = { parseVersion, compareVersions, isNewer, findAppEntry, verifyFeedResponse, readPublisher, checkForUpdate };
