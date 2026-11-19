const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const image = 'data:image/png;base64,cGljdHVyZQ==';
const response = (count = 1) => ({ outputUrls: Array(count).fill(image), usage: { output_tokens: 20 } });
async function flush() { for (let i = 0; i < 25; i += 1) await Promise.resolve(); }

function harness(options = {}) {
  const tasks = new Map(); const gallery = []; const calls = []; const writes = []; const attachments = [];
  const timers = []; const events = []; const logs = []; const mainSets = [];
  /* The update hold (main/updateHold.js): paused stops claims, ids are the real in-flight set. */
  const hold = { paused: false, ids: [] };
  const aiTasks = {
    get: (id) => { const t = tasks.get(id); return t ? { ...t, galleryCount: gallery.filter((g) => g.taskId === id).length } : null; },
    update: (id, patch) => { if (tasks.has(id)) Object.assign(tasks.get(id), patch); return aiTasks.get(id); },
    create: (input) => { const t = { id: `task-${tasks.size + 1}`, status: 'queued', companyId: 'company', model: 'openai:gpt-image-2', provider: 'openai', prompt: 'Test', options: {}, ...input }; tasks.set(t.id, t); return aiTasks.get(t.id); },
    listPendingForRunner: () => [...tasks.values()].filter((t) => ['queued', 'running'].includes(t.status)).map((t) => ({ ...t })),
  };
  const stubs = {
    'node:fs': { existsSync: (file) => writes.includes(file), promises: {
      mkdir: async (...args) => options.mkdir?.(...args),
      writeFile: async (...args) => { await options.write?.(...args); writes.push(args[0]); },
      copyFile: async (...args) => options.copy?.(...args),
    } },
    'node:path': path,
    '../db/aiTasks': aiTasks,
    '../db/aiGallery': {
      create: (input) => { options.gallery?.(input); const g = { id: `gallery-${gallery.length + 1}`, ...input }; gallery.push(g); options.afterGallery?.(g); return g; },
      markPromoted: (id) => { gallery.find((g) => g.id === id).promotedToProduct = true; },
    },
    '../db/products': { get: (id) => id ? { id, sku: 'TEST' } : null, recomputeProcessStatus: () => {}, touchUpdated: () => {} },
    '../db/productImages': { addFromSource: async (...args) => { attachments.push(args); return options.attach ? options.attach(...args) : { image: { id: 'image', filepath: 'product.png' } }; }, setMainById: (...args) => mainSets.push(args) },
    '../db': { getDataDir: () => '/synthetic-data' },
    '../util/slug': { slugify: (s) => s.toLowerCase() },
    './models': { byKey: () => ({ modelId: 'gpt-image-2', supportsSource: false }) },
    './providers/openai': { generate: () => { const d = deferred(); calls.push(d); return d.promise; } },
    './costs': { actualForModel: () => ({ usd: 0.25 }) },
    './_fetchTimeouts': { fetchWithTimeout: async () => { throw new Error('download failed (403)'); }, TIMEOUT_DOWNLOAD: 1 },
    '../events': { broadcast: (...args) => events.push(args) },
    '../updateHold': { isPaused: () => hold.paused, inflightIds: () => [...hold.ids] },
  };
  const sandbox = { require: (name) => { assert.ok(name in stubs, `unexpected dependency ${name}`); return stubs[name]; }, module: { exports: {} }, Buffer, Date: options.Date || Date,
    process: { stderr: { write: (line) => logs.push(line) } },
    setTimeout: (fn) => { timers.push(fn); return fn; }, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
  };
  vm.runInNewContext(fs.readFileSync(process.env.AI_RUNNER_FIXTURE || path.join(__dirname, '../main/ai/queueRunner.js'), 'utf8'), sandbox);
  const runner = sandbox.module.exports;
  const runTick = async () => { const fn = timers.shift(); assert.ok(fn, 'scheduled tick'); fn(); await flush(); };
  runner.start({ getConfig: () => ({ openaiConcurrency: 1, openaiApiKey: 'synthetic-key' }) });
  return { runner, aiTasks, tasks, gallery, calls, writes, attachments, events, logs, mainSets, runTick, hold };
}

