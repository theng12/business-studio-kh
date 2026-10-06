/**
 * AI queue runner. Lives in the main process. Owns:
 *  - Concurrency control (a single OpenAI provider)
 *  - Calling the OpenAI Images API and turning the result into gallery rows
 *  - Downloading / decoding outputs into <dataDir>/ai-gallery/<sku>/
 *  - Emitting `ai:taskUpdate` events to the renderer so the UI stays live
 *
 * OpenAI's Images API is SYNCHRONOUS — one request returns the image bytes —
 * so there is no submit/poll split and no provider task id. A task moves
 * queued → running → done/failed in a single generation call. The runner is
 * awakened by ticks (every 2 s) and by `nudge()` from IPC (whenever a new
 * task is enqueued or settings change).
 */

const fs = require('node:fs');
const path = require('node:path');
const aiTasks = require('../db/aiTasks');
const aiGallery = require('../db/aiGallery');
const products = require('../db/products');
const { getDataDir } = require('../db');
const { slugify } = require('../util/slug');
const { byKey: modelByKey } = require('./models');
const openai = require('./providers/openai');
const aiCosts = require('./costs');

const TICK_MS = 2000;

let ctx = null;     // { getMainWindow, getConfig }
let timer = null;
let running = false; // a tick's scheduling loop is in progress
let enabled = false;
const pendingTicks = new Set();
const idleWaiters = new Set();

/* ids of tasks currently being generated in this process */
const inflight = new Set();
/* in-flight generation promises, so stop() can drain them before the DB closes */
const inflightPromises = new Set();

// v0.15.1: route AI events through the shared broadcast bus so they
// fan out to WebSocket clients in addition to the local renderer.
const { broadcast } = require('../events');

function emitTaskUpdate(task) {
  broadcast('ai:taskUpdate', task);
}

function emitGalleryAdded(entry) {
  broadcast('ai:galleryAdded', entry);
}

function getCfg() {
  try { return ctx?.getConfig?.() ?? {}; } catch { return {}; }
}

function concurrencyLimit() {
  const cfg = getCfg();
  return Math.max(1, Math.min(10, Number(cfg.openaiConcurrency) || 3));
}

function apiKeyFor() {
  const cfg = getCfg();
  return cfg.openaiApiKey;
}

/* ── Tick loop ─────────────────────────────────────────────── */

async function tick() {
  if (!enabled || running) return; // stopped, or a single tick already owns the runner
  running = true;
  try {
    const pending = aiTasks.listPendingForRunner();
    if (pending.length === 0) return;

    // Start queued tasks subject to the concurrency limit. `startOne`
    // reserves the slot synchronously and kicks off the (slow) generation
    // in the background, so several generations can genuinely overlap.
    const limit = concurrencyLimit();
    for (const t of pending) {
      if (!enabled) break;
      if (t.status !== 'queued') continue;
      if (inflight.size >= limit) break;
      inflight.add(t.id);
      startOne(t);
    }
  } catch (err) {
    process.stderr.write(`[ai/queue] tick error: ${err.message}\n`);
  } finally {
    running = false;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }
}

/* ── Start one task ────────────────────────────────────────── */

function resolveModel(task) {
  // Be lenient about legacy rows written before the key shape was
  // standardised: first try `task.model` as-is, then try it prefixed with
  // the task's provider.
  let model = modelByKey(task.model);
  if (!model && task.provider && !String(task.model || '').includes(':')) {
    model = modelByKey(`${task.provider}:${task.model}`);
  }
  return model;
}

function startOne(task) {
  const model = resolveModel(task);
  if (!model) {
    inflight.delete(task.id);
    handleFailure(task, `Unknown or unsupported model "${task.model}". This task predates the OpenAI rework — click Queue fresh to re-run it on an OpenAI model.`);
    return;
  }

  const apiKey = apiKeyFor();
  if (!apiKey) {
    inflight.delete(task.id);
    handleFailure(task, 'OpenAI API key not configured — add it in Settings → AI.');
    return;
  }

  // Persist the running state *after* reserving the slot. If the DB write
  // throws (file lock, etc.) release the slot or it leaks forever and
  // starves the provider.
  try {
    aiTasks.update(task.id, {
      status: 'running',
      attempts: (task.attempts ?? 0) + 1,
      startedAt: task.startedAt ?? Date.now(),
      errorMessage: null,
    });
  } catch (err) {
    inflight.delete(task.id);
    process.stderr.write(`[ai/queue] failed to mark task ${task.id} running: ${err.message}\n`);
    return;
  }
  emitTaskUpdate(aiTasks.get(task.id));

  const promise = generateFor(task, model, apiKey);
  inflightPromises.add(promise);
  void promise.finally(() => inflightPromises.delete(promise));
}

