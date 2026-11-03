const test = require('node:test');
const assert = require('node:assert/strict');
const { getValidator } = require('../main/server/validators');
const { channelCapability, OPT_IN_CAPABILITIES, ADMIN_ONLY } = require('../main/util/capabilities');
const check = (channel, input) => getValidator(channel)(input);

test('Finance writes refuse forged authority, journal links and storage paths', () => {
  const draft = { id: 'draft', branchId: 'branch', amountMinor: 100, currency: 'USD' };
  assert.equal(check('finance:saveDraft', draft), true);
  for (const key of ['status', 'approvedByUserId', 'fxKhrPerUsd', 'journalEntryId', 'receipt', 'branchIds']) {
    assert.match(check('finance:saveDraft', { ...draft, [key]: 'forged' }), /not accepted/);
  }
  assert.match(check('finance:setReceipt', { expenseId: 'e', bytes: Buffer.from('x'), path: '/private' }), /not accepted/);
});

test('No-argument Finance RPC reads accept omitted or empty object arguments only', () => {
  for (const channel of ['finance:context', 'fx:getShared']) {
    assert.equal(check(channel, undefined), true);
    assert.equal(check(channel, {}), true);
    assert.match(check(channel, { companyId: 'forged' }), /no argument/);
    assert.match(check(channel, []), /no argument/);
  }
});

test('Finance validates safe minor amounts, report periods, bounds and reasons', () => {
  for (const amountMinor of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match(check('finance:saveDraft', { id: 'draft', amountMinor }), /whole number/);
  }
  assert.equal(check('finance:saveDraft', { id: 'draft', amountMinor: null }), true);
  assert.match(check('finance:reports', { month: '2026-13' }), /month/);
  assert.equal(check('finance:reports', { month: '2026-11' }), true);
  assert.match(check('finance:list', { pageSize: 100000 }), /pageSize/);
  assert.match(check('finance:reverse', { id: 'e', reason: ' ' }), /reason/);
  assert.equal(check('finance:reverse', { id: 'e', reason: 'Wrong account' }), true);
  assert.match(check('finance:setReceipt', { expenseId: 'e', bytes: Buffer.alloc(15 * 1024 * 1024 + 1) }), /max 15 MB/);
  assert.match(check('fx:setShared', { khrPerUsd: 99 }), /between 100 and 100000/);
  assert.match(check('finance:saveAccount', { id: 'x'.repeat(201) }), /id/);
  assert.match(check('finance:saveAccount', { openingDate: '2026-11-01' }), /openingMinor is required/);
  assert.match(check('finance:saveAccount', { openingMinor: 100 }), /openingDate is required/);
  assert.equal(check('finance:saveAccount', { id: 'stable-bank-id', openingMinor: 100, openingDate: '2026-11-01' }), true);
});

test('retire sends an ISO timestamp and the validator accepts it on both admin saves', () => {
  const now = new Date().toISOString();
  assert.equal(check('finance:saveAccount', { id: 'acct', archivedAt: now }), true);
  assert.equal(check('finance:saveAccount', { id: 'acct', archivedAt: null }), true);
  assert.match(check('finance:saveAccount', { id: 'acct', archivedAt: 12345 }), /archivedAt must be text/);
  assert.equal(check('finance:saveCategory', { id: 'cat', archivedAt: now }), true);
  assert.equal(check('finance:saveCategory', { id: 'cat', archivedAt: null }), true);
  assert.match(check('finance:saveCategory', { id: 'cat', archivedAt: 12345 }), /archivedAt must be text/);
});

test('Finance capabilities are opt-in and approval/setup cannot be granted to a recorder', () => {
  for (const cap of ['finance.record', 'finance.view']) assert.equal(OPT_IN_CAPABILITIES.has(cap), true);
  for (const action of ['approve', 'reject', 'reverse', 'saveAccount', 'saveCategory', 'updateSettings']) {
    assert.equal(channelCapability(`finance:${action}`), ADMIN_ONLY);
  }
  assert.equal(channelCapability('finance:submit'), 'finance.record');
  assert.equal(channelCapability('finance:reports'), 'finance.view');
  assert.equal(channelCapability('fx:setShared'), ADMIN_ONLY);
  assert.equal(channelCapability('fx:getShared'), 'baseline');
});
