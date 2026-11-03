const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getValidator } = require('../main/server/validators');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'renderer/modules/Finance/ExpenseEditor.jsx'), 'utf8');
function bridge() {
  let api;
  const sent = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main/preload.js'), 'utf8'), {
    process: { argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async (channel, payload) => {
        assert.equal(getValidator(channel)(payload), true, `Invalid ${channel} payload`);
        sent.push({ channel, payload });
        return { id: 'expense-id', status: 'posted' };
      } },
    }),
  });
  return { api, sent };
}
function editorAction(name, next, api) {
  const code = source.slice(source.indexOf(`  async function ${name}(`), source.indexOf(`  async function ${next}(`));
  return new Function('window', 'confirm', `
    const rowRef = { current: { id: 'expense-id' } };
    const setRow = () => {}, setReason = () => {}, addToast = () => {}, onChanged = () => {};
    const setReceiptBusy = () => {}, setViewReceipt = () => {}, errText = e => e.message;
    ${code}
    return ${name};
  `)({ api }, async () => true);
}

test('the first autosave includes the displayed default date and currency', async () => {
  const { api, sent } = bridge();
  const code = source.slice(source.indexOf('  const write = useCallback('), source.indexOf('  const autosave ='));
  const write = new Function('window', `
    const rowRef = { current: null }, clientIdRef = { current: 'stable-draft' }, initialDateRef = { current: '2026-11-04' }, initialBranchRef = { current: 'solo-branch' };
    const USD = 'USD', useCallback = fn => fn, setRow = () => {}, onChanged = () => {}, isConflict = () => false;
    ${code}
    return write;
  `)({ api });
  await write({ memo: 'First edit, date untouched' });
  assert.equal(sent[0].payload.expenseDate, '2026-11-04');
  assert.equal(sent[0].payload.currency, 'USD');
  assert.equal(sent[0].payload.branchId, 'solo-branch', 'the single-branch default rides on the first autosave');
  assert.equal(sent[0].payload.id, 'stable-draft');
});

test('editor reason actions reach real preload validators with the expense id and reason', async () => {
  const { api, sent } = bridge();
  const action = editorAction('runReason', 'pickReceipt', api);
  for (const kind of ['cancel', 'reject', 'reverse']) await action(kind, 'Correction reason');
  assert.deepEqual(sent.map(v => v.channel), ['finance:cancel', 'finance:reject', 'finance:reverse']);
  for (const call of sent) {
    assert.equal(call.payload.id, 'expense-id');
    assert.equal(call.payload.reason, 'Correction reason');
  }
});

test('editor receipt removal sends an expense id through the real preload wrapper', async () => {
  const { api, sent } = bridge();
  // This is the final local async function before the component render.
  const start = source.indexOf('  async function removeReceipt()');
  const end = source.indexOf('\n  }', start) + 4;
  const fn = new Function('window', 'confirm', `
    const rowRef = { current: { id: 'expense-id' } };
    const setRow = () => {}, setReceiptBusy = () => {}, setViewReceipt = () => {}, addToast = () => {}, errText = e => e.message;
    ${source.slice(start, end)}
    return removeReceipt;
  `)({ api }, async () => true);
  await fn();
  assert.equal(sent[0].channel, 'finance:removeReceipt');
  assert.equal(sent[0].payload.expenseId, 'expense-id');
});
