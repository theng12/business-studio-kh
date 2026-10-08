/**
 * Fuel phone page (`/f`): the offline outbox in webclient/fuel/logic.js.
 *
 * What it must guarantee (docs/PEOPLE_AND_FUEL_PLAN.md §5.3, HANDOFF "never let
 * a client give up on, and then repeat, a long write"):
 *   - a record is stored on the phone BEFORE it is sent;
 *   - every resend carries the SAME client_ref, made once at the first save;
 *   - only network / busy failures retry by themselves; a refusal waits for a person;
 *   - a refused token stops sending and keeps everything;
 *   - the phone sends how long a record waited, never a clock time;
 *   - a delivery's dips are sent first, each with its own client_ref, and a
 *     resend never makes a second dip.
 * Plain `npm test` — the store and the transport are fakes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../webclient/fuel/logic.js');

function netErr() { const e = new Error('offline'); e.network = true; return e; }
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

/** A fake server that saves by client_ref, like main/db/fuelRecords.js. */
function fakeServer() {
  const saved = new Map();
  const calls = [];
  let mode = 'ok';
  let failNext = null;
  let n = 0;
  return {
    calls, saved,
    setMode(m) { mode = m; },
    failOnce(err) { failNext = err; },
    send(channel, args) {
      calls.push({ channel, args: JSON.parse(JSON.stringify(args)) });
      if (failNext) { const e = failNext; failNext = null; return Promise.reject(e); }
      if (mode === 'offline') return Promise.reject(netErr());
      if (mode === 'lost-answer') {
        // Saved on the server, but the answer never reached the phone.
        if (!saved.has(args.clientRef)) saved.set(args.clientRef, { id: `r${++n}`, args });
        mode = 'ok';
        return Promise.reject(netErr());
      }
      if (mode === 'auth') return Promise.reject(httpErr(401, 'Invalid or missing token'));
      const key = args.clientRef || `${channel}:${args.id}`;
      const dup = saved.has(key);
      if (!dup) saved.set(key, { id: `r${++n}`, args });
      const rec = { id: saved.get(key).id, at: 1 };
      const kind = channel === 'fuel:recordDip' ? 'dip' : channel === 'fuel:recordDelivery' ? 'delivery' : 'fill';
      return Promise.resolve({ [kind]: rec, duplicate: dup });
    },
  };
}

function setup(over = {}) {
  const server = fakeServer();
  let now = 1_000_000;
  const store = L.memoryStore();
  const ctxState = { userId: 'u1', companyId: 'c1' };
  const box = L.createOutbox({
    store,
    send: (ch, a) => server.send(ch, a),
    ctx: () => ({ ...ctxState, now }),
    encode: (buf) => ({ __bin: true, b64: Buffer.from(buf).toString('base64') }),
    ...over,
  });
  return { server, store, box, ctxState, tick(ms) { now += ms; }, now: () => now };
}

const fill = (ref, extra = {}) => ({
  channel: 'fuel:recordFill', clientRef: ref, companyId: 'c1', userId: 'u1',
  args: { kind: 'warehouse_tank', locationId: 'tank', assetId: 'truck', litres: 40 },
  photos: [{ kind: 'meter', data: new Uint8Array([1, 2, 3]).buffer }],
  ...extra,
});

test('online: sent at once, removed from the phone, answer handed back', async () => {
  const { server, box } = setup();
  const out = await box.add(fill('f:dev:0001'));
  assert.equal(out.status, 'sent');
  assert.equal(out.result.fill.id, 'r1');
  assert.equal((await box.list()).length, 0);
  const sent = server.calls[0].args;
  assert.equal(sent.clientRef, 'f:dev:0001');
  assert.equal(sent.source, 'phone');
  assert.equal(sent.companyId, 'c1');
  assert.equal(sent.queuedForMs, 0);
  assert.equal(sent.at, undefined, 'the phone never sends a clock time');
  assert.deepEqual(sent.photos, [{ kind: 'meter', bytes: { __bin: true, b64: 'AQID' } }]);
});

