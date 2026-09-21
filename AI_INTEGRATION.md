# AI Studio — Provider integration notes

**OpenAI Images API only.** The kie.ai and fal.ai adapters were removed in the
OpenAI rework; this document is the implementation reference for
`main/ai/providers/openai.js`.

---

## OpenAI

- **Base URL:** `https://api.openai.com/v1`
- **Auth:** `Authorization: Bearer <API_KEY>`
- **The Images API is synchronous.** One request returns the image data — there
  is no submit/poll split and no provider task id. A task moves
  `queued → running → done/failed` in a single call (`main/ai/queueRunner.js`).
- Responses default to base64 (`b64_json`); we wrap them as
  `data:image/png;base64,…` data URLs and decode them straight to disk. No
  separate file-upload step is needed — source images travel in the multipart
  body of an edit request.

### Two endpoints

| Case | Endpoint | Body |
|---|---|---|
| Image edit (source image + model supports it) | `POST /v1/images/edits` | multipart: `model`, `prompt`, `n`, `size`, `quality`, `image` |
| Text-to-image (no source, or model has no source support) | `POST /v1/images/generations` | JSON: `model`, `prompt`, `n`, `size`, `quality` |

Response (either endpoint):

```json
{
  "created": 1710000000,
  "data": [ { "b64_json": "iVBORw0KG..." }, { "b64_json": "..." } ]
}
```

We read `data[].b64_json` (falling back to `data[].url` if a response ever
returns hosted URLs). An empty `data` array is treated as a failure, not a
success — the task is marked failed with a clear message.

### Dynamic model catalog

The picker is **not** a hard-coded list. `main/ipc/ai.js` calls
`GET /v1/models`, filters the result to image models
(`/^(gpt-image|dall-e)/i` via `imageModelsFrom`), and caches it per API key for
5 minutes. When no key is saved — or the live fetch fails — the built-in
fallback catalog in `main/ai/models.js` keeps the UI usable.

The API does not publish per-model size / quality / source support, so
`capabilitiesFor(modelId)` infers it from the id:

| Model family | Sizes (UI labels) | Provider size strings | Qualities | Source (edit)? | `n` max |
|---|---|---|---|---|---|
| `gpt-image-*` | `auto`, `1:1`, `3:2`, `2:3` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` | `auto`, `low`, `medium`, `high` | yes | 10 |
| `dall-e-3` | `1:1`, `7:4`, `4:7` | `1024x1024`, `1792x1024`, `1024x1792` | `standard`, `hd` | no | 1 |
| `dall-e-2` | `1:1` | `1024x1024` | `standard` | yes | 10 |

Unknown future `gpt-image-*` ids get the gpt-image capabilities — the safe
default. `sizeParamFor(modelId, ratio)` maps the UI label to the exact string
the model accepts.

### Test connection

`GET /v1/models` with the key. 401 → "OpenAI rejected the API key (401)"; a
successful call reports how many image models the account lists. See the
Settings → AI "Test" button (`ai:testOpenai`).

### Error messages

| HTTP | Message |
|---|---|
| 401 | `OpenAI rejected the API key (401)` |
| 429 | `OpenAI rate limit (429) — try again in a moment` |
| other | `OpenAI <label> failed: <provider message>` (label is `image edit` or `image generation`) |
| empty `data` | `OpenAI returned no image data` |

---

## Cost estimates (per generated image, USD)

Hard-coded ballparks for the confirmation dialog, in `main/ai/costs.js`.
`estimateForModel(model, count, quality)` applies a quality multiplier on top of
the default-quality row:

| Model | Default quality | Approx $/image |
|---|---|---:|
| `openai:gpt-image-*` | medium | $0.042 |
| `openai:dall-e-3` | standard | $0.040 |

Quality multipliers: `low` ×0.26, `medium` ×1, `high` ×4, `standard` ×1,
`hd` ×2, `auto` ×1. Refresh from
<https://platform.openai.com/docs/pricing> periodically.

---

## Queue runner behaviour

- Concurrency is a single global limit (`config.openaiConcurrency`, 1–10).
- A generation that is still in flight when the app quits is drained by
  `queueRunner.stop()` before the database closes.
- Because there is no provider-side task, **Repair re-submits the task** and
  **Queue fresh** clones it. A task interrupted mid-flight is marked failed at
  boot so Repair has a clear starting point.
- Cancelling a task while its request is in flight drops the result when it
  arrives rather than resurrecting a task the user stopped.