test('cancelled provider retains its slot, refuses live Repair, and late success records charge without accepting results', async () => {
  const h = harness(); const a = h.aiTasks.create({}); const b = h.aiTasks.create({});
  await h.runTick(); assert.equal(h.calls.length, 1);
  h.runner.cancel(a.id);
  assert.throws(() => h.runner.repair(a.id), /still.*active|still.*running/i);
  h.runner.nudge(); await h.runTick(); assert.equal(h.calls.length, 1);
  h.calls[0].resolve(response()); await flush();
  assert.equal(h.aiTasks.get(a.id).status, 'cancelled'); assert.equal(h.aiTasks.get(a.id).costActual, 0.25);
  assert.equal(h.gallery.length, 0); assert.equal(h.writes.length, 0);
  h.runner.nudge(); await h.runTick(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(response()); await h.runner.stop(); assert.equal(h.aiTasks.get(b.id).status, 'done');
});

test('late provider failure cannot resurrect a cancelled task', async () => {
  const h = harness(); const a = h.aiTasks.create({}); await h.runTick(); h.runner.cancel(a.id);
  h.calls[0].reject(new Error('late network failure')); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).status, 'cancelled');
});

test('Repair after settlement resubmits once and accumulates known charges', async () => {
  const h = harness(); const a = h.aiTasks.create({}); await h.runTick(); h.runner.cancel(a.id);
  h.calls[0].resolve(response()); await flush();
  h.runner.repair(a.id); assert.throws(() => h.runner.repair(a.id), /queued|running/i);
  await h.runTick(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(response()); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).costActual, 0.5); assert.equal(h.gallery.length, 1);
});

test('cancellation during a file write preserves bytes and suppresses gallery and following variants', async () => {
  let h; h = harness({ write: async () => h.runner.cancel('task-1') });
  const a = h.aiTasks.create({ productId: 'product', options: { autoAddToProduct: true } }); await h.runTick();
  h.calls[0].resolve(response(2)); await h.runner.stop();
  assert.equal(h.writes.length, 1); assert.equal(h.gallery.length, 0); assert.equal(h.attachments.length, 0);
  assert.equal(h.aiTasks.get(a.id).status, 'cancelled');
});

test('cancellation after durable gallery save preserves entry and suppresses attachment', async () => {
  let h; h = harness({ afterGallery: () => h.runner.cancel('task-1') });
  const a = h.aiTasks.create({ productId: 'product', options: { autoAddToProduct: true } }); await h.runTick();
  h.calls[0].resolve(response(2)); await h.runner.stop();
  assert.equal(h.gallery.length, 1); assert.equal(h.writes.length, 1); assert.equal(h.attachments.length, 0);
  assert.equal(h.aiTasks.get(a.id).status, 'cancelled');
});

test('zero durable results fail with actual cost and the filing error', async () => {
  const h = harness({ write: async () => { throw new Error('ENOSPC disk full'); } });
  const a = h.aiTasks.create({}); await h.runTick(); h.calls[0].resolve(response(2)); await h.runner.stop();
  const result = h.aiTasks.get(a.id); assert.equal(result.status, 'failed'); assert.equal(result.costActual, 0.25);
  assert.match(result.errorMessage, /0.*2.*saved/i); assert.match(result.errorMessage, /ENOSPC/); assert.equal(h.gallery.length, 0);
});

test('gallery insert failure is a failed result while keeping the already written file', async () => {
  const h = harness({ gallery: () => { throw new Error('database locked'); } });
  const a = h.aiTasks.create({}); await h.runTick(); h.calls[0].resolve(response()); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).status, 'failed'); assert.match(h.aiTasks.get(a.id).errorMessage, /database locked/);
  assert.equal(h.writes.length, 1); assert.equal(h.gallery.length, 0);
});

test('partial durable results remain Done with a visible warning and actual charge', async () => {
  let writes = 0; const h = harness({ write: async () => { if (++writes === 2) throw new Error('ENOSPC disk full'); } });
  const a = h.aiTasks.create({}); await h.runTick(); h.calls[0].resolve(response(2)); await h.runner.stop();
  const result = h.aiTasks.get(a.id); assert.equal(result.status, 'done'); assert.equal(result.costActual, 0.25);
  assert.match(result.errorMessage, /1.*2.*saved/i); assert.match(result.errorMessage, /ENOSPC/); assert.equal(h.gallery.length, 1);
});

test('image cap failure is visible while preserving the durable gallery output', async () => {
  const h = harness({ attach: async () => { throw new Error('Image cap reached (50)'); } });
  const a = h.aiTasks.create({ productId: 'product', options: { autoAddToProduct: true } }); await h.runTick();
  h.calls[0].resolve(response()); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).status, 'done'); assert.equal(h.gallery.length, 1);
  assert.match(h.aiTasks.get(a.id).errorMessage, /Image cap reached/);
});