async function generateFor(task, model, apiKey) {
  try {
    let sourceImageAbs = null;
    if (model.supportsSource && task.sourceImagePath) {
      sourceImageAbs = absForRelative(task.sourceImagePath);
      if (!sourceImageAbs) throw new Error(`Source image missing on disk: ${task.sourceImagePath}`);
    }

    const { outputUrls, usage } = await openai.generate(apiKey, {
      model: model.modelId,
      prompt: task.prompt,
      sourceImageAbs,
      options: task.options ?? {},
    });
    // Exact cost from the provider's usage block (null on older responses,
    // in which case the pre-flight estimate remains the only number).
    const actual = usage ? aiCosts.actualForModel(model.modelId, usage) : null;
    await onDone(task, outputUrls, { usage, actualUsd: actual?.usd ?? null });
  } catch (err) {
    handleFailure(task, err.message);
  } finally {
    // Cancel stops accepting results; the synchronous provider request still
    // owns its slot until generation and any already-started filing settle.
    inflight.delete(task.id);
  }
}

/* ── Done: decode outputs, file in gallery ────────────────── */

async function onDone(task, outputUrls, billing = {}) {
  // The task may have been cancelled (or removed) while the request was in
  // flight — the API call cannot be aborted mid-flight, so drop the result
  // rather than resurrecting a task the user stopped.
  const current = aiTasks.get(task.id);
  if (!current) return;
  // A completed provider call can be charged even when its result is declined
  // or local filing fails. Repair reuses the id: retain all known charges.
  aiTasks.update(task.id, {
    costActual: billing.actualUsd == null ? current.costActual : (current.costActual ?? 0) + billing.actualUsd,
    usageJson: billing.usage ? JSON.stringify(billing.usage) : null,
  });
  emitTaskUpdate(aiTasks.get(task.id));
  if (!acceptsResults(task.id)) return;

  // Empty outputs after a "success" response would otherwise vanish
  // silently. Surface it as a Failed task so the user sees something
  // actionable instead of "Done" with nothing in the gallery.
  if (!Array.isArray(outputUrls) || outputUrls.length === 0) {
    aiTasks.update(task.id, {
      status: 'failed',
      errorMessage: 'OpenAI reported success but returned no image data. Repair submits a new paid generation.',
      completedAt: Date.now(),
    });
    emitTaskUpdate(aiTasks.get(task.id));
    return;
  }

  const failures = [];
  const warnings = [];
  let saved = 0;
  try {
    const product = task.productId ? products.get(task.productId) : null;
    // For per-product tasks, outputs land in `ai-gallery/<sku>/`. For
    // bulk-mode tasks (no productId), they go in `ai-gallery/_bulk/<yyyymmdd>/`
    // so the dir is browseable in Finder, scoped by date, and clearly
    // separate from per-product results.
    let relativeDir;
    if (product) {
      const skuSlug = slugify(product.sku || 'unassigned', 'unassigned');
      relativeDir = `ai-gallery/${skuSlug}`;
    } else {
      const d = new Date();
      const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      relativeDir = `ai-gallery/_bulk/${yyyymmdd}`;
    }
    const galleryDir = path.join(getDataDir(), relativeDir);
    await fs.promises.mkdir(galleryDir, { recursive: true });
    if (!acceptsResults(task.id)) return;

    /* Bulk-mode output naming + optional external export.
       - Naming: when the task has a sourceImagePath (always true for bulk
         mode), derive the output basename from the source file so the
         user can match results to inputs at a glance. Per-product mode
         keeps the existing `<task.id>-<n>.<ext>` naming since the source
         filename there is a content-addressed asset (`<sku>.jpg`), not
         a meaningful user-chosen name.
       - exportDir: if `task.options.exportDir` is an absolute path, also
         write a copy of each output there. The internal gallery copy
         remains so favorite/promote/preview still work; the external
         copy is purely a user-facing convenience. Failures are visible
         warnings and never discard the internal gallery result. */
    const exportDir = (!product && typeof task.options?.exportDir === 'string' && path.isAbsolute(task.options.exportDir))
      ? task.options.exportDir
      : null;
    if (exportDir) {
      try { await fs.promises.mkdir(exportDir, { recursive: true }); }
      catch (err) { warnings.push(`Export folder: ${err.message}`); }
      if (!acceptsResults(task.id)) return;
    }

    const sourceBasename = (!product && task.sourceImagePath)
      ? path.basename(task.sourceImagePath, path.extname(task.sourceImagePath))
      : null;

    let i = 0;
    for (const url of outputUrls) {
      if (!acceptsResults(task.id)) return;
      i += 1;
      try {
        const buf = await readImageBytes(url);
        if (!acceptsResults(task.id)) return;
        const ext = guessExt(url);

        // Pick a non-colliding filename inside galleryDir.
        //
        // The gallery name carries the task id, so it is never reused. It
        // used to be the bare source name (`shoe.png`), and a disk-only
        // collision check let a LATER generation take the path of one that
        // had been deleted (its file moved to the Trash) — the browser's
        // cache, keyed by URL, then showed the old picture for the new one.
        // The user-facing copy in `exportDir` keeps the plain source name.
        let name;
        let exportName = null;
        if (sourceBasename) {
          const suffix = outputUrls.length > 1 ? `-${i}` : '';
          exportName = `${sourceBasename}${suffix}${ext}`;
          name = galleryFileName(sourceBasename, suffix, task.id, ext);
          let n = 2;
          while (fs.existsSync(path.join(galleryDir, name))) {
            name = galleryFileName(sourceBasename, `${suffix}-${n}`, task.id, ext);
            n += 1;
            if (n > 9999) break; // sanity bound
          }
        } else {
          name = `${task.id}-${i}${ext}`;
          // A settled task can be explicitly submitted again through Repair.
          // Its earlier durable outputs must keep their original bytes.
          // ponytail: 9998 suffix candidates; wx fails safely at the ceiling.
          // Raise the bound if repeated explicit submissions reach that limit.
          let n = 2;
          while (fs.existsSync(path.join(galleryDir, name))) {
            name = `${task.id}-${i}-${n}${ext}`;
            n += 1;
            if (n > 9999) break;
          }
        }

        const abs = path.join(galleryDir, name);
        await fs.promises.writeFile(abs, buf, { flag: 'wx' });
        // A started write may complete after Cancel. Preserve its bytes, but
        // stop before publishing it or beginning another variant/attachment.
        if (!acceptsResults(task.id)) return;
        const relative = `${relativeDir}/${name}`;
        const entry = aiGallery.create({
          taskId: task.id,
          productId: task.productId ?? null,
          companyId: task.companyId,
          filepath: relative,
          prompt: task.prompt,
          provider: task.provider,
          model: task.model,
        });
        saved += 1;
        emitGalleryAdded(entry);
        if (!acceptsResults(task.id)) return;

        // Auto-attach. Two distinct modes:
        //   `autoPromoteAsMain`: add to product AND move to position 0 —
        //     original demotes to position 1 (first variant only, so
        //     multi-variant runs don't repeatedly stomp the main image).
        //   `autoAddToProduct`: append every variant at the END of the
        //     image list; original images untouched.
        // Promote-as-main implies add, so it's checked first.
        const wantPromote = !!task.options?.autoPromoteAsMain;
        const wantAdd     = wantPromote || !!task.options?.autoAddToProduct;
        const variantEligible = wantPromote ? (i === 1) : true;
        if (variantEligible && wantAdd && task.productId) {
          try {
            const productImages = require('../db/productImages');
            const productsDb = require('../db/products');
            const { image: addedImage } = await productImages.addFromSource(task.productId, abs, {
              originalFilepath: abs,
            });
            const relativePath = addedImage?.filepath;
            if (wantPromote && relativePath && acceptsResults(task.id)) {
              // By row id — the path can be renumbered while the add is awaited.
              productImages.setMainById(task.productId, addedImage.id);
            }
            aiGallery.markPromoted(entry.id);
            productsDb.recomputeProcessStatus(task.productId);
            // Bump product.updated_at so the Library grid + table thumbs
            // cache-bust (browser caches images by URL).
            productsDb.touchUpdated(task.productId);
            const events = require('../events');
            events.broadcast('catalog:changed', { kind: 'images', op: wantPromote ? 'promote' : 'add', id: task.productId });
            events.broadcast('catalog:changed', { kind: 'aiGallery', op: 'promote', id: entry.id, productId: task.productId });
          } catch (err) {
            warnings.push(`Image ${i} auto-${wantPromote ? 'promote' : 'add'}: ${err.message}`);
          }
        }

        // Best-effort copy to the user's export folder. Same filename
        // rules as the gallery copy, with its own collision suffix.
        if (!acceptsResults(task.id)) return;
        if (exportDir) {
          try {
            const baseExternal = exportName || name;
            let externalName = baseExternal;
            let n = 2;
            while (fs.existsSync(path.join(exportDir, externalName))) {
              const parsed = path.parse(baseExternal);
              externalName = `${parsed.name}-${n}${parsed.ext}`;
              n += 1;
              if (n > 9999) break;
            }
            await fs.promises.copyFile(abs, path.join(exportDir, externalName));
          } catch (err) {
            warnings.push(`Image ${i} export copy: ${err.message}`);
          }
        }
      } catch (err) {
        failures.push(`Image ${i}: ${err.message}`);
      }
    }

    if (!acceptsResults(task.id)) return;
    const messages = [...failures, ...warnings];
    aiTasks.update(task.id, {
      status: saved > 0 ? 'done' : 'failed',
      progress: saved / outputUrls.length,
      completedAt: Date.now(),
      errorMessage: messages.length ? `${saved} of ${outputUrls.length} images saved to gallery. ${messages.join('; ')}` : null,
    });
    emitTaskUpdate(aiTasks.get(task.id));
  } catch (err) {
    handleFailure(task, err.message);
  } finally {
    // Cancel preserves completed saves and any failures already observed.
    // Updating their message must never turn the task back into Done/Failed.
    const messages = [...failures, ...warnings];
    if (aiTasks.get(task.id)?.status === 'cancelled' && messages.length) {
      aiTasks.update(task.id, { errorMessage: `${saved} of ${outputUrls.length} images saved to gallery. ${messages.join('; ')}` });
      emitTaskUpdate(aiTasks.get(task.id));
    }
  }
}

