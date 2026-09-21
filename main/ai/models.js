/**
 * AI model catalog — OpenAI only.
 *
 * Since the OpenAI rework the catalog is DYNAMIC: `GET /v1/models` supplies
 * the image model ids the account can actually use, and `capabilitiesFor`
 * in `providers/openai.js` supplies per-model size / quality / source
 * support. A small built-in fallback list keeps the UI usable before a key
 * is entered (and when the live fetch fails), so the picker is never empty.
 *
 * The stable key shape is `<provider>:<modelId>` — e.g. `openai:gpt-image-1`.
 * The queue runner looks tasks up by that key; `byKey` also synthesizes an
 * entry for any `openai:*` id it has not seen, so a task queued against a
 * live-listed model still resolves after a catalog refresh.
 */

const openai = require('./providers/openai');

/** Used when no key is saved yet, or the live model list is unreachable. */
const FALLBACK_MODEL_IDS = ['gpt-image-1', 'dall-e-3'];

/** Pinned dated snapshot suffix, e.g. `gpt-image-2.5-flare-2026-09-08`. */
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/** "gpt-image-2.5-flare" → "GPT Image 2.5 Flare" */
function prettyName(modelId) {
  return String(modelId)
    .split(/[-_]/)
    .map((part) => {
      if (/^gpt$/i.test(part)) return 'GPT';
      if (/^dall$/i.test(part)) return 'DALL';
      if (/^e$/i.test(part)) return 'E';
      return part ? part.charAt(0).toUpperCase() + part.slice(1) : part;
    })
    .join(' ');
}

/** Build a catalog entry (the shape the renderer consumes) for one model id. */
function entryFor(modelId) {
  const caps = openai.capabilitiesFor(modelId);
  return {
    key: `openai:${modelId}`,
    provider: 'openai',
    modelId,
    displayName: prettyName(modelId),
    family: caps.supportsSource ? 'Image edit' : 'Text-to-image',
    description: caps.supportsSource
      ? 'OpenAI image model — accepts a reference image for edits.'
      : 'OpenAI image model — prompt-only generation.',
    supportsSource: caps.supportsSource,
    sizes: caps.sizes,
    qualities: caps.qualities,
    nMax: caps.nMax,
  };
}

/**
 * Catalog from a live `/v1/models` id list. Falls back to the built-in
 * list when the input yields no image models — so an account with an empty
 * (or oddly-filtered) list still gets a usable picker.
 */
function catalogFor(modelIds) {
  const ids = openai.imageModelsFrom(modelIds ?? []);
  const list = ids.length ? ids : openai.imageModelsFrom(FALLBACK_MODEL_IDS);
  // OpenAI's `/v1/models` lists both a moving alias and its pinned dated
  // snapshots (e.g. `gpt-image-2.5-flare` and
  // `gpt-image-2.5-flare-2026-09-08`). They are the same model, so hide the
  // pinned one when the alias is present — six useful entries instead of
  // nine cluttered ones. A snapshot with no matching alias is kept.
  const names = new Set(list);
  const visible = list.filter((id) => !(DATED_SNAPSHOT.test(id) && names.has(id.replace(DATED_SNAPSHOT, ''))));
  return visible.map(entryFor);
}

/** Built-in catalog (no key required). */
const MODELS = catalogFor(FALLBACK_MODEL_IDS);

/**
 * Look up a catalog entry by key (`openai:<id>`) or by a bare model id.
 * Returns null for anything that is not an OpenAI image model — which is
 * how tasks left over from the kie.ai / fal.ai era fail cleanly.
 */
function byKey(key) {
  if (!key) return null;
  const raw = String(key);
  const modelId = raw.startsWith('openai:') ? raw.slice('openai:'.length) : raw;
  if (!modelId) return null;
  const known = MODELS.find((m) => m.key === raw || m.modelId === modelId);
  if (known) return known;
  if (openai.isImageModelId(modelId)) return entryFor(modelId);
  return null;
}

function listByProvider(provider) {
  return MODELS.filter((m) => m.provider === provider);
}

module.exports = { MODELS, FALLBACK_MODEL_IDS, catalogFor, entryFor, byKey, listByProvider };