test('export-copy failure is visible while preserving the durable gallery output', async () => {
  const h = harness({ copy: async () => { throw new Error('EACCES denied'); } });
  const a = h.aiTasks.create({ options: { exportDir: '/synthetic-export' } }); await h.runTick();
  h.calls[0].resolve(response()); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).status, 'done'); assert.equal(h.gallery.length, 1);
  assert.match(h.aiTasks.get(a.id).errorMessage, /export.*EACCES/i);
});

test('provider empty output records usage and fails; happy path remains Done', async () => {
  for (const count of [0, 1]) {
    const h = harness(); const a = h.aiTasks.create({}); await h.runTick(); h.calls[0].resolve(response(count)); await h.runner.stop();
    const result = h.aiTasks.get(a.id); assert.equal(result.status, count ? 'done' : 'failed'); assert.equal(result.costActual, 0.25);
    assert.equal(h.gallery.length, count); if (count) assert.equal(result.errorMessage, null);
  }
});


test('a cancelled task keeps its slot until an already-started write settles', async () => {
  const writing = deferred(); const h = harness({ write: () => writing.promise });
  const a = h.aiTasks.create({}); h.aiTasks.create({}); await h.runTick();
  h.calls[0].resolve(response()); await flush(); h.runner.cancel(a.id);
  h.runner.nudge(); await h.runTick(); assert.equal(h.calls.length, 1);
  writing.resolve(); await flush(); h.runner.nudge(); await h.runTick(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(response()); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).status, 'cancelled'); assert.equal(h.gallery.filter((g) => g.taskId === a.id).length, 0);
});

test('removal while awaiting a result stops all filing without releasing the live slot early', async () => {
  const h = harness(); const a = h.aiTasks.create({}); h.aiTasks.create({}); await h.runTick();
  h.tasks.delete(a.id); h.runner.nudge(); await h.runTick(); assert.equal(h.calls.length, 1);
  h.calls[0].resolve(response()); await flush(); assert.equal(h.writes.length, 0);
  h.runner.nudge(); await h.runTick(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(response()); await h.runner.stop();
});

test('Repair preserves earlier per-product result bytes under a different filename', async () => {
  let h; let galleries = 0;
  h = harness({ afterGallery: () => { if (++galleries === 1) h.runner.cancel('task-1'); } });
  const a = h.aiTasks.create({ productId: 'product' }); await h.runTick(); h.calls[0].resolve(response()); await flush();
  assert.equal(h.aiTasks.get(a.id).status, 'cancelled'); assert.equal(h.gallery.length, 1);
  h.runner.repair(a.id); await h.runTick(); h.calls[1].resolve(response()); await h.runner.stop();
  assert.equal(h.gallery.length, 2);
  assert.deepEqual(h.writes, ['/synthetic-data/ai-gallery/test/task-1-1.png', '/synthetic-data/ai-gallery/test/task-1-1-2.png']);
});

test('missing usage preserves earlier known charges without presenting an invented charge', async () => {
  const h = harness(); const a = h.aiTasks.create({ costActual: 0.25 }); await h.runTick();
  h.calls[0].resolve({ outputUrls: [image], usage: null }); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).costActual, 0.25);
  assert.equal(h.aiTasks.get(a.id).usageJson, null);
});

test('a failed output download counts as unsaved and keeps the provider charge visible', async () => {
  const h = harness(); const a = h.aiTasks.create({}); await h.runTick();
  h.calls[0].resolve({ outputUrls: [image, 'https://synthetic.test/result.png'], usage: { output_tokens: 20 } }); await h.runner.stop();
  assert.equal(h.gallery.length, 1); assert.equal(h.aiTasks.get(a.id).status, 'done');
  assert.match(h.aiTasks.get(a.id).errorMessage, /1 of 2.*download failed/); assert.equal(h.aiTasks.get(a.id).costActual, 0.25);
});

test('completed tasks cannot be cancelled or repaired into a new paid submission', async () => {
  const h = harness(); const a = h.aiTasks.create({}); await h.runTick(); h.calls[0].resolve(response()); await h.runner.stop();
  assert.equal(h.runner.cancel(a.id).status, 'done'); assert.throws(() => h.runner.repair(a.id), /failed or cancelled/);
});

test('cancellation preserves already observed follow-on warnings alongside saved results', async () => {
  let h; let writes = 0;
  h = harness({
    write: async () => { if (++writes === 2) h.runner.cancel('task-1'); },
    attach: async () => { throw new Error('Image cap reached (50)'); },
  });
  const a = h.aiTasks.create({ productId: 'product', options: { autoAddToProduct: true } }); await h.runTick();
  h.calls[0].resolve(response(2)); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).status, 'cancelled'); assert.equal(h.gallery.length, 1);
  assert.match(h.aiTasks.get(a.id).errorMessage, /1 of 2.*Image cap reached/);
});


