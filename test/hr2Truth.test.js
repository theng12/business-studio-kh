const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDisposable, verifyDisposable, seedHr2 } = require('../scripts/seed-hr2');
const { preflight, parseArgs } = require('../scripts/probe-hr2-ui');

test('HR2 probe refuses attaching to arbitrary profiles/ports and reports missing integration', () => {
  assert.throws(() => parseArgs(['--port', '9333']), /unknown/i);
  assert.throws(() => parseArgs(['--profile', '/a/live/profile']), /unknown/i);
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-hr2-empty-repo-'));
  const result = preflight(emptyRepo);
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes('dist-renderer/index.html'));
  assert.ok(result.missing.includes('main/db/payroll.js'));
});

// These catch a seed pointed at existing data or silently confirming policy.
// All generated directories are retained; no cleanup deletes evidence.
test('HR2 seed refuses existing data, symlinks, missing marker and implicit confirmation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-hr2-truth-'));
  fs.writeFileSync(path.join(root, 'keep.txt'), 'must survive');
  assert.throws(() => createDisposable(root), /empty/i);
  assert.throws(() => verifyDisposable(root, 'wrong'), /marker/i);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'must survive');
  const disposable = createDisposable();
  await assert.rejects(seedHr2(disposable), /explicit synthetic confirmation/i);
  fs.mkdirSync(path.join(disposable.root, 'other'));
  fs.symlinkSync(path.join(disposable.root, 'other'), path.join(disposable.root, 'data'));
  assert.throws(() => verifyDisposable(disposable.root, disposable.markerId), /symlink/i);
});

test('HR2 disposable marker binds its exact root and never accepts a reused data folder', () => {
  const disposable = createDisposable();
  assert.equal(verifyDisposable(disposable.root, disposable.markerId).markerId, disposable.markerId);
  assert.throws(() => verifyDisposable(disposable.root, 'another-run'), /marker/i);
  fs.mkdirSync(path.join(disposable.root, 'data'));
  fs.writeFileSync(path.join(disposable.root, 'data', 'sentinel'), 'keep');
  assert.throws(() => verifyDisposable(disposable.root, disposable.markerId), /empty/i);
  assert.equal(fs.readFileSync(path.join(disposable.root, 'data', 'sentinel'), 'utf8'), 'keep');
});

const repo = path.resolve(process.env.HR2_FIXTURE_REPO || path.join(__dirname, '..'));
let skip = false;
try {
  new (require('better-sqlite3'))(':memory:').close();
} catch (error) {
  if (error.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(error.message)) {
    skip = 'Run ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/hr2Truth.test.js';
  } else throw error;
}
if (!skip && !fs.existsSync(path.join(repo, 'main/db/payroll.js'))) {
  skip = 'HR2 backend has not landed here; run against reviewed integration with HR2_FIXTURE_REPO';
}

// A mapper/calculator agreeing with itself cannot pass this test: read real
// persisted integer columns after close/reopen and compare handwritten numbers.
test('HR2 persisted synthetic truth reconciles currencies, cycles, loans and frozen tenant snapshots', { skip }, async t => {
  const disposable = createDisposable();
  const truth = await seedHr2({ ...disposable, repo, syntheticConfirmation: true });
  t.diagnostic(`Synthetic source fixture retained: ${truth.root}/hr2-truth.json (repo ${repo})`);
  const db = require(path.join(repo, 'main/db'));
  db.initDb(truth.dataDir);
  try {
    const rawLine = (key, employee) => db.getDb().prepare('SELECT * FROM payroll_lines WHERE run_id=? AND employee_id=? AND active=1').get(truth.runs[key], truth.employees[employee]);
    const totals = row => [row.base_minor, row.overtime_minor, row.gross_minor, row.nssf_employee_minor, row.salary_tax_khr, row.other_deductions_minor, row.loan_deduction_minor, row.advance_minor, row.net_minor];
    assert.deepEqual(totals(rawLine('monthly', 'monthly')), [48000, 300, 48300, 160, 192932, 67, 0, 0, 43250]);
    assert.deepEqual(totals(rawLine('monthly', 'daily')), [480000, 0, 480000, 8000, 48000, 0, 0, 0, 424000]);
    assert.deepEqual(totals(rawLine('monthly', 'shortfall')), [10000, 0, 10000, 0, 0, 0, 2500, 0, 7500]);
    assert.equal(rawLine('settlement', 'monthly').advance_minor, 10000);
    assert.equal(rawLine('settlement', 'monthly').net_minor, 33040);
    assert.deepEqual([rawLine('first', 'separate').base_minor, rawLine('second', 'separate').base_minor], [15001, 15000]);
    assert.deepEqual([rawLine('first', 'separate').salary_tax_khr, rawLine('second', 'separate').salary_tax_khr], [4, 60000]);
    assert.deepEqual([rawLine('first', 'separate').net_minor, rawLine('second', 'separate').net_minor], [15001, 13500]);
    const payroll = require(path.join(repo, 'main/db/payroll'));
    const loans = require(path.join(repo, 'main/db/employeeLoans'));
    const companies = truth.companies;
    assert.equal(payroll.get(companies.a, truth.runs.paid).status, 'paid');
    const monthly = payroll.get(companies.a, truth.runs.monthly);
    assert.equal(monthly.status, 'approved');
    assert.equal(monthly.lines.find(x => x.employeeId === truth.employees.monthly).remainingMinor, 33250);
    assert.deepEqual([loans.get(companies.a, truth.loans.grace).principalMinor, loans.get(companies.a, truth.loans.grace).interestMinor], [20000, 400]);
    assert.deepEqual([loans.get(companies.a, truth.loans.capitalized).principalMinor, loans.get(companies.a, truth.loans.capitalized).interestMinor], [102000, 0]);
    assert.equal(loans.get(companies.a, truth.loans.shortfall).principalMinor, 47500);
    for (const key of ['monthly', 'paid', 'settlement']) assert.throws(() => payroll.get(companies.b, truth.runs[key]), /company|run/i);
    assert.throws(() => loans.get(companies.b, truth.loans.grace), /company|loan/i);
    const employees = require(path.join(repo, 'main/db/employees'));
    employees.update(truth.employees.monthly, { nameEn: 'Changed after snapshot' });
    assert.equal(payroll.get(companies.a, truth.runs.paid).lines[0].snapshot.employee.nameEn, 'Synthetic monthly USD');
    assert.equal(rawLine('paid', 'monthly').net_minor, 43040);
    assert.deepEqual(truth.cappedPreview, { overtimeMinor: 300, lateMinor: 67, staleOvertime: true, staleLateness: true });
    assert.equal(fs.existsSync(path.join(disposable.root, 'hr2-truth.json')), true);
  } finally { db.closeDb(); }
});
