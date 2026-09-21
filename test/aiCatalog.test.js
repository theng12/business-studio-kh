/**
 * Catalog + cost tests for the OpenAI-only AI rework.
 *
 * These are pure (no network, no key): `main/ai/models.js` builds its
 * entries from `capabilitiesFor`, and `main/ai/costs.js` is a lookup table
 * with a quality multiplier. Both feed the AI Studio picker and the
 * confirmation dialog's price estimate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../main/ai/models');
const costs = require('../main/ai/costs');

test('the built-in catalog is OpenAI-only and non-empty', () => {
  assert.ok(models.MODELS.length > 0);
  for (const m of models.MODELS) {
    assert.equal(m.provider, 'openai');
    assert.ok(m.key.startsWith('openai:'));
    assert.equal(m.key, `openai:${m.modelId}`);
  }
  assert.deepEqual(models.MODELS.map((m) => m.modelId).sort(), ['dall-e-3', 'gpt-image-1']);
});

test('catalogFor builds capability-driven entries from a live model list', () => {
  const catalog = models.catalogFor(['gpt-4o', 'gpt-image-1', 'gpt-image-2.5-flare', 'dall-e-3']);
  assert.deepEqual(catalog.map((m) => m.modelId), ['dall-e-3', 'gpt-image-1', 'gpt-image-2.5-flare']);

  const flare = catalog.find((m) => m.modelId === 'gpt-image-2.5-flare');
  assert.equal(flare.key, 'openai:gpt-image-2.5-flare');
  assert.equal(flare.displayName, 'GPT Image 2.5 Flare');
  assert.equal(flare.supportsSource, true);
  assert.equal(flare.nMax, 10);
  assert.deepEqual(flare.sizes, ['auto', '1:1', '3:2', '2:3']);
  assert.ok(flare.qualities.includes('high'));

  const dalle = catalog.find((m) => m.modelId === 'dall-e-3');
  assert.equal(dalle.supportsSource, false);
  assert.equal(dalle.nMax, 1);
  assert.deepEqual(dalle.qualities, ['standard', 'hd']);
});

test('catalogFor falls back to the built-in list when the live list has no image models', () => {
  assert.deepEqual(models.catalogFor([]).map((m) => m.key), models.MODELS.map((m) => m.key));
  assert.deepEqual(models.catalogFor(['gpt-4o', 'text-embedding-3']).map((m) => m.key), models.MODELS.map((m) => m.key));
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

test('estimateForModel prices known models and falls back for unknown openai ids', () => {
  assert.equal(costs.estimateForModel('openai:gpt-image-1', 2), 0.084);
  assert.equal(costs.estimateForModel('openai:dall-e-3', 1), 0.04);
  // Unknown but still OpenAI → default row, not null.
  assert.equal(costs.estimateForModel('openai:gpt-image-9', 1), costs.DEFAULT_OPENAI_PER_IMAGE_USD);
  // Retired providers → no estimate.
  assert.equal(costs.estimateForModel('kie:nano-banana-pro', 1), null);
});

test('estimateForModel scales with quality', () => {
  const low = costs.estimateForModel('openai:gpt-image-1', 1, 'low');
  const medium = costs.estimateForModel('openai:gpt-image-1', 1, 'medium');
  const high = costs.estimateForModel('openai:gpt-image-1', 1, 'high');
  assert.ok(low < medium);
  assert.ok(high > medium);
  // dall-e-3 hd is twice standard.
  assert.equal(costs.estimateForModel('openai:dall-e-3', 1, 'hd'), 0.08);
  assert.equal(costs.estimateForModel('openai:dall-e-3', 1, 'standard'), 0.04);
  // An unknown quality falls back to the default multiplier (×1).
  assert.equal(costs.estimateForModel('openai:gpt-image-1', 1, 'nonsense'), 0.042);
});

test('estimateForModel tolerates a missing / invalid count', () => {
  assert.equal(costs.estimateForModel('openai:gpt-image-1'), 0.042);
  assert.equal(costs.estimateForModel('openai:gpt-image-1', 0), 0.042);
  assert.equal(costs.estimateForModel('openai:gpt-image-1', NaN), 0.042);
});
