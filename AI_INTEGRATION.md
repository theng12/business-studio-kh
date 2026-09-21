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
| `gpt-image-2.5-*` | 13 ratios: `auto`, `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `7:4`, `4:7`, `21:9`, `9:21` | `auto` + `WxH` (e.g. `1536x864`, `2016x864`) | `auto`, `low`, `medium`, `high`, `xhigh`, `max` | yes | 10 |
| `gpt-image-2` / `1.5` / `1` / `1-mini` | `auto`, `1:1`, `3:2`, `2:3` | `auto`, `1024x1024`, `1536x1024`, `1024x1536` | `auto`, `low`, `medium`, `high` | yes | 10 |
| `dall-e-3` / `dall-e-2` | retained for safety only — OpenAI removed both on 2026-05-12 | — | — | — | — |

Only the 2.5 models accept custom dimensions (multiples of 16, aspect 1:3–3:1,
no edge over 3840, 655,360–8,294,400 px), which is how the extra ratios are
offered. Unknown future `gpt-image-*` ids get the standard gpt-image
capabilities — the safe default. `sizeParamFor(modelId, ratio)` maps the UI
label to the exact string the model accepts.

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

## Cost estimation — token-based

OpenAI bills an image request as **tokens**, not per image:

```
 text input tokens   (the prompt)
+ image input tokens (the reference image, edits only)
+ image output tokens (the generated image, × n)
```

`main/ai/pricing.js` is the single source of truth. The response carries the
real counts in its `usage` block, so the app shows an exact cost after a run
and only *estimates* before it.

### Token rates (USD per 1M tokens, standard tier)

Source: <https://developers.openai.com/api/docs/pricing>. Verified 2026-09-22.

| Model | Text input | Image input | Image output |
|---|---:|---:|---:|
| `gpt-image-2.5-sunburst` / `-flare` | $5.00 | $8.00 | $30.00 |
| `gpt-image-2` | $5.00 | $8.00 | $30.00 |
| `gpt-image-1.5` | $5.00 | $8.00 | $32.00 |
| `gpt-image-1-mini` | $2.00 | $2.50 | $8.00 |
| `gpt-image-1` | $5.00 | $10.00 | $40.00 |

### Output tokens per image

`gpt-image-1` counts are published by OpenAI (272 / 1056 / 4160 at 1024×1024
for low / medium / high; 408 / 1584 / 6240 at 1536×1024). The **2.5 models
are not published**, so they were measured on 2026-09-22 and stored in
`LOW_OUTPUT_TOKENS` + `QUALITY_MULTIPLIER`:

| Ratio | low | medium | high | xhigh | max |
|---|---:|---:|---:|---:|---:|
| `1:1` (1024×1024) | 196 | 439 | 1756 | 3122 | 7024 |
| `3:2` / `2:3` | 158 | 354 | 1416 | 2517 | 5662 |
| `4:3` / `3:4` | 155 | 347 | 1389 | 2469 | 5555 |
| `7:4` / `4:7` | 139 | 311 | 1245 | 2214 | 4981 |
| `16:9` / `9:16` | 120 | 269 | 1075 | 1911 | 4300 |
| `21:9` / `9:21` | 105 | 235 | 941 | 1673 | 3763 |

Non-square images are *cheaper* than square, so a pixel-area formula would be
wrong — this is a measured per-ratio table. Non-1:1 quality cells apply the
square-derived multipliers and are therefore approximate; the exact figure
comes from `usage` after the run.

### Input image tokens

Measured: `300×200 → 247`, `400×400 → 625`, `512×512 → 1024`, `640×480 → 768`,
`800×600 → 768`, `1024×1024 → 1024`. That fits a **16px token grid capped at
a 32×32 (1024-token) budget** — images already under budget are charged their
native grid, larger ones are downscaled proportionally into it. So a large
product photo costs the same as a 512×512 one. See `imageInputTokens()`.

Text input tokens are estimated at ~3.5 chars/token (`textInputTokens()`);
text is the cheapest input, so the approximation is invisible in the total.

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