function acceptsResults(taskId) {
  return aiTasks.get(taskId)?.status === 'running';
}

/* ── Failure ─────────────────────────────────────────────────
 * No automatic retries. The user kicks recovery off explicitly via Repair.
 */

function handleFailure(task, message) {
  const current = aiTasks.get(task.id);
  if (!current || current.status === 'cancelled') return;
  aiTasks.update(task.id, {
    status: 'failed',
    errorMessage: message,
    completedAt: Date.now(),
  });
  emitTaskUpdate(aiTasks.get(task.id));
}

/* ── Utilities ─────────────────────────────────────────────── */

function absForRelative(relative) {
  if (!relative) return null;
  const root = getDataDir();
  let abs;
  if (relative.startsWith('processed/') || relative.startsWith('ai-gallery/')) {
    abs = path.join(root, relative);
  } else {
    abs = path.join(root, 'assets', relative);
  }
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Bytes for one output. OpenAI returns base64 data URLs by default (no
 * hosting), so decode those locally; an ordinary http(s) URL is fetched
 * with the shared download timeout.
 */
async function readImageBytes(url) {
  const m = /^data:([^;,]*);base64,(.*)$/s.exec(String(url ?? ''));
  if (m) return Buffer.from(m[2], 'base64');
  const { fetchWithTimeout, TIMEOUT_DOWNLOAD } = require('./_fetchTimeouts');
  const res = await fetchWithTimeout(url, {}, TIMEOUT_DOWNLOAD);
  if (!res.ok) throw new Error(`download ${url} failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * A bulk gallery file name: the source's own name, the variant suffix, and the
 * first 8 characters of the task id, e.g. `shoe-1-3f2a9c1b.png`. The id part
 * is what keeps a new generation from ever landing on a deleted one's path.
 */
function galleryFileName(sourceBasename, suffix, taskId, ext) {
  const tag = String(taskId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return `${sourceBasename}${suffix}${tag ? `-${tag}` : ''}${ext}`;
}

function guessExt(url) {
  const m = String(url ?? '').match(/^data:(image\/[a-z+.-]+);/i);
  if (m) {
    const sub = m[1].slice('image/'.length);
    if (sub === 'jpeg' || sub === 'jpg') return '.jpg';
    if (sub === 'webp') return '.webp';
    if (sub === 'png') return '.png';
  }
  const ext = String(url ?? '').match(/\.(jpe?g|png|webp)(\?|$)/i);
  if (ext) return `.${ext[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return '.png';
}

/* ── Public API ────────────────────────────────────────────── */

function scheduleTick(delay) {
  if (!enabled) return;
  const pending = setTimeout(() => {
    pendingTicks.delete(pending);
    void tick();
  }, delay);
  pendingTicks.add(pending);
}

function start(_ctx) {
  if (_ctx) ctx = _ctx;
  enabled = true;
  if (timer) clearInterval(timer);
  for (const pending of pendingTicks) clearTimeout(pending);
  pendingTicks.clear();
  // Boot sweep: generations are synchronous and in-process, so any task
  // still marked 'running' at boot was interrupted (process killed
  // mid-request). Mark it failed so Repair has a clear place to start.
  interruptStaleTasks();
  timer = setInterval(tick, TICK_MS);
  scheduleTick(100);
}

async function stop() {
  enabled = false;
  if (timer) clearInterval(timer);
  timer = null;
  for (const pending of pendingTicks) clearTimeout(pending);
  pendingTicks.clear();
  if (running) await new Promise((resolve) => idleWaiters.add(resolve));
  // Drain in-flight generations so none writes to the DB after it closes.
  // `generateFor` swallows its own errors, so allSettled never rejects.
  if (inflightPromises.size) await Promise.allSettled([...inflightPromises]);
}

function nudge() {
  scheduleTick(50);
}

function interruptStaleTasks() {
  try {
    const all = aiTasks.listPendingForRunner();
    const now = Date.now();
    for (const t of all) {
      if (t.status === 'running' && !inflight.has(t.id)) {
        aiTasks.update(t.id, {
          status: 'failed',
          errorMessage: 'Interrupted before a result was saved. Repair and Queue fresh submit a new paid generation.',
          completedAt: now,
        });
        emitTaskUpdate(aiTasks.get(t.id));
      }
    }
  } catch (err) {
    process.stderr.write(`[ai/queue] interruptStaleTasks error: ${err.message}\n`);
  }
}

/**
 * Repair: re-queue a settled failed / cancelled task. OpenAI has no
 * provider-side task to re-poll, so a fresh submission is the only
 * recovery path.
 */
function repair(taskId) {
  const t = aiTasks.get(taskId);
  if (!t) return null;
  if (inflight.has(t.id)) throw new Error('This request is still active. Wait for it to settle before Repair; Repair submits a new paid generation.');
  if (t.status !== 'failed' && t.status !== 'cancelled') throw new Error('Repair is only available for settled failed or cancelled tasks; queued or running tasks must wait.');
  aiTasks.update(taskId, {
    status: 'queued',
    progress: 0,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
  });
  emitTaskUpdate(aiTasks.get(taskId));
  nudge();
  return aiTasks.get(taskId);
}

/**
 * Queue fresh: clone the task as a brand-new queued task. Used when the
 * original task is unrecoverable and the user wants a clean run.
 */
function queueFresh(taskId) {
  const t = aiTasks.get(taskId);
  if (!t) return null;
  const fresh = aiTasks.create({
    companyId: t.companyId,
    productId: t.productId,
    sourceImagePath: t.sourceImagePath,
    provider: t.provider,
    model: t.model,
    prompt: t.prompt,
    options: t.options,
    status: 'queued',
    costEstimate: t.costEstimate,
  });
  emitTaskUpdate(fresh);
  nudge();
  return fresh;
}

function cancel(taskId) {
  const t = aiTasks.get(taskId);
  if (!t) return null;
  if (t.status !== 'queued' && t.status !== 'running') return t;
  aiTasks.update(taskId, { status: 'cancelled', completedAt: Date.now() });
  emitTaskUpdate(aiTasks.get(taskId));
  return aiTasks.get(taskId);
}

module.exports = { start, stop, nudge, repair, queueFresh, cancel, galleryFileName };
