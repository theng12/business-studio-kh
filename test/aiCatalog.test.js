/**
 * Catalog + cost tests for the OpenAI-only AI rework.
 *
 * These are pure (no network, no key): `main/ai/models.js` builds its
 * entries from `capabilitiesFor`, and `main/ai/costs.js` +
 * `main/ai/pricing.js` turn tokens into dollars.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../main/ai/models');
const costs = require('../main/ai/costs');
const pricing = require('../main/ai/pricing');

test('the built-in catalog is OpenAI-only and non-empty', () => {
  assert.deepEqual(models.MODELS.map((m) => m.modelId), ['gpt-image-2']);
  for (const m of models.MODELS) {
    assert.equal(m.provider, 'openai');
    assert.equal(m.key, `openai:${m.modelId}`);
  }
});

test('catalogFor builds capability-driven entries from a live model list', () => {
  const catalog = models.catalogFor(['gpt-4o', 'gpt-image-1', 'gpt-image-2.5-flare', 'dall-e-3']);
  assert.deepEqual(catalog.map((m) => m.modelId), ['dall-e-3', 'gpt-image-1', 'gpt-image-2.5-flare']);

  const flare = catalog.find((m) => m.modelId === 'gpt-image-2.5-flare');
  assert.equal(flare.key, 'openai:gpt-image-2.5-flare');
  assert.equal(flare.displayName, 'GPT Image 2.5 Flare');
  assert.equal(flare.supportsSource, true);
  assert.equal(flare.nMax, 10);
  assert.ok(flare.sizes.includes('1:1'));
  assert.ok(flare.sizes.includes('16:9'));
  assert.ok(flare.qualities.includes('xhigh'));
  assert.ok(flare.qualities.includes('max'));
  assert.equal(flare.customSizes, true);

  const plain = catalog.find((m) => m.modelId === 'gpt-image-1');
  assert.deepEqual(plain.sizes, ['auto', '1:1', '3:2', '2:3']);
  assert.deepEqual(plain.qualities, ['auto', 'low', 'medium', 'high']);
  assert.equal(plain.customSizes, false);

  const dalle = catalog.find((m) => m.modelId === 'dall-e-3');
  assert.equal(dalle.supportsSource, false);
  assert.equal(dalle.nMax, 1);
  assert.deepEqual(dalle.qualities, ['standard', 'hd']);
});

test('catalogFor falls back to the built-in list when the live list has no image models', () => {
  assert.deepEqual(models.catalogFor([]).map((m) => m.key), models.MODELS.map((m) => m.key));
  assert.deepEqual(models.catalogFor(['gpt-4o', 'text-embedding-3']).map((m) => m.key), models.MODELS.map((m) => m.key));
});

test('catalogFor hides pinned dated snapshots when the plain alias exists', () => {
  const catalog = models.catalogFor([
    'gpt-image-2',
    'gpt-image-2-2026-04-21',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-flare-2026-09-08',
    'gpt-image-3-2027-01-01', // pinned snapshot with no alias -> kept
  ]);
  assert.deepEqual(catalog.map((m) => m.modelId), [
    'gpt-image-2',
    'gpt-image-2.5-flare',
    'gpt-image-3-2027-01-01',
  ]);
  // A task that already references a hidden snapshot still resolves.
  assert.equal(models.byKey('openai:gpt-image-2-2026-04-21').modelId, 'gpt-image-2-2026-04-21');
});

test('byKey resolves known keys, bare ids, and synthesizes unseen OpenAI models', () => {
  assert.equal(models.byKey('openai:gpt-image-1').modelId, 'gpt-image-1');
  assert.equal(models.byKey('gpt-image-1').modelId, 'gpt-image-1');
  const future = models.byKey('openai:gpt-image-3');
  assert.equal(future.modelId, 'gpt-image-3');
  assert.equal(future.supportsSource, true);
});

test('byKey rejects retired kie.ai / fal.ai task rows', () => {
  assert.equal(models.byKey('kie:gpt-image-2-image-to-image'), null);
  assert.equal(models.byKey('fal-ai/nano-banana/edit'), null);
  assert.equal(models.byKey(''), null);
  assert.equal(models.byKey(null), null);
});

/* ── Cost ──────────────────────────────────────────────────── */

test('ratesFor matches the official per-model token prices', () => {
  assert.deepEqual(pricing.ratesFor('openai:gpt-image-2.5-flare'), { textIn: 5, imageIn: 8, imageOut: 30 });
  assert.deepEqual(pricing.ratesFor('openai:gpt-image-2'), { textIn: 5, imageIn: 8, imageOut: 30 });
  assert.deepEqual(pricing.ratesFor('openai:gpt-image-1.5'), { textIn: 5, imageIn: 8, imageOut: 32 });
  assert.deepEqual(pricing.ratesFor('openai:gpt-image-1-mini'), { textIn: 2, imageIn: 2.5, imageOut: 8 });
  assert.deepEqual(pricing.ratesFor('openai:gpt-image-1'), { textIn: 5, imageIn: 10, imageOut: 40 });
  // A retired provider has no OpenAI rate.
  assert.equal(pricing.ratesFor('kie:nano-banana-pro'), null);
});

