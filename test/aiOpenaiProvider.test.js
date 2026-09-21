/**
 * Mocked-fetch tests for the OpenAI image provider adapter.
 *
 * No network and no API key: `global.fetch` is replaced for each case, so the
 * request shape, filtering, size mapping and error handling are verified
 * without any paid call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const openai = require('../main/ai/providers/openai');

function mockFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      text: async () => (out.body == null ? '' : JSON.stringify(out.body)),
    };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

test('imageModelsFrom filters to image models, de-duplicates and sorts', () => {
  assert.deepEqual(
    openai.imageModelsFrom(['gpt-4o', 'gpt-image-1', 'dall-e-3', 'gpt-image-1', 'text-embedding-3', 'gpt-image-2.5-sunburst']),
    ['dall-e-3', 'gpt-image-1', 'gpt-image-2.5-sunburst'],
  );
  assert.deepEqual(openai.imageModelsFrom(null), []);
});

test('capabilitiesFor covers gpt-image, dall-e-3 and dall-e-2', () => {
  assert.deepEqual(openai.capabilitiesFor('gpt-image-2.5-flare').sizes, ['auto', '1:1', '3:2', '2:3']);
  assert.equal(openai.capabilitiesFor('gpt-image-2.5-flare').supportsSource, true);
  assert.deepEqual(openai.capabilitiesFor('dall-e-3').sizes, ['1:1', '7:4', '4:7']);
  assert.equal(openai.capabilitiesFor('dall-e-3').supportsSource, false);
  assert.equal(openai.capabilitiesFor('dall-e-2').supportsSource, true);
});

test('sizeParamFor maps ratio labels to the provider size strings', () => {
  assert.equal(openai.sizeParamFor('gpt-image-1', '3:2'), '1536x1024');
  assert.equal(openai.sizeParamFor('gpt-image-1', '2:3'), '1024x1536');
  assert.equal(openai.sizeParamFor('gpt-image-1', 'auto'), 'auto');
  assert.equal(openai.sizeParamFor('dall-e-3', '7:4'), '1792x1024');
  assert.equal(openai.sizeParamFor('dall-e-2', '1:1'), '1024x1024');
  assert.equal(openai.sizeParamFor('gpt-image-1', 'nonsense'), 'auto');
});

test('listModels reads /v1/models and filters to image models', async () => {
  const m = mockFetch(() => ({ status: 200, body: { data: [{ id: 'gpt-4o' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }] } }));
  try {
    const models = await openai.listModels('sk-test');
    assert.deepEqual(models, ['dall-e-3', 'gpt-image-1']);
    assert.match(m.calls[0].url, /\/v1\/models$/);
    assert.equal(m.calls[0].init.headers.Authorization, 'Bearer sk-test');
  } finally { m.restore(); }
});

test('testConnection rejects an empty key without calling the network', async () => {
  const m = mockFetch(() => { throw new Error('should not be called'); });
  try {
    await assert.rejects(() => openai.testConnection('   '), /API key is empty/);
    assert.equal(m.calls.length, 0);
  } finally { m.restore(); }
});

test('testConnection surfaces a 401', async () => {
  const m = mockFetch(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
  try {
    await assert.rejects(() => openai.testConnection('sk-bad'), /rejected the API key \(401\)/);
  } finally { m.restore(); }
});

test('generate posts a JSON generations request and returns a data URL', async () => {
  const m = mockFetch(() => ({ status: 200, body: { data: [{ b64_json: 'QUJD' }] } }));
  try {
    const out = await openai.generate('sk-test', { model: 'dall-e-3', prompt: 'a red mug', options: { size: '7:4', quality: 'hd' } });
    assert.deepEqual(out.outputUrls, ['data:image/png;base64,QUJD']);
    assert.match(m.calls[0].url, /\/v1\/images\/generations$/);
    assert.equal(m.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(m.calls[0].init.body), {
      model: 'dall-e-3', prompt: 'a red mug', n: 1, size: '1792x1024', quality: 'hd',
    });
  } finally { m.restore(); }
});

test('generate posts a multipart edits request when a source image is given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-openai-'));
  const file = path.join(dir, 'source.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const m = mockFetch(() => ({ status: 200, body: { data: [{ b64_json: 'RURJVA==' }] } }));
  try {
    const out = await openai.generate('sk-test', { model: 'gpt-image-1', prompt: 'make it blue', sourceImageAbs: file, options: { size: '1:1' } });
    assert.deepEqual(out.outputUrls, ['data:image/png;base64,RURJVA==']);
    assert.match(m.calls[0].url, /\/v1\/images\/edits$/);
    assert.ok(m.calls[0].init.body instanceof FormData, 'edits request must be multipart FormData');
    assert.equal(m.calls[0].init.body.get('size'), '1024x1024');
    assert.equal(m.calls[0].init.body.get('model'), 'gpt-image-1');
  } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generate falls back to generations when the model does not support a source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-openai-'));
  const file = path.join(dir, 'source.png');
  fs.writeFileSync(file, Buffer.from([0x89]));
  const m = mockFetch(() => ({ status: 200, body: { data: [{ b64_json: 'WA==' }] } }));
  try {
    await openai.generate('sk-test', { model: 'dall-e-3', prompt: 'x', sourceImageAbs: file });
    assert.match(m.calls[0].url, /\/v1\/images\/generations$/);
  } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generate surfaces a 429 rate limit', async () => {
  const m = mockFetch(() => ({ status: 429, body: { error: { message: 'slow down' } } }));
  try {
    await assert.rejects(() => openai.generate('sk-test', { model: 'gpt-image-1', prompt: 'x' }), /rate limit \(429\)/);
  } finally { m.restore(); }
});

test('generate rejects an empty image response', async () => {
  const m = mockFetch(() => ({ status: 200, body: { data: [] } }));
  try {
    await assert.rejects(() => openai.generate('sk-test', { model: 'gpt-image-1', prompt: 'x' }), /returned no image data/);
  } finally { m.restore(); }
});

test('outputUrlsFrom prefers b64 payloads and ignores empty rows', () => {
  assert.deepEqual(openai.outputUrlsFrom({ data: [{ b64_json: 'QQ==' }, { url: 'https://x/y.png' }, {}] }),
    ['data:image/png;base64,QQ==', 'https://x/y.png']);
  assert.deepEqual(openai.outputUrlsFrom({}), []);
});
