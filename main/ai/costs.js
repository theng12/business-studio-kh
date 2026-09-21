/**
 * Ballpark per-image USD costs for OpenAI image models. Shown in the
 * AI Studio confirmation dialog. Refresh from OpenAI's pricing page
 * (https://platform.openai.com/docs/pricing) periodically — this table is
 * the single source of truth.
 *
 * The Images API bills per generated image, and the price depends on both
 * the model and the requested quality. `perImageUsd` below is the estimate
 * for the DEFAULT quality (medium for gpt-image, standard for dall-e-3);
 * `QUALITY_MULTIPLIER` scales it for the other settings so the confirmation
 * dialog stays honest when the user switches to low or high.
 *
 * Numbers are best-effort; the authoritative charge is on the OpenAI
 * billing dashboard.
 */

const DEFAULT_OPENAI_PER_IMAGE_USD = 0.042;

const COSTS = {
  // gpt-image-* bill ~$0.011 (low) / ~$0.042 (medium) / ~$0.167 (high)
  // at 1024×1024. Unknown gpt-image ids fall back to the medium row.
  'openai:gpt-image-1': { perImageUsd: 0.042 },
  // dall-e-3: $0.040 standard / $0.080 hd at 1024×1024.
  'openai:dall-e-3': { perImageUsd: 0.040 },
};

/** Multiplier applied to the per-image estimate for a quality setting. */
const QUALITY_MULTIPLIER = {
  auto: 1,       // model decides; assume the medium default
  low: 0.26,
  medium: 1,
  high: 4,
  standard: 1,
  hd: 2,
};

/** Per-image USD for a model + quality, or null for a non-OpenAI model key. */
function perImageUsdFor(modelId, quality) {
  const row = COSTS[modelId]
    ?? (String(modelId ?? '').startsWith('openai:') ? { perImageUsd: DEFAULT_OPENAI_PER_IMAGE_USD } : null);
  if (!row) return null;
  const mult = QUALITY_MULTIPLIER[String(quality ?? '').toLowerCase()] ?? 1;
  return row.perImageUsd * mult;
}

function estimateForModel(modelId, count = 1, quality) {
  const per = perImageUsdFor(modelId, quality);
  if (per == null) return null;
  const n = Number(count);
  return +(per * (Number.isFinite(n) && n > 0 ? n : 1)).toFixed(4);
}

module.exports = { COSTS, QUALITY_MULTIPLIER, DEFAULT_OPENAI_PER_IMAGE_USD, perImageUsdFor, estimateForModel };
