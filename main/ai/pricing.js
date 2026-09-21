/**
 * OpenAI image pricing — the single source of truth for the cost estimator.
 *
 * Rates are per 1,000,000 tokens from the official pricing page
 * (https://developers.openai.com/api/docs/pricing, image-generation section,
 * standard tier). They were verified live against the owner's account on
 * 2026-09-22 for gpt-image-2.5-flare / -sunburst and gpt-image-2.
 *
 * OpenAI bills an image request as:
 *    text input tokens      — the prompt
 *  + image input tokens     — the reference image(s), edits only
 *  + image output tokens    — the generated image, multiplied by `n`
 * and returns the real counts in the response's `usage` field, so
 * `actualCostFromUsage()` is exact while `estimateCost()` is a close
 * pre-flight estimate.
 *
 * The output-token counts below were MEASURED against the live API (see the
 * numbers in the comments), because OpenAI publishes rates for the 2.5 models
 * but not their output-token counts ("The GPT Image 2 calculator does not
 * estimate GPT Image 2.5 token consumption"). gpt-image-1's counts are the
 * ones OpenAI does publish.
 */

const MILLION = 1_000_000;

/* ── Token rates (USD per 1M tokens) ───────────────────────── */

/**
 * Most specific first — `gpt-image-1-mini` must match before `gpt-image-1`,
 * and `gpt-image-1.5` before `gpt-image-1`.
 */
const RATE_TABLE = [
  { match: /^gpt-image-2\.5/, textIn: 5, imageIn: 8, imageOut: 30 },
  { match: /^gpt-image-2/,   textIn: 5, imageIn: 8, imageOut: 30 },
  { match: /^gpt-image-1\.5/, textIn: 5, imageIn: 8, imageOut: 32 },
  { match: /^gpt-image-1-mini/, textIn: 2, imageIn: 2.5, imageOut: 8 },
  { match: /^gpt-image-1/,   textIn: 5, imageIn: 10, imageOut: 40 },
  { match: /^chatgpt-image/, textIn: 5, imageIn: 8, imageOut: 32 },
];

/** Fallback for an unknown OpenAI image model (current flagship rates). */
const DEFAULT_RATES = { textIn: 5, imageIn: 8, imageOut: 30 };

/** True for an OpenAI image model id (with or without the `openai:` prefix). */
function isKnownImageModel(modelId) {
  return /^(openai:)?(gpt-image|chatgpt-image|dall-e)/i.test(String(modelId ?? '').trim());
}

/** Token rates for a model, or null when the id is not an OpenAI image model. */
function ratesFor(modelId) {
  if (!isKnownImageModel(modelId)) return null;
  const id = String(modelId ?? '').replace(/^openai:/, '').toLowerCase();
  const row = RATE_TABLE.find((r) => r.match.test(id));
  return row ? { textIn: row.textIn, imageIn: row.imageIn, imageOut: row.imageOut } : { ...DEFAULT_RATES };
}

/* ── Output tokens per generated image ─────────────────────── */

/**
 * Low-quality output tokens per aspect ratio, measured on gpt-image-2.5-flare
 * (2026-09-22). Non-square images cost FEWER tokens than square — a 1536×1024
 * output is 158 tokens against 196 for 1024×1024 — so a pixel-area formula
 * would be wrong; this is a measured per-ratio table.
 */
const LOW_OUTPUT_TOKENS = {
  '1:1': 196,
  '3:2': 158, '2:3': 158,
  '4:3': 155, '3:4': 155,
  '16:9': 120, '9:16': 120,
  '7:4': 139, '4:7': 139,
  '21:9': 105, '9:21': 105,
};
const DEFAULT_LOW_TOKENS = 158;

/**
 * Quality multipliers over the low-quality baseline, measured at 1024×1024 on
 * gpt-image-2.5-flare: low 196, medium 439, high 1756, xhigh 3122, max 7024.
 * `auto` is the model's own choice; assume medium.
 */
const QUALITY_MULTIPLIER = {
  low: 1,
  medium: 439 / 196,
  high: 1756 / 196,
  xhigh: 3122 / 196,
  max: 7024 / 196,
  auto: 439 / 196,
};

/** gpt-image-1's output tokens are published by OpenAI (unlike the 2.5 models). */
const GPT_IMAGE_1_TOKENS = {
  '1:1': { low: 272, medium: 1056, high: 4160 },
  '3:2': { low: 408, medium: 1584, high: 6240 },
  '2:3': { low: 408, medium: 1584, high: 6240 },
};