test('an attachment already started may finish after Cancel, without a later main reorder or variant', async () => {
  const attaching = deferred(); const h = harness({ attach: () => attaching.promise });
  const a = h.aiTasks.create({ productId: 'product', options: { autoPromoteAsMain: true } }); await h.runTick();
  h.calls[0].resolve(response(2)); await flush(); assert.equal(h.attachments.length, 1);
  h.runner.cancel(a.id); attaching.resolve({ image: { id: 'attached-image', filepath: 'attached.png' } }); await h.runner.stop();
  assert.equal(h.aiTasks.get(a.id).status, 'cancelled'); assert.equal(h.gallery.length, 1);
  assert.equal(h.gallery[0].promotedToProduct, true); assert.equal(h.mainSets.length, 0); assert.equal(h.writes.length, 1);
});

test('an update hold closes the claim path, says why, and hands the work back when it ends', async () => {
  const h = harness();
  const a = h.aiTasks.create({});
  h.hold.paused = true;
  h.runner.nudge(); await h.runTick();
  assert.equal(h.calls.length, 0, 'nothing starts while the app is held for an update');
  assert.equal(h.aiTasks.get(a.id).status, 'queued', 'the task keeps the queued row the next start finds');
  assert.ok(h.logs.some((line) => /new work is paused for an update: 1 queued task/.test(line)),
    'the refusal says why in plain words');
  h.hold.paused = false;
  h.runner.nudge(); await h.runTick();
  assert.equal(h.calls.length, 1, 'dispatch resumes with no operator step');
  assert.deepEqual([...h.runner.inflightIds()], [a.id], 'the hold reads the real in-flight id while a generation runs');
  h.calls[0].resolve(response()); await h.runner.stop();
  assert.deepEqual([...h.runner.inflightIds()], []);
  assert.equal(h.aiTasks.get(a.id).status, 'done');
});

/* ── Rate limit: the provider declining capacity is not a failed generation ── */

function fakeClock(start = 1_760_000_000_000) {
  let now = start;
  class FakeDate extends Date { static now() { return now; } }
  return { Date: FakeDate, advance: (ms) => { now += ms; } };
}
const refusal = (retryAfterMs) => Object.assign(new Error('OpenAI rate limit (429) — try again in a moment'), { rateLimited: true, retryAfterMs });

test('a 429 keeps the task queued, pauses claims for the provider window, then resumes by itself', async () => {
  const clock = fakeClock();
  const h = harness({ Date: clock.Date });
  const a = h.aiTasks.create({});
  await h.runTick();
  assert.equal(h.calls.length, 1);
  h.calls[0].reject(refusal(20_000)); await flush();
  const row = h.aiTasks.get(a.id);
  assert.equal(row.status, 'queued', 'a refusal returns to the queue instead of emptying it into Failed');
  assert.equal(row.attempts, 0, 'a refused request never ran, so it is not an attempt');
  assert.match(row.errorMessage, /slow down.*20 s/);

  h.runner.nudge(); await h.runTick();
  assert.equal(h.calls.length, 1, 'no claim inside the window the provider named');
  clock.advance(20_001);
  h.runner.nudge(); await h.runTick();
  assert.equal(h.calls.length, 2, 'the same task resumes after the window, with no operator step');
  h.calls[1].resolve(response()); await flush();
  assert.equal(h.aiTasks.get(a.id).status, 'done');
  assert.equal(h.aiTasks.get(a.id).attempts, 1);
});

test('rate-limit retries are bounded: a key that keeps refusing ends in one plain failed row', async () => {
  const clock = fakeClock();
  const h = harness({ Date: clock.Date });
  const a = h.aiTasks.create({});
  for (let i = 1; i <= 6; i += 1) {
    if (i > 1) { clock.advance(10_001); h.runner.nudge(); }
    await h.runTick();
    assert.equal(h.calls.length, i);
    h.calls[i - 1].reject(refusal(10_000)); await flush();
    if (i <= 5) assert.equal(h.aiTasks.get(a.id).status, 'queued', `refusal ${i} stays queued`);
  }
  const row = h.aiTasks.get(a.id);
  assert.equal(row.status, 'failed', 'past the ceiling the row settles visibly');
  assert.match(row.errorMessage, /still refused after 5 automatic retries/);
  assert.match(row.errorMessage, /rate limit/);
});
