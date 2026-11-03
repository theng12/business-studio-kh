const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function access({ caps = [], branches = ['north'], active = 'company', userId = 'supervisor' } = {}) {
  const module = { exports: {} };
  const bindings = [];
  const dependencies = {
    './fuelAccess': {
      callerCaps: () => caps === null ? null : new Set(caps),
      getCallerUserId: () => userId,
      activeCompanyId: (requested) => {
        if (requested !== active) throw new Error('That belongs to a different company');
        return active;
      },
    },
    '../db': { getDb: () => ({ prepare: (sql) => ({ all: (...args) => {
      assert.match(sql, /b\.manager_employee_id/);
      assert.match(sql, /e\.status = 'active'/);
      bindings.push(args);
      return branches.map(id => ({ id }));
    } }) }) },
    '../db/branches': { get: (id) => ({ id, companyId: id === 'foreign' ? 'other' : active }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/ipc/financeAccess.js'), 'utf8'), {
    module, exports: module.exports, require: (name) => {
      if (!dependencies[name]) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return { ...module.exports, bindings };
}

test('Finance recorders are scoped to branches managed by their active linked employee', () => {
  const api = access({ caps: ['finance.record'], branches: ['north', 'west'] });
  assert.deepEqual(Array.from(api.branchScope('company')), ['north', 'west']);
  assert.deepEqual(Array.from(api.bindings[0]), ['company', 'company', 'supervisor']);
  assert.equal(api.requireBranch('company', 'north', { write: true }).id, 'north');
  assert.throws(() => api.requireBranch('company', 'south', { write: true }), /outside the branches/);
  assert.throws(() => api.branchScope('foreign'), /different company/);
  assert.throws(() => api.requireOwner(), /Only the owner/);
  assert.equal(api.denied().userFacing, true, 'permission refusals use RPC 422');
});

test('Finance read permission cannot grant recording, approval or setup', () => {
  const api = access({ caps: ['finance.view'] });
  assert.equal(api.branchScope('company'), null);
  assert.throws(() => api.branchScope('company', { write: true }), /permission to record/);
  assert.equal(api.permissions().canManage, false);
  assert.equal(api.permissions().canApprove, false);
  assert.throws(() => api.requireOwner(), /Only the owner/);
  assert.equal(api.denied().userFacing, true, 'permission refusals use RPC 422');
});

test('Company-wide readers with record permission still write only supervised branches', () => {
  const api = access({ caps: ['finance.view', 'finance.record'] });
  assert.equal(api.branchScope('company'), null);
  assert.deepEqual(Array.from(api.branchScope('company', { write: true })), ['north']);
  assert.throws(() => api.requireBranch('company', 'south', { write: true }), /outside the branches/);
});

test('Unassigned recorders and unrelated capabilities fail closed', () => {
  assert.throws(() => access({ caps: ['finance.record'], branches: [] }).branchScope('company'), /does not supervise/);
  assert.throws(() => access({ caps: ['assets.manage', 'system.manage'] }).branchScope('company'), /permission/);
});

test('Owner callers retain company checks on every branch', () => {
  for (const caps of [null, ['*']]) {
    const api = access({ caps });
    assert.equal(api.branchScope('company', { write: true }), null);
    assert.equal(api.permissions().canApprove, true);
    api.requireOwner();
    assert.throws(() => api.requireBranch('company', 'foreign'), /not in this company/);
  }
});
