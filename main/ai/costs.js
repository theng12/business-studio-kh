/**
 * Cost estimator facade. The real model lives in `pricing.js` (rates +
 * measured token counts); this module is the small surface the IPC layer and
 * the queue runner use.
 *
 * `estimateForModel` returns the pre-flight USD estimate (a number, stored on
 * the task row). `estimateDetailed` returns the breakdown the confirmation
 * dialog shows. `actualForModel` computes the exact cost from the API's
 * `usage` block once a generation finishes.
 */

const pricing = require('./pricing');

/** Accept either `{ quality }` or a bare quality string (legacy shape). */
function normalizeOptions(options) {
  if (typeof options === 'string') return { quality: options };
  return options && typeof options === 'object' ? options : {};
}

/** Pre-flight USD estimate, e.g. `estimateForModel('openai:gpt-image-2.5-flare', 2, { quality, size, prompt, sourceImage })`. */
function estimateForModel(modelId, count = 1, options = {}) {
  return pricing.estimateCost({ modelId, count, ...normalizeOptions(options) }).usd;
}

/** Pre-flight estimate with the token breakdown + rates. */
function estimateDetailed(modelId, count = 1, options = {}) {
  return pricing.estimateCost({ modelId, count, ...normalizeOptions(options) });
}

/** Exact cost from an OpenAI `usage` block, or null when usage is absent. */
function actualForModel(modelId, usage) {
  return pricing.actualCostFromUsage(usage, modelId);
}

module.exports = {
  estimateForModel,
  estimateDetailed,
  actualForModel,
  ratesFor: pricing.ratesFor,
  outputTokensFor: pricing.outputTokensFor,
  imageInputTokens: pricing.imageInputTokens,
  textInputTokens: pricing.textInputTokens,
};
