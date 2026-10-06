const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const queueUrl = pathToFileURL(path.join(__dirname, '../renderer/lib/latestSaveQueue.js')).href;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('latest save queue gives the next queued draft the preceding acknowledged revision', async () => {
  const { createLatestSaveQueue } = await import(queueUrl);
  const first = deferred();
  const calls = [];
  const queue = createLatestSaveQueue({
    initialRevision: 10,
    persist(value, expectedUpdatedAt) {
      calls.push({ value, expectedUpdatedAt });
      return calls.length === 1 ? first.promise : Promise.resolve({ updatedAt: 12 });
    },
  });

  queue.enqueue('first');
  queue.enqueue('second');
  const flushed = queue.flush('second');
  assert.deepEqual(calls, [{ value: 'first', expectedUpdatedAt: 10 }]);

  first.resolve({ updatedAt: 11 });
  await tick();
  assert.deepEqual(calls, [
    { value: 'first', expectedUpdatedAt: 10 },
    { value: 'second', expectedUpdatedAt: 11 },
  ]);
  await flushed;
});

test('flush drains a newer dirty draft that appears while an older save is awaiting', async () => {
  const { createLatestSaveQueue } = await import(queueUrl);
  const gates = [deferred(), deferred()];
  const calls = [];
  let latest = { name: 'First' };
  let dirty = true;
  const queue = createLatestSaveQueue({
    initialRevision: 1,
    persist(value, expectedUpdatedAt) {
      calls.push({ value, expectedUpdatedAt });
      return gates[calls.length - 1].promise;
    },
    onSuccess(row, value) {
      if (latest === value) dirty = false;
    },
  });

  queue.enqueue(latest);
  const flushed = queue.flush(() => dirty ? latest : null);
  latest = { name: 'Second' };
  gates[0].resolve({ updatedAt: 2 });
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].value.name, 'Second');
  assert.equal(calls[1].expectedUpdatedAt, 2);

  gates[1].resolve({ updatedAt: 3 });
  await flushed;
  assert.equal(dirty, false);
});

test('failed flush rejects without forgetting the recoverable latest draft', async () => {
  const { createLatestSaveQueue } = await import(queueUrl);
  const conflict = new Error('CONFLICT|{"kind":"catalogProject"}');
  let attempts = 0;
  const draft = { name: 'Local draft' };
  const queue = createLatestSaveQueue({
    initialRevision: 1,
    persist(value, expectedUpdatedAt) {
      attempts += 1;
      if (attempts === 1) return Promise.reject(conflict);
      assert.equal(value, draft);
      assert.equal(expectedUpdatedAt, 2);
      return Promise.resolve({ updatedAt: 3 });
    },
  });

  await assert.rejects(queue.flush(() => draft), conflict);
  queue.setRevision(2);
  await queue.flush(() => attempts < 2 ? draft : null);
  assert.equal(attempts, 2);
});

test('a static flush target is not replayed after newer queued work', async () => {
  const { createLatestSaveQueue } = await import(queueUrl);
  const first = deferred();
  const writes = [];
  const queue = createLatestSaveQueue({
    persist: async (value) => {
      writes.push(value);
      if (writes.length === 1) await first.promise;
      return { updatedAt: writes.length };
    },
  });
  queue.enqueue('first');
  const flushed = queue.flush('first');
  queue.enqueue('second');
  first.resolve();
  await flushed;
  assert.deepEqual(writes, ['first', 'second']);
});

test('simultaneous static flush targets settle without alternating', async () => {
  const { createLatestSaveQueue } = await import(queueUrl);
  const first = deferred();
  const writes = [];
  const queue = createLatestSaveQueue({
    persist: async (value) => {
      writes.push(value);
      if (writes.length === 1) await first.promise;
      return { updatedAt: writes.length };
    },
  });
  queue.enqueue('first');
  const firstFlush = queue.flush('first');
  const secondFlush = queue.flush('second');
  first.resolve();
  await Promise.all([firstFlush, secondFlush]);
  assert.deepEqual(writes, ['first', 'second']);
});

test('a live flush replaces an intermediate queued snapshot and can cancel it after acknowledgment', async () => {
  const { createLatestSaveQueue } = await import(queueUrl);
  for (const final of [null, { name: 'Final' }]) {
    const first = deferred(); const writes = []; const active = { name: 'Active' }; const intermediate = { name: 'Intermediate' }; let latest = active;
    const queue = createLatestSaveQueue({
      persist: async (value) => { writes.push(value); if (writes.length === 1) await first.promise; return { updatedAt: writes.length }; },
      onSuccess: (_row, value) => { if (latest === value || latest === active) latest = null; },
    });
    const saving = queue.flush(() => latest);
    latest = intermediate; queue.enqueue(intermediate);
    latest = final === null ? active : final;
    first.resolve(); await saving;
    assert.deepEqual(writes, final === null ? [active] : [active, final]);
  }
});