/** Output tokens for ONE generated image at `size` + `quality`. */
function outputTokensFor({ modelId, size = '1:1', quality = 'auto' } = {}) {
  const id = String(modelId ?? '').replace(/^openai:/, '').toLowerCase();
  const q = String(quality ?? 'auto').toLowerCase();

  if (/^gpt-image-1$/.test(id)) {
    const row = GPT_IMAGE_1_TOKENS[size] ?? GPT_IMAGE_1_TOKENS['1:1'];
    return row[q] ?? row.low;
  }

  const base = LOW_OUTPUT_TOKENS[size] ?? DEFAULT_LOW_TOKENS;
  const mult = QUALITY_MULTIPLIER[q] ?? QUALITY_MULTIPLIER.auto;
  return Math.round(base * mult);
}

/* ── Input tokens ──────────────────────────────────────────── */

/**
 * Image input tokens for one reference image. Measured on
 * gpt-image-2.5-flare (2026-09-22):
 *   300×200 → 247   400×400 → 625   512×512 → 1024
 *   640×480 → 768   800×600 → 768   1024×1024 → 1024
 *
 * That fits a 16px token grid capped at a 32×32 (1024-token) budget: images
 * already under the budget are charged their native grid; larger ones are
 * downscaled proportionally into it. This is why a big product photo costs
 * the same as a 512×512 one.
 */
function imageInputTokens(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  let gw = Math.ceil(w / 16);
  let gh = Math.ceil(h / 16);
  if (gw <= 32 && gh <= 32) return gw * gh;
  const scale = Math.min(32 / gw, 32 / gh);
  gw = Math.max(1, Math.floor(gw * scale));
  gh = Math.max(1, Math.floor(gh * scale));
  return gw * gh;
}

/**
 * Rough prompt token count. Measured samples landed at ~2.8–3.8 chars/token;
 * text is the cheapest input ($5/1M ≈ $0.0001 for a 20-token prompt), so the
 * approximation is invisible in the total.
 */
function textInputTokens(prompt) {
  const chars = String(prompt ?? '').length;
  if (chars === 0) return 0;
  return Math.max(1, Math.ceil(chars / 3.5));
}

/* ── Cost ──────────────────────────────────────────────────── */

/**
 * Pre-flight estimate. Input tokens are charged once per request (the prompt
 * and reference image are sent once); output tokens are charged per generated
 * image, so they scale with `count`.
 *
 * `sourceImage` is `{ width, height }` of the reference image, or null/absent
 * for a prompt-only generation.
 * Returns `{ usd, tokens: { textIn, imageIn, output }, rates }`.
 */
function estimateCost({ modelId, count = 1, quality = 'auto', size = '1:1', prompt = '', sourceImage = null } = {}) {
  const rates = ratesFor(modelId);
  if (!rates) return { usd: null, tokens: null, rates: null };
  const n = Math.max(1, Math.round(Number(count) || 1));
  const textIn = textInputTokens(prompt);
  const imageIn = sourceImage ? imageInputTokens(sourceImage.width, sourceImage.height) : 0;
  const output = outputTokensFor({ modelId, size, quality });

  const usd = (
    textIn * rates.textIn
    + imageIn * rates.imageIn
    + n * output * rates.imageOut
  ) / MILLION;

  return {
    usd: +usd.toFixed(6),
    tokens: { textIn, imageIn, output, outputTotal: output * n, count: n },
    rates,
  };
}

/**
 * Exact cost from the API response's `usage` block. Returns null when the
 * response carried no usage (older API shape), so callers can fall back to
 * the estimate.
 */
function actualCostFromUsage(usage, modelId) {
  if (!usage || typeof usage !== 'object') return null;
  const rates = ratesFor(modelId);
  if (!rates) return null;
  const textIn = Number(usage.input_tokens_details?.text_tokens) || 0;
  const imageIn = Number(usage.input_tokens_details?.image_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  if (!textIn && !imageIn && !output) return null;

  const usd = (textIn * rates.textIn + imageIn * rates.imageIn + output * rates.imageOut) / MILLION;
  return {
    usd: +usd.toFixed(6),
    tokens: { textIn, imageIn, output, total: Number(usage.total_tokens) || textIn + imageIn + output },
    rates,
  };
}

module.exports = {
  RATE_TABLE,
  DEFAULT_RATES,
  LOW_OUTPUT_TOKENS,
  QUALITY_MULTIPLIER,
  ratesFor,
  outputTokensFor,
  imageInputTokens,
  textInputTokens,
  estimateCost,
  actualCostFromUsage,
};