test('outputTokensFor uses published gpt-image-1 counts and measured 2.5 counts', () => {
  assert.equal(pricing.outputTokensFor({ modelId: 'gpt-image-1', size: '1:1', quality: 'low' }), 272);
  assert.equal(pricing.outputTokensFor({ modelId: 'gpt-image-1', size: '1:1', quality: 'medium' }), 1056);
  assert.equal(pricing.outputTokensFor({ modelId: 'gpt-image-1', size: '1:1', quality: 'high' }), 4160);
  assert.equal(pricing.outputTokensFor({ modelId: 'gpt-image-1', size: '3:2', quality: 'low' }), 408);
  // Measured on gpt-image-2.5-flare, 2026-09-22.
  assert.equal(pricing.outputTokensFor({ modelId: 'gpt-image-2.5-flare', size: '1:1', quality: 'low' }), 196);
  assert.equal(pricing.outputTokensFor({ modelId: 'gpt-image-2.5-flare', size: '1:1', quality: 'max' }), 7024);
  assert.equal(pricing.outputTokensFor({ modelId: 'gpt-image-2.5-flare', size: '16:9', quality: 'low' }), 120);
  assert.equal(pricing.outputTokensFor({ modelId: 'gpt-image-2.5-flare', size: '21:9', quality: 'low' }), 105);
});

test('imageInputTokens follows the measured 16px grid capped at 1024', () => {
  assert.equal(pricing.imageInputTokens(300, 200), 247);
  assert.equal(pricing.imageInputTokens(400, 400), 625);
  assert.equal(pricing.imageInputTokens(512, 512), 1024);
  assert.equal(pricing.imageInputTokens(640, 480), 768);
  assert.equal(pricing.imageInputTokens(800, 600), 768);
  assert.equal(pricing.imageInputTokens(1024, 1024), 1024);
  assert.equal(pricing.imageInputTokens(0, 0), 0);
});

test('estimateForModel prices OpenAI models by tokens and returns null for retired providers', () => {
  // gpt-image-1 medium 1:1 = 1056 output tokens × $40/1M
  assert.equal(costs.estimateForModel('openai:gpt-image-1', 1, { quality: 'medium', size: '1:1' }), 0.04224);
  assert.equal(costs.estimateForModel('openai:gpt-image-1', 2, { quality: 'medium', size: '1:1' }), 0.08448);
  assert.equal(costs.estimateForModel('kie:nano-banana-pro', 1), null);
});

test('estimateForModel scales with quality', () => {
  const low = costs.estimateForModel('openai:gpt-image-1', 1, { quality: 'low', size: '1:1' });
  const medium = costs.estimateForModel('openai:gpt-image-1', 1, { quality: 'medium', size: '1:1' });
  const high = costs.estimateForModel('openai:gpt-image-1', 1, { quality: 'high', size: '1:1' });
  assert.equal(low, 0.01088);
  assert.equal(high, 0.1664);
  assert.ok(low < medium && medium < high);
});

test('estimateDetailed includes text input, image input and output tokens', () => {
  const est = costs.estimateDetailed('openai:gpt-image-2.5-flare', 1, {
    quality: 'low',
    size: '16:9',
    prompt: 'x'.repeat(70),
    sourceImage: { width: 512, height: 512 },
  });
  assert.equal(est.tokens.output, 120);
  assert.equal(est.tokens.imageIn, 1024);
  assert.ok(est.tokens.textIn >= 1);
  assert.deepEqual(est.rates, { textIn: 5, imageIn: 8, imageOut: 30 });
  const expected = (est.tokens.textIn * 5 + 1024 * 8 + 120 * 30) / 1e6;
  assert.equal(est.usd, +expected.toFixed(6));
  // Input is charged once, output once per image.
  const two = costs.estimateDetailed('openai:gpt-image-2.5-flare', 2, {
    quality: 'low', size: '16:9', prompt: 'x'.repeat(70), sourceImage: { width: 512, height: 512 },
  });
  assert.equal(two.tokens.outputTotal, 240);
  const expectedTwo = (two.tokens.textIn * 5 + 1024 * 8 + 240 * 30) / 1e6;
  assert.equal(two.usd, +expectedTwo.toFixed(6));
});

test('actualForModel computes the exact cost from the usage block', () => {
  const usage = {
    input_tokens: 1061,
    input_tokens_details: { text_tokens: 37, image_tokens: 1024 },
    output_tokens: 120,
    total_tokens: 1181,
  };
  const actual = costs.actualForModel('gpt-image-2.5-flare', usage);
  assert.equal(actual.usd, +((37 * 5 + 1024 * 8 + 120 * 30) / 1e6).toFixed(6));
  assert.deepEqual(actual.tokens, { textIn: 37, imageIn: 1024, output: 120, total: 1181 });
  assert.equal(costs.actualForModel('gpt-image-2.5-flare', null), null);
  assert.equal(costs.actualForModel('gpt-image-2.5-flare', { input_tokens: 0, output_tokens: 0 }), null);
});
