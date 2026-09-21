/**
 * OpenAI image provider adapter — image-to-image (edits) and text-to-image
 * (generations). Replaces the kie.ai and fal.ai adapters.
 *
 * Design notes:
 *  - OpenAI's Images API is SYNCHRONOUS: one request returns the image bytes,
 *    so there is no submit/poll split and no provider task id.
 *  - The model list is fetched live from `GET /v1/models` and filtered to
 *    image models, so a model the account has (or a future rename) shows up
 *    without an app release. The API does not publish per-model size/quality
 *    support, so a small pattern map supplies that.
 *  - The UI passes human ratio labels ("1:1", "3:2"); `sizeParamFor` maps them
 *    to the exact strings each model accepts.
 *
 * Pure helpers are exported so they can be unit-tested with a mocked `fetch`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { fetchWithTimeout, TIMEOUT_SUBMIT, TIMEOUT_HEALTH } = require('../_fetchTimeouts');

const API_BASE = 'https://api.openai.com/v1';

/**
 * UI ratio label → the exact `size` string the API accepts.
 *
 * Every gpt-image model takes the three recommended sizes. The 2.5 models
 * additionally accept custom `WIDTHxHEIGHT` dimensions (multiples of 16,
 * aspect between 1:3 and 3:1, no edge over 3840, 655,360–8,294,400 px), which
 * is how the extra ratios below are offered. All of them were confirmed
 * accepted by the live API on 2026-09-22.
 */
const STANDARD_SIZES = {
  auto: 'auto',
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
};
const EXTENDED_SIZES = {
  ...STANDARD_SIZES,
  '4:3': '1280x960',
  '3:4': '960x1280',
  '16:9': '1536x864',
  '9:16': '864x1536',
  '7:4': '1792x1024',
  '4:7': '1024x1792',
  '21:9': '2016x864',
  '9:21': '864x2016',
};
const DALL_E_3_SIZES = { '1:1': '1024x1024', '7:4': '1792x1024', '4:7': '1024x1792' };

/** Model ids that are image models. */
function isImageModelId(id) {
  return /^(gpt-image|dall-e)/i.test(String(id ?? '').trim());
}

/** De-duplicated, sorted image model ids from a `/v1/models` list. */
function imageModelsFrom(ids) {
  return [...new Set((ids ?? []).map((id) => String(id ?? '').trim()).filter(isImageModelId))].sort();
}

/**
 * Per-model capabilities. The API does not expose these, so infer them from
 * the id. Unknown future `gpt-image-*` models get the current gpt-image
 * capabilities, which is the safe default.
 */
function capabilitiesFor(modelId) {
  const id = String(modelId ?? '').toLowerCase();
  if (id.includes('dall-e-3')) {
    return { sizes: Object.keys(DALL_E_3_SIZES), qualities: ['standard', 'hd'], supportsSource: false, nMax: 1, customSizes: false };
  }
  if (id.includes('dall-e-2')) {
    return { sizes: ['1:1'], qualities: ['standard'], supportsSource: true, nMax: 10, customSizes: false };
  }
  // gpt-image-2.5-* adds xhigh/max quality and custom dimensions.
  if (id.includes('gpt-image-2.5')) {
    return {
      sizes: Object.keys(EXTENDED_SIZES),
      qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
      supportsSource: true,
      nMax: 10,
      customSizes: true,
    };
  }
  return { sizes: Object.keys(STANDARD_SIZES), qualities: ['auto', 'low', 'medium', 'high'], supportsSource: true, nMax: 10, customSizes: false };
}

/** Map a UI ratio label to the exact size string the model accepts. */
function sizeParamFor(modelId, ratio) {
  const id = String(modelId ?? '').toLowerCase();
  const key = String(ratio ?? 'auto');
  if (id.includes('dall-e-3')) return DALL_E_3_SIZES[key] ?? '1024x1024';
  if (id.includes('dall-e-2')) return '1024x1024';
  if (id.includes('gpt-image-2.5')) return EXTENDED_SIZES[key] ?? 'auto';
  return STANDARD_SIZES[key] ?? 'auto';
}