test('offline: kept on the phone, retried later with the SAME client_ref and the wait it had', async () => {
  const { server, box, tick } = setup();
  server.setMode('offline');
  const out = await box.add(fill('f:dev:0002'));
  assert.equal(out.status, 'queued');
  await box.flush();
  let items = await box.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'waiting');
  assert.equal(items[0].attempts, 1);
  assert.equal(items[0].nextAt - items[0].savedAt, L.RETRY_DELAYS_MS[0]);
  assert.equal(L.counts(items, { userId: 'u1', companyId: 'c1' }).waiting, 1);

  // Not due yet: nothing is sent.
  tick(1000);
  await box.flush();
  assert.equal(server.calls.length, 1);

  server.setMode('ok');
  tick(10 * 60 * 1000);
  await box.flush();
  assert.equal(server.calls.length, 2);
  assert.equal(server.calls[1].args.clientRef, 'f:dev:0002');
  assert.equal(server.calls[1].args.queuedForMs, 10 * 60 * 1000 + 1000);
  items = await box.list();
  assert.equal(items.length, 0);
  assert.equal(server.saved.size, 1);
});

test('a lost answer: the resend is the same request, and the server answers "already saved"', async () => {
  const { server, box, tick } = setup();
  server.setMode('lost-answer');
  const first = await box.add(fill('f:dev:0003'));
  assert.equal(first.status, 'queued');
  await box.flush(); // let the running pass finish
  tick(60_000);
  await box.flush();
  assert.equal(server.saved.size, 1, 'one record on the server, not two');
  assert.equal(server.calls[0].args.clientRef, server.calls[1].args.clientRef);
});

test('backoff grows and is capped', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(L.retryDelay), [5000, 15000, 30000, 60000, 120000, 120000, 120000]);
});

test('classifyError: only network, timeouts, busy and rate limit retry by themselves', () => {
  assert.equal(L.classifyError(netErr()), 'retry');
  assert.equal(L.classifyError(Object.assign(new Error('x'), { timedOut: true })), 'retry');
  assert.equal(L.classifyError(httpErr(429, 'Rate limit')), 'retry');
  assert.equal(L.classifyError(httpErr(503, 'maintenance')), 'retry');
  assert.equal(L.classifyError(httpErr(500, 'database is locked')), 'retry');
  assert.equal(L.classifyError(httpErr(401, 'Invalid or missing token')), 'auth');
  assert.equal(L.classifyError(httpErr(400, 'Bad request: litres must be a number')), 'fail');
  assert.equal(L.classifyError(httpErr(403, 'Your account doesn\'t have permission')), 'fail');
  assert.equal(L.classifyError(httpErr(500, 'Enter both pump meter readings')), 'fail');
});

test('a refusal is not retried by itself; "Send now" retries with the same client_ref', async () => {
  const { server, box, tick } = setup();
  server.failOnce(httpErr(500, 'Pick the vehicle or machine that was filled'));
  const out = await box.add(fill('f:dev:0004'));
  assert.equal(out.status, 'failed');
  await box.flush();
  let items = await box.list();
  assert.equal(items[0].state, 'failed');
  assert.match(items[0].lastError, /Pick the vehicle/);
  tick(60 * 60 * 1000);
  await box.flush();
  assert.equal(server.calls.length, 1, 'never resent without a person');
  await box.retry('f:dev:0004');
  assert.equal(server.calls.length, 2);
  assert.equal(server.calls[1].args.clientRef, 'f:dev:0004');
  items = await box.list();
  assert.equal(items.length, 0);
});

test('a refused token stops sending and keeps every record', async () => {
  const { server, box, tick } = setup();
  server.setMode('offline');
  await box.add(fill('f:dev:0005'));
  await box.flush();
  await box.add(fill('f:dev:0006'));
  await box.flush();
  server.setMode('auth');
  tick(10 * 60 * 1000);
  const r = await box.flush();
  assert.equal(r, 'auth');
  const before = server.calls.length;
  const third = await box.add(fill('f:dev:0007'));
  assert.equal(third.status, 'auth');
  assert.equal(server.calls.length, before, 'nothing is sent while the token is refused');
  assert.equal((await box.list()).length, 3);
  // Paired again: everything goes, in save order.
  server.setMode('ok');
  box.unblock();
  tick(10 * 60 * 1000);
  await box.flush();
  assert.equal((await box.list()).length, 0);
  assert.equal(server.saved.size, 3);
});

test('records for another account or company wait; they are never sent with this token', async () => {
  const { server, box, ctxState, tick } = setup();
  server.setMode('offline');
  await box.add(fill('f:dev:0008'));
  await box.flush();
  ctxState.userId = 'u2';
  server.setMode('ok');
  tick(10 * 60 * 1000);
  await box.flush();
  assert.equal(server.saved.size, 0);
  const c = L.counts(await box.list(), { userId: 'u2', companyId: 'c1' });
  assert.deepEqual({ waiting: c.waiting, elsewhere: c.elsewhere }, { waiting: 0, elsewhere: 1 });
  ctxState.userId = 'u1';
  await box.flush();
  assert.equal(server.saved.size, 1);
});

