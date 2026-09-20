const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isLikelyMutationChannel,
  isTimeoutError,
  mutationOutcomeUnknown,
} = require('../main/util/rpcOutcome');

test('timed-out mutations are marked unknown while reads retain normal timeout handling', () => {
  assert.equal(isLikelyMutationChannel('products:list'), false);
  assert.equal(isLikelyMutationChannel('purchaseOrders:get'), false);
  assert.equal(isLikelyMutationChannel('products:update'), true);
  assert.equal(isLikelyMutationChannel('purchaseOrders:addLine'), true);
  assert.equal(isTimeoutError(Object.assign(new Error('deadline'), { name: 'TimeoutError' })), true);
  assert.equal(isTimeoutError(new Error('fetch failed')), false);

  const err = mutationOutcomeUnknown('products:update', new Error('deadline'));
  assert.equal(err.code, 'RPC_OUTCOME_UNKNOWN');
  assert.equal(err.channel, 'products:update');
  assert.match(err.message, /may still have completed/);
  assert.match(err.message, /refresh the current data before retrying/);
});

test('a delayed disposable mutation can commit after the client timeout', async () => {
  let committed = 0;
  const delayedWrite = new Promise((resolve) => {
    setTimeout(() => { committed += 1; resolve(); }, 25);
  });
  await assert.rejects(
    Promise.race([
      delayedWrite,
      new Promise((_, reject) => setTimeout(() => reject(new Error('client timeout')), 2)),
    ]),
    /client timeout/,
  );
  await delayedWrite;
  assert.equal(committed, 1);
});