/** Extract output URLs (data URLs for b64 payloads) from an Images response. */
function outputUrlsFrom(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((row) => {
      if (row?.b64_json) return `data:image/png;base64,${row.b64_json}`;
      if (row?.url) return row.url;
      return null;
    })
    .filter(Boolean);
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${String(apiKey ?? '').trim()}` };
}

function mimeFor(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function assertOk(res, body, label) {
  if (res.ok) return;
  if (res.status === 401) throw new Error('OpenAI rejected the API key (401)');
  if (res.status === 429) throw new Error('OpenAI rate limit (429) — try again in a moment');
  const message = body?.error?.message || body?._raw || `HTTP ${res.status}`;
  throw new Error(`OpenAI ${label} failed: ${message}`);
}

/** Fetch the account's image model ids. */
async function listModels(apiKey) {
  const res = await fetchWithTimeout(`${API_BASE}/models`, { method: 'GET', headers: authHeaders(apiKey) }, TIMEOUT_HEALTH);
  const body = await readJson(res);
  assertOk(res, body, 'model list');
  return imageModelsFrom((body.data ?? []).map((m) => m?.id));
}

/** Cheap health check for the Settings "Test" button. */
async function testConnection(apiKey) {
  const trimmed = String(apiKey ?? '').trim();
  if (!trimmed) throw new Error('API key is empty');
  const models = await listModels(trimmed);
  return {
    ok: true,
    hint: models.length
      ? `${models.length} image model${models.length === 1 ? '' : 's'} available`
      : 'reachable (no image models listed)',
  };
}

/**
 * Generate one image (image edit when a source is supplied and the model
 * supports it, otherwise text-to-image). Returns `{ outputUrls }` so the queue
 * runner can feed the existing download/gallery pipeline.
 */
async function generate(apiKey, { model, prompt, sourceImageAbs, options = {} } = {}) {
  if (!model) throw new Error('model required');
  const caps = capabilitiesFor(model);
  const size = sizeParamFor(model, options.size);
  const quality = options.quality && options.quality !== 'auto' ? options.quality : undefined;
  const n = Math.max(1, Math.min(caps.nMax, Number(options.n ?? options.numImages ?? options.nVariants ?? 1) || 1));
  const useEdits = caps.supportsSource && !!sourceImageAbs;

  let res;
  if (useEdits) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', String(prompt ?? ''));
    form.append('n', String(n));
    if (size) form.append('size', size);
    if (quality) form.append('quality', quality);
    const bytes = await fs.promises.readFile(sourceImageAbs);
    form.append('image', new Blob([bytes], { type: mimeFor(sourceImageAbs) }), path.basename(sourceImageAbs));
    res = await fetchWithTimeout(`${API_BASE}/images/edits`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: form,
    }, TIMEOUT_SUBMIT);
  } else {
    res = await fetchWithTimeout(`${API_BASE}/images/generations`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: String(prompt ?? ''), n, ...(size ? { size } : {}), ...(quality ? { quality } : {}) }),
    }, TIMEOUT_SUBMIT);
  }

  const body = await readJson(res);
  assertOk(res, body, useEdits ? 'image edit' : 'image generation');
  const outputUrls = outputUrlsFrom(body);
  if (outputUrls.length === 0) throw new Error('OpenAI returned no image data');
  // `usage` carries the real token counts (text/image in, image out), which
  // the queue runner turns into an exact cost. Older responses may omit it.
  return { outputUrls, usage: body?.usage ?? null };
}

module.exports = {
  listModels,
  testConnection,
  generate,
  isImageModelId,
  imageModelsFrom,
  capabilitiesFor,
  sizeParamFor,
  outputUrlsFrom,
  STANDARD_SIZES,
  EXTENDED_SIZES,
};