test('a record left "sending" by a closed page is sent again (same client_ref)', async () => {
  const { server, store, box } = setup();
  const item = L.makeItem({ ...fill('f:dev:0009'), now: 1 });
  await store.put({ ...item, state: 'sending' });
  await box.flush();
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].args.clientRef, 'f:dev:0009');
});

test('a save during a running send is picked up by the same pass', async () => {
  const { server, box } = setup();
  const a = box.add(fill('f:dev:0010'));
  const b = box.add(fill('f:dev:0011'));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 'sent');
  assert.equal(rb.status, 'sent');
  assert.equal(server.saved.size, 2);
});

test('delivery with dips: the dips go first with their own client_refs; a resend makes no second dip', async () => {
  const { server, box, tick } = setup();
  server.failOnce(null);
  const delivery = {
    channel: 'fuel:recordDelivery', clientRef: 'f:dev:del1', companyId: 'c1', userId: 'u1',
    args: { locationId: 'tank', litresInvoiced: 2000 },
    photos: [{ kind: 'invoice', data: new Uint8Array([9]).buffer }],
    takenAt: 1_000_000,
    pre: [
      { channel: 'fuel:recordDip', clientRef: 'f:dev:dipB', as: 'dipBeforeId', takenAt: 1_000_000 - 30 * 60 * 1000, args: { locationId: 'tank', dipCm: 120 }, photos: [] },
      { channel: 'fuel:recordDip', clientRef: 'f:dev:dipA', as: 'dipAfterId', takenAt: 1_000_000, args: { locationId: 'tank', dipCm: 98 }, photos: [] },
    ],
  };
  // The first dip saves, then the connection drops before the second.
  let calls = 0;
  const realSend = server.send;
  server.send = (ch, args) => {
    calls += 1;
    if (calls === 2) return Promise.reject(netErr());
    return realSend(ch, args);
  };
  const out = await box.add(delivery);
  assert.equal(out.status, 'queued');
  await box.flush();
  const kept = (await box.list())[0];
  assert.deepEqual(Object.keys(kept.preDone), ['dipBeforeId'], 'the saved dip is remembered');
  tick(60_000);
  await box.flush();
  const dips = server.calls.filter((c) => c.channel === 'fuel:recordDip');
  // (The dropped attempt never reached the server.) dipB is not sent a second time.
  assert.deepEqual(dips.map((c) => c.args.clientRef), ['f:dev:dipB', 'f:dev:dipA']);
  assert.equal(dips[0].args.queuedForMs, 30 * 60 * 1000, 'the dip before is dated when it was taken');
  const sent = server.calls.find((c) => c.channel === 'fuel:recordDelivery').args;
  assert.equal(sent.dipBeforeId, 'r1');
  assert.equal(sent.dipAfterId, 'r2');
  assert.equal(sent.clientRef, 'f:dev:del1');
  assert.equal([...server.saved.keys()].filter((k) => k.includes('dip')).length, 2);
  assert.equal((await box.list()).length, 0);
});

test('a farm receipt is keyed by the transfer and carries no client_ref', () => {
  const item = L.makeItem({ channel: 'fuel:receiveTransfer', clientRef: 'f:dev:recv1', args: { id: 't1', litresReceived: 195 }, now: 5 });
  const args = L.sendArgs(item, 65, null);
  assert.equal(args.clientRef, undefined);
  assert.equal(args.companyId, undefined);
  assert.equal(args.id, 't1');
  assert.equal(args.queuedForMs, 60);
  assert.throws(() => L.makeItem({ channel: 'fuel:receiveTransfer', clientRef: 'f:dev:recv2', args: {}, now: 1 }), /transfer id/);
});

test('only record-saving channels may be queued, and only with a client_ref', () => {
  assert.throws(() => L.makeItem({ channel: 'fuel:voidMyRecord', clientRef: 'f:dev:x1', args: {}, now: 1 }), /record-saving/);
  assert.throws(() => L.makeItem({ channel: 'fuel:recordFill', clientRef: '', args: {}, now: 1 }), /client_ref/);
});
