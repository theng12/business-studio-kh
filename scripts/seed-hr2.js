#!/usr/bin/env node
/**
 * Independent, deliberately small HR2 truth fixture. All rates below are
 * FICTIONAL test numbers, never Cambodian legal rates or professional advice.
 *
 * ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/seed-hr2.js 
 *   --repo /path/to/reviewed/integration --synthetic-confirmation
 *
 * No default legal confirmation. The explicit flag is permitted ONLY inside
 * a fresh, marked OS-temp fixture. Evidence/data are retained, never deleted.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const MARKER = '.hr2-disposable.json';
const PURPOSE = 'HR2 synthetic verification; no real people or legal confirmation';
const SOURCE = 'FICTIONAL synthetic professional evidence ONLY: pay frequency, deduction/recovery limits, lending/capitalization, statutory aggregation, FX/rounding. Not Cambodian legal rates.';

function tempRoot(root) {
  const resolved = path.resolve(root);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(path.dirname(resolved)));
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/^mskh-hr2-/.test(path.basename(resolved))) throw new Error('Fixture must be an mskh-hr2-* directory inside OS temp');
  if (fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Disposable root must not be a symlink');
  return resolved;
}

function createDisposable(root = fs.mkdtempSync(path.join(os.tmpdir(), 'mskh-hr2-fixture-'))) {
  root = tempRoot(root);
  if (fs.readdirSync(root).length) throw new Error('Disposable fixture root must be empty');
  const marker = { purpose: PURPOSE, root: fs.realpathSync(root), markerId: crypto.randomUUID(), createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify(marker, null, 2), { flag: 'wx', mode: 0o600 });
  return { root, markerId: marker.markerId };
}

function verifyDisposable(root, markerId, { seeded = false } = {}) {
  root = tempRoot(root);
  const markerFile = path.join(root, MARKER);
  if (!fs.existsSync(markerFile) || fs.lstatSync(markerFile).isSymbolicLink()) throw new Error('Disposable marker is missing or a symlink');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (marker.purpose !== PURPOSE || marker.root !== fs.realpathSync(root) || marker.markerId !== markerId) throw new Error('Disposable marker does not bind this root/run');
  for (const name of ['data', 'userdata']) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${name} must not be a symlink`);
    if (!seeded && fs.readdirSync(dir).length) throw new Error(`${name} must be empty; refusing existing data`);
    if (fs.realpathSync(dir) !== path.join(marker.root, name)) throw new Error('Fixture path escaped its marker');
  }
  return marker;
}

async function seedHr2({ root, markerId, repo = path.join(__dirname, '..'), syntheticConfirmation = false }) {
  if (syntheticConfirmation !== true) throw new Error('Approved truth requires explicit synthetic confirmation inside marked disposable data');
  verifyDisposable(root, markerId);
  repo = fs.realpathSync(repo);
  for (const file of ['payroll', 'payrollConfig', 'employeeLoans']) {
    if (!fs.existsSync(path.join(repo, 'main/db', `${file}.js`))) throw new Error(`HR2 dependency main/db/${file}.js has not landed in ${repo}`);
  }
  const req = name => require(path.join(repo, 'main', name));
  const db = req('db');
  const companies = req('db/companies'), employees = req('db/employees');
  const hr = req('db/hr'), attendance = req('db/attendance'), clock = req('util/attendanceCalc');
  const config = req('db/payrollConfig'), payroll = req('db/payroll'), loans = req('db/employeeLoans');
  const dataDir = path.join(root, 'data');
  const truth = { purpose: PURPOSE, repo, root, markerId, dataDir, companies: {}, employees: {}, runs: {}, loans: {}, expected: {}, checks: [] };
  const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); truth.checks.push({ name, actual, expected, ok: true }); };
  db.initDb(dataDir);
  try {
    const a = companies.create({ name: 'Synthetic HR2 A', isActive: true }).id;
    const b = companies.create({ name: 'Synthetic HR2 B', isActive: true }).id;
    truth.companies = { a, b };
    const rateSets = {};
    for (const companyId of [a, b]) {
      hr.ensurePrefilled(companyId);
      const schedule = hr.createSchedule({ companyId, name: 'Synthetic eight-hour daily schedule', startTime: '09:00', endTime: '17:00', breakMin: 0, workDays: '1111111', graceMin: 0 });
      hr.updateSettings(companyId, { defaultScheduleId: schedule.id, attendanceStartDate: '2026-01-01', otRates: { normal: 150, night: 200, restDay: 200, holiday: 200 } });
      config.updateSettings(companyId, { payCycle: companyId === b ? 'twice_monthly_separate' : 'monthly', maxDeductionPercent: 25, taxRateKhrPerUsd: 4000, rateSource: 'FICTIONAL manual tax FX', nssfRateKhrPerUsd: 5000, nssfRateSource: 'FICTIONAL independent NSSF FX', policySource: SOURCE, policyConfirmed: true });
      const set = config.saveRateSet(companyId, { name: 'FICTIONAL synthetic tables — not legal rates', effectiveFrom: '2026-01-01', sourceNote: SOURCE,
        nssf: { components: [{ key: 'synthetic_pension', employeePercent: 2, employerPercent: 3, bands: [{ upperKhr: null, baseKhr: 400000 }] }] },
        tax: { brackets: companyId === b ? [{ upperKhr: 600000, ratePercent: 0 }, { upperKhr: null, ratePercent: 10 }] : [{ upperKhr: null, ratePercent: 10 }], spouseAllowanceKhr: 0, dependentAllowanceKhr: 0, maxDependents: null, nonResidentPercent: 10, fringeBenefitPercent: 0, pensionDeductible: false } });
      rateSets[companyId] = config.confirmRateSet(companyId, { id: set.id, sourceNote: SOURCE }).id;
    }
    truth.rateSets = rateSets;
    for (const [key, companyId, code, name, basis, amountMinor, currency, taxable] of [
      ['monthly', a, 'M-USD', 'Synthetic monthly USD', 'month', 48000, 'USD', true],
      ['daily', a, 'D-KHR', 'Synthetic daily KHR', 'day', 16000, 'KHR', true],
      ['shortfall', a, 'S-USD', 'Synthetic recovery shortfall', 'month', 10000, 'USD', false],
      ['separate', b, 'B-USD', 'Synthetic separate periods', 'month', 30001, 'USD', true],
    ]) {
      const employeeId = employees.create({ companyId, staffCode: code, nameEn: name, nameKm: 'បុគ្គលិកសាកល្បង' }).id;
      truth.employees[key] = employeeId;
      config.setEmployeePolicy(companyId, { employeeId, applyTax: taxable, applyNssf: taxable && companyId === a, taxResident: true, spouseCount: 0, dependentCount: 0, reason: SOURCE });
      config.setPayRate(companyId, { employeeId, basis, amountMinor, currency, effectiveFrom: '2026-01-01', reason: SOURCE });
      for (const month of key === 'monthly' ? ['2026-07', '2026-08', '2026-09'] : ['2026-09']) {
        const count = month === '2026-09' ? 30 : 31;
        for (let d = 1; d <= count; d++) {
          const workDate = `${month}-${String(d).padStart(2, '0')}`;
          for (const [kind, time] of [['in', key === 'monthly' && workDate === '2026-09-01' ? '09:30' : '09:00'], ['out', key === 'monthly' && workDate === '2026-09-02' ? '19:00' : '17:00']]) {
            attendance.addManual({ companyId, employeeId, workDate, kind, at: clock.timeOnDate(workDate, time), reason: SOURCE });
          }
        }
      }
    }
    const employeeId = truth.employees.monthly;
    attendance.approveOvertime({ companyId: a, employeeId, workDate: '2026-09-02', minutes: { normal: 120 }, note: SOURCE });
    attendance.confirmLateness({ companyId: a, employeeId, month: '2026-09', lateMinutes: 30, earlyLeaveMinutes: 0, note: SOURCE });
    for (const [workDate, times] of [['2026-09-01', { inTime: '09:20' }], ['2026-09-02', { outTime: '18:00' }]]) {
      const correction = attendance.requestCorrection({ companyId: a, employeeId, workDate, ...times, reason: SOURCE, via: 'manager' });
      attendance.decideCorrection(correction.id, { decision: 'approve' });
    }
    const createRun = (key, companyId, input) => {
      const run = payroll.create(companyId, { statutoryRateSetId: rateSets[companyId], operationId: `truth-${key}`, ...input });
      truth.runs[key] = run.id;
      return payroll.calculate(companyId, run.id);
    };
    const approve = (companyId, run) => {
      run = payroll.review(companyId, { id: run.id, expectedRevision: run.revision });
      return payroll.approve(companyId, { id: run.id, expectedRevision: run.revision });
    };
    let monthly = createRun('monthly', a, { periodStart: '2026-09-01', periodEnd: '2026-09-30', employeeIds: [employeeId, truth.employees.daily, truth.employees.shortfall] });
    const capped = monthly.lines.find(x => x.employeeId === employeeId);
    truth.cappedPreview = { overtimeMinor: capped.overtimeMinor, lateMinor: capped.snapshot.calculationInput.lateDeductionMinor, staleOvertime: capped.blockers.some(x => x.code === 'stale_overtime'), staleLateness: capped.blockers.some(x => x.code === 'stale_lateness') };
    check('HR1 capped stale preview', truth.cappedPreview, { overtimeMinor: 300, lateMinor: 67, staleOvertime: true, staleLateness: true });
    attendance.approveOvertime({ companyId: a, employeeId, workDate: '2026-09-02', minutes: { normal: 60 }, note: SOURCE });
    attendance.confirmLateness({ companyId: a, employeeId, month: '2026-09', lateMinutes: 20, earlyLeaveMinutes: 0, note: SOURCE });
    function newLoan(key, input) {
      const loan = loans.create(a, { interestMethod: 'none', interestPolicy: 'separate', ratePercent: 0, interestFreeMonths: 0, maxDeductionPercent: 25, deductViaPayroll: false, disbursedOn: '2026-01-01', loanNo: `TRUTH-${key}`, operationId: `truth-loan-${key}`, ...input });
      truth.loans[key] = loan.id;
      loans.approve(a, loan.id);
      return loan;
    }
    const grace = newLoan('grace', { employeeId, principalMinor: 50000, currency: 'USD', installmentMinor: 10000, interestMethod: 'declining', ratePercent: 2, interestFreeMonths: 3 });
    for (const [i, entryDate] of ['2026-01-20', '2026-02-20', '2026-03-20'].entries()) loans.repay(a, { id: grace.id, amountMinor: 10000, entryDate, source: 'cash', operationId: `truth-grace-${i}` });
    const accrued = loans.accrue(a, { id: grace.id, through: '2026-04-30', operationId: 'truth-grace-interest' });
    check('Three-month grace: repayments immediate, April 2% of $200', [accrued.principalMinor, accrued.interestMinor], [20000, 400]);
    const capitalized = newLoan('capitalized', { employeeId: truth.employees.daily, principalMinor: 100000, currency: 'KHR', installmentMinor: 10000, interestMethod: 'declining', interestPolicy: 'capitalize', ratePercent: 2 });
    const capital = loans.accrue(a, { id: capitalized.id, through: '2026-01-31', operationId: 'truth-capital-interest' });
    check('Capitalization transfers 2,000 riel once', [capital.principalMinor, capital.interestMinor], [102000, 0]);
    newLoan('shortfall', { employeeId: truth.employees.shortfall, principalMinor: 50000, currency: 'USD', installmentMinor: 10000, deductViaPayroll: true });
    monthly = payroll.calculate(a, monthly.id);
    const short = monthly.lines.find(x => x.employeeId === truth.employees.shortfall);
    check('Recovery ceiling leaves reviewable $75 shortfall', [short.loanDeductionMinor, short.netMinor, short.blockers.some(x => x.code === 'loan_shortfall')], [2500, 7500, true]);
    monthly = payroll.updateLine(a, { id: short.id, expectedRevision: monthly.revision, patch: { loanDecisions: [{ loanId: truth.loans.shortfall, amountMinor: 2500, reason: SOURCE }] } });
    monthly = approve(a, monthly);
    // September taxable wage: (48,300 - 67) cents * 40 = 1,929,320 KHR.
    // Fictional 10% tax = 192,932 KHR = 4,823 cents rounded; net 43,250.
    // Daily: 30 * 16,000 - 8,000 NSSF - 48,000 fictional flat tax.
    for (const [key, want] of [['monthly', [48000, 300, 48300, 160, 192932, 67, 0, 43250]], ['daily', [480000, 0, 480000, 8000, 48000, 0, 0, 424000]], ['shortfall', [10000, 0, 10000, 0, 0, 0, 2500, 7500]]]) {
      const line = monthly.lines.find(x => x.employeeId === truth.employees[key]);
      check(`September ${key}`, ['baseMinor', 'overtimeMinor', 'grossMinor', 'nssfEmployeeMinor', 'salaryTaxKhr', 'otherDeductionsMinor', 'loanDeductionMinor', 'netMinor'].map(k => line[k]), want);
      payroll.pay(a, { id: line.id, amountMinor: key === 'monthly' ? 10000 : line.netMinor, method: 'bank', paidAt: '2026-10-01', operationId: `truth-monthly-pay-${key}` });
    }
    let paid = approve(a, createRun('paid', a, { periodStart: '2026-08-01', periodEnd: '2026-08-31', employeeIds: [employeeId] }));
    check('August frozen paid snapshot', paid.lines[0].netMinor, 43040);
    payroll.pay(a, { id: paid.lines[0].id, amountMinor: 43040, method: 'cash', paidAt: '2026-09-01', operationId: 'truth-august-pay' });
    for (const [key, start, end, want] of [['first', '01', '15', [15001, 4, 15001]], ['second', '16', '30', [15000, 60000, 13500]]]) {
      const run = approve(b, createRun(key, b, { periodStart: `2026-09-${start}`, periodEnd: `2026-09-${end}`, employeeIds: [truth.employees.separate] }));
      check(`Separate ${key}: cumulative rounding and tax`, [run.lines[0].baseMinor, run.lines[0].salaryTaxKhr, run.lines[0].netMinor], want);
    }
    config.updateSettings(a, { payCycle: 'twice_monthly_advance', policySource: SOURCE, policyConfirmed: true });
    const advance = approve(a, createRun('advance', a, { kind: 'advance', periodStart: '2026-07-01', periodEnd: '2026-07-15', employeeIds: [employeeId], currency: 'USD', advanceMinor: 12000 }));
    payroll.pay(a, { id: advance.lines[0].id, amountMinor: 10000, method: 'cash', paidAt: '2026-07-15', operationId: 'truth-advance-paid' });
    const settlement = approve(a, createRun('settlement', a, { kind: 'settlement', periodStart: '2026-07-01', periodEnd: '2026-07-31', employeeIds: [employeeId] }));
    check('Advance settlement subtracts $100 paid, not $120 requested', [settlement.lines[0].grossMinor, settlement.lines[0].advanceMinor, settlement.lines[0].netMinor], [48000, 10000, 33040]);
    config.updateSettings(a, { payCycle: 'monthly', policySource: SOURCE, policyConfirmed: true });
    companies.setActive(a);
    // PINs are synthetic and local to this marked fixture; no webcam needed.
    await req('db/hrPeople').setPin(employeeId, '2468');
    await req('db/hrPeople').setPin(truth.employees.daily, '1357');
    truth.kiosk = { monthlyPin: '2468', dailyPin: '1357' };
    truth.expected = { monthlyUsdNetMinor: 43250, dailyKhrNetMinor: 424000, shortfallUsdNetMinor: 7500, paidUsdNetMinor: 43040, settlementUsdNetMinor: 33040, separateUsdBaseMinor: 30001, separateTaxKhr: 60004, gracePrincipalUsdMinor: 20000, graceInterestUsdMinor: 400, capitalizedPrincipalKhrMinor: 102000 };
    truth.ok = true;
  } finally { db.closeDb(); }
  const userDataDir = path.join(root, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ dataDir, firstLaunchHandled: true, mode: 'standalone' }), { flag: 'wx', mode: 0o600 });
  truth.userDataDir = userDataDir;
  fs.writeFileSync(path.join(root, 'hr2-truth.json'), JSON.stringify(truth, null, 2), { flag: 'wx', mode: 0o600 });
  return truth;
}

module.exports = { createDisposable, verifyDisposable, seedHr2 };
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes('--help')) { console.log('Usage: ELECTRON_RUN_AS_NODE=1 electron scripts/seed-hr2.js [--repo reviewed-checkout] --synthetic-confirmation\nCreates fresh marked OS-temp data; retains all evidence. Test numbers are FICTIONAL.'); return; }
    let repo = path.join(__dirname, '..'), syntheticConfirmation = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--repo' && args[i + 1]) repo = path.resolve(args[++i]);
      else if (args[i] === '--synthetic-confirmation') syntheticConfirmation = true;
      else throw new Error(`Unknown option: ${args[i]}`);
    }
    if (!syntheticConfirmation) throw new Error('Supply --synthetic-confirmation explicitly; this fixture never confirms real policy');
    const disposable = createDisposable();
    console.log(JSON.stringify({ event: 'disposable-created', ...disposable }));
    const truth = await seedHr2({ ...disposable, repo, syntheticConfirmation });
    console.log(JSON.stringify({ event: 'truth-ready', root: truth.root, ok: truth.ok, checks: truth.checks, expected: truth.expected }));
  })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
