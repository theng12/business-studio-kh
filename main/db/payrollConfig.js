const {
  getDb
} = require('./index');
const {
  uuid,
  badRequest,
  isCalendarDate,
  getCallerUserId
} = require('./_fuelUtil');
const crypto = require('node:crypto');
const DEFAULTS = {
  payCycle: 'monthly',
  payday: 10,
  monthlyDivisor: 'scheduled_working_days',
  fixedDivisor: null,
  approvalPolicy: 'admin',
  loanApprovalPolicy: 'admin',
  rateChangePolicy: 'admin',
  postponementPolicy: 'admin',
  maxDeductionPercent: 100,
  installmentMinor: null,
  installmentCurrency: 'USD',
  taxRateKhrPerUsd: null,
  nssfRateKhrPerUsd: null,
  nssfRateSource: null,
  loanRateKhrPerUsd: null,
  loanRateSource: null,
  rateSource: null,
  policySource: null,
  policyConfirmed: false
};
function fail(message) {
  throw badRequest(message);
}
function text(v, label, required = true) {
  if (v == null && !required) return null;
  if (typeof v !== 'string' || !v.trim() || v.length > 2000) fail(`${label} is required (at most 2000 characters)`);
  return v.trim();
}
function money(v, label = 'Amount', min = 0) {
  if (!Number.isSafeInteger(v) || v < min) fail(`${label} must be a safe integer at least ${min}`);
  return v;
}
function percent(v, label = 'Percent') {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) fail(`${label} must be between 0 and 100`);
  return v;
}
function date(v, label = 'Date') {
  if (!isCalendarDate(v) || typeof v !== 'string') fail(`${label} must be a real calendar date`);
  return v;
}
function choice(v, values, label) {
  if (!values.includes(v)) fail(`${label} must be ${values.join(' or ')}`);
  return v;
}
function bool(v, label) {
  if (typeof v !== 'boolean') fail(`${label} must be boolean`);
  return v;
}
function company(id) {
  if (!getDb().prepare('SELECT id FROM companies WHERE id=?').get(id)) fail('Company not found');
  return id;
}
function employee(companyId, id) {
  company(companyId);
  const e = require('./employees').get(id);
  if (!e || e.companyId !== companyId) fail('Staff member not found in this company');
  return e;
}
function scoped(table, companyId, id, label = 'Record') {
  company(companyId);
  const r = getDb().prepare(`SELECT * FROM ${table} WHERE company_id=? AND id=?`).get(companyId, id);
  if (!r) fail(`${label} not found in this company`);
  return r;
}
function hash(input) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}
function audit(type, id, action, after) {
  if (!require('./auditLog').log({
    entityType: type,
    entityId: id,
    action,
    after,
    sensitivity: 'payroll'
  })) fail('Payroll audit could not be saved');
}
function operation(companyId, operationId, command, input, fn) {
  company(companyId);
  text(operationId, 'Operation ID');
  const payloadHash = hash({
    command,
    input
  });
  const db = getDb();
  return db.transaction(() => {
    const prev = db.prepare('SELECT * FROM payroll_operations WHERE company_id=? AND operation_id=?').get(companyId, operationId);
    if (prev) {
      if (prev.payload_hash !== payloadHash) fail('Operation ID already used for a different request');
      return JSON.parse(prev.result_json);
    }
    const result = fn();
    db.prepare('INSERT INTO payroll_operations VALUES (?,?,?,?,?)').run(companyId, operationId, payloadHash, JSON.stringify(result), Date.now());
    return result;
  })();
}
function getSettings(companyId) {
  company(companyId);
  const r = getDb().prepare('SELECT * FROM payroll_settings WHERE company_id=?').get(companyId);
  return {
    ...DEFAULTS,
    ...JSON.parse(r?.settings_json || '{}'),
    installmentMinor: r?.installment_minor ?? null,
    complianceWarning: 'Monthly pay is a trial comparison policy; confirm twice-monthly wage requirements.'
  };
}
function updateSettings(companyId, patch) {
  const s = getSettings(companyId);
  const next = {
    ...s
  };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!Object.hasOwn(DEFAULTS, k)) fail(`Unknown payroll setting ${k}`);
    if (k.endsWith('Policy')) choice(v, ['admin', 'designated_managers'], k);
    if (k === 'payCycle') choice(v, ['monthly', 'twice_monthly_advance', 'twice_monthly_separate'], k);
    if (k === 'monthlyDivisor') choice(v, ['scheduled_working_days', 'fixed'], k);
    if (k === 'payday') {
      money(v, k, 1);
      if (v > 28) fail('Payday must be at most 28');
    }
    if (k === 'fixedDivisor' && v != null) {
      money(v, k, 1);
      if (v > 366) fail('Fixed divisor must be at most 366');
    }
    if (k === 'maxDeductionPercent') percent(v, k);
    if (k === 'installmentMinor' && v != null) money(v, k, 1);
    if (k === 'installmentCurrency') choice(v, ['USD', 'KHR'], k);
    if (['taxRateKhrPerUsd', 'nssfRateKhrPerUsd', 'loanRateKhrPerUsd'].includes(k) && v != null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100000)) fail('Explicit positive exchange rate required');
    if (['rateSource', 'nssfRateSource', 'loanRateSource', 'policySource'].includes(k) && v != null) text(v, k);
    if (k === 'policyConfirmed') bool(v, k);
    next[k] = v;
  }
  if (next.monthlyDivisor === 'fixed' && !next.fixedDivisor) fail('Fixed divisor is required');
  if (next.policyConfirmed && !next.policySource) fail('Policy confirmation source is required');
  if (patch.policyConfirmed === true) {
    next.policyConfirmedByUserId = getCallerUserId() || 'local-admin';
    next.policyConfirmedAt = Date.now();
  }
  // Changing calculation policy invalidates previous confirmation unless explicitly reconfirmed.
  if (['payCycle', 'payday', 'monthlyDivisor', 'fixedDivisor', 'maxDeductionPercent', 'installmentMinor', 'installmentCurrency'].some(k => k in (patch || {}) && patch[k] !== s[k]) && patch.policyConfirmed !== true) next.policyConfirmed = false;
  const installment = next.installmentMinor;
  delete next.installmentMinor;
  delete next.complianceWarning;
  getDb().transaction(() => {
    getDb().prepare(`INSERT INTO payroll_settings VALUES (?,?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET settings_json=excluded.settings_json,installment_minor=excluded.installment_minor,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id`).run(companyId, JSON.stringify(next), installment, Date.now(), getCallerUserId());
    audit('payroll_settings', companyId, 'update', {
      ...next,
      installmentMinor: installment
    });
  })();
  return getSettings(companyId);
}
function getEmployeePolicy(companyId, employeeId) {
  employee(companyId, employeeId);
  const r = getDb().prepare('SELECT * FROM employee_payroll_policies WHERE company_id=? AND employee_id=?').get(companyId, employeeId);
  return r ? {
    companyId,
    employeeId,
    applyNssf: !!r.apply_nssf,
    applyTax: !!r.apply_tax,
    taxResident: !!r.tax_resident,
    spouseCount: r.spouse_count,
    dependentCount: r.dependent_count,
    reason: r.reason,
    updatedAt: r.updated_at
  } : null;
}
function setEmployeePolicy(companyId, input) {
  employee(companyId, input.employeeId);
  const p = {
    ...getEmployeePolicy(companyId, input.employeeId),
    ...input
  };
  for (const k of ['applyNssf', 'applyTax', 'taxResident']) bool(p[k], k);
  money(p.spouseCount, 'Spouse count');
  if (p.spouseCount > 1) fail('Spouse count must be 0 or 1');
  money(p.dependentCount, 'Dependent count');
  if (p.dependentCount > 100) fail('Dependent count exceeds 100');
  if (!p.applyNssf || !p.applyTax) text(p.reason, 'Exemption reason');
  getDb().transaction(() => {
    getDb().prepare(`INSERT INTO employee_payroll_policies VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET apply_nssf=excluded.apply_nssf,apply_tax=excluded.apply_tax,tax_resident=excluded.tax_resident,spouse_count=excluded.spouse_count,dependent_count=excluded.dependent_count,reason=excluded.reason,updated_at=excluded.updated_at,updated_by_user_id=excluded.updated_by_user_id`).run(companyId, p.employeeId, +p.applyNssf, +p.applyTax, +p.taxResident, p.spouseCount, p.dependentCount, p.reason || null, Date.now(), getCallerUserId());
    audit('employee_payroll_policy', p.employeeId, 'update', p);
  })();
  return getEmployeePolicy(companyId, p.employeeId);
}
function payRate(r) {
  return {
    id: r.id,
    companyId: r.company_id,
    employeeId: r.employee_id,
    effectiveFrom: r.effective_from,
    basis: r.basis,
    amountMinor: r.amount_minor,
    currency: r.currency,
    reason: r.reason,
    setByUserId: r.set_by_user_id,
    createdAt: r.created_at
  };
}
function listPayRates(companyId, employeeId) {
  employee(companyId, employeeId);
  return getDb().prepare('SELECT * FROM employee_pay_rates WHERE company_id=? AND employee_id=? ORDER BY effective_from').all(companyId, employeeId).map(payRate);
}
function setPayRate(companyId, input) {
  employee(companyId, input.employeeId);
  date(input.effectiveFrom);
  money(input.amountMinor);
  choice(input.basis, ['month', 'day', 'hour'], 'Pay basis');
  choice(input.currency, ['USD', 'KHR'], 'Currency');
  text(input.reason, 'Pay-rate reason');
  if (listPayRates(companyId, input.employeeId).some(r => r.effectiveFrom === input.effectiveFrom)) fail('A pay rate already exists for this date');
  const id = uuid();
  getDb().transaction(() => {
    getDb().prepare('INSERT INTO employee_pay_rates VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, companyId, input.employeeId, input.effectiveFrom, input.basis, input.amountMinor, input.currency, input.reason, getCallerUserId(), Date.now());
    audit('employee_pay_rate', id, 'create', input);
  })();
  return payRate(scoped('employee_pay_rates', companyId, id));
}
function component(r) {
  return {
    id: r.id,
    companyId: r.company_id,
    code: r.code,
    nameEn: r.name_en,
    nameKm: r.name_km,
    kind: r.kind,
    calc: r.calc,
    defaultAmountMinor: r.default_amount_minor,
    taxable: !!r.taxable,
    nssfContributory: !!r.nssf_contributory,
    isFringeBenefit: !!r.is_fringe_benefit,
    active: !!r.active
  };
}
function listComponents(companyId) {
  company(companyId);
  return getDb().prepare('SELECT * FROM pay_components WHERE company_id=? ORDER BY code').all(companyId).map(component);
}
function saveComponent(companyId, input) {
  company(companyId);
  const prev = input.id ? component(scoped('pay_components', companyId, input.id, 'Component')) : {};
  const p = {
    defaultAmountMinor: 0,
    active: true,
    ...prev,
    ...input
  };
  text(p.code, 'Code');
  text(p.nameEn, 'Name');
  choice(p.kind, ['earning', 'deduction', 'employer_cost'], 'Component kind');
  choice(p.calc, ['fixed', 'per_day', 'per_hour', 'percent'], 'Calculation');
  money(p.defaultAmountMinor);
  for (const k of ['taxable', 'nssfContributory', 'isFringeBenefit', 'active']) bool(p[k], k);
  const id = p.id || uuid();
  getDb().transaction(() => {
    getDb().prepare(`INSERT INTO pay_components VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name_en=excluded.name_en,name_km=excluded.name_km,kind=excluded.kind,calc=excluded.calc,default_amount_minor=excluded.default_amount_minor,taxable=excluded.taxable,nssf_contributory=excluded.nssf_contributory,is_fringe_benefit=excluded.is_fringe_benefit,active=excluded.active,updated_at=excluded.updated_at`).run(id, companyId, p.code, p.nameEn, p.nameKm || null, p.kind, p.calc, p.defaultAmountMinor, +p.taxable, +p.nssfContributory, +p.isFringeBenefit, +p.active, Date.now(), Date.now());
    audit('pay_component', id, 'save', p);
  })();
  return component(scoped('pay_components', companyId, id));
}
function assignment(r) {
  return {
    id: r.id,
    companyId: r.company_id,
    employeeId: r.employee_id,
    componentId: r.component_id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to
  };
}
function listEmployeeComponents(companyId, employeeId) {
  employee(companyId, employeeId);
  return getDb().prepare('SELECT * FROM employee_components WHERE company_id=? AND employee_id=? ORDER BY effective_from,id').all(companyId, employeeId).map(assignment);
}
function setEmployeeComponent(companyId, p) {
  employee(companyId, p.employeeId);
  scoped('pay_components', companyId, p.componentId, 'Component');
  money(p.amountMinor);
  choice(p.currency, ['USD', 'KHR'], 'Currency');
  date(p.effectiveFrom);
  if (p.effectiveTo) {
    date(p.effectiveTo);
    if (p.effectiveTo < p.effectiveFrom) fail('Component end precedes start');
  }
  if (listEmployeeComponents(companyId, p.employeeId).some(r => r.componentId === p.componentId && r.effectiveFrom <= (p.effectiveTo || '9999-12-31') && (r.effectiveTo || '9999-12-31') >= p.effectiveFrom)) fail('Overlapping employee component assignment');
  const id = uuid();
  getDb().transaction(() => {
    getDb().prepare('INSERT INTO employee_components VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, companyId, p.employeeId, p.componentId, p.amountMinor, p.currency, p.effectiveFrom, p.effectiveTo || null, Date.now(), getCallerUserId());
    audit('employee_component', id, 'create', p);
  })();
  return assignment(scoped('employee_components', companyId, id));
}
function rateSet(r) {
  const db = getDb();
  const bands = db.prepare('SELECT * FROM nssf_wage_bands WHERE rate_set_id=? ORDER BY position').all(r.id);
  const components = db.prepare('SELECT * FROM nssf_rates WHERE rate_set_id=? ORDER BY component').all(r.id);
  const brackets = db.prepare('SELECT * FROM salary_tax_brackets WHERE rate_set_id=? ORDER BY position').all(r.id);
  const t = db.prepare('SELECT * FROM salary_tax_params WHERE rate_set_id=?').get(r.id);
  return {
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    status: r.status,
    sourceNote: r.source_note,
    confirmedByUserId: r.confirmed_by_user_id,
    confirmedAt: r.confirmed_at,
    nssf: {
      ...(bands.length ? {
        bands: bands.map(b => ({
          upperKhr: b.upper_khr,
          baseKhr: b.base_khr
        }))
      } : {}),
      components: components.map(c => {
        const overrides = db.prepare('SELECT upper_khr,base_khr FROM nssf_component_bands WHERE rate_set_id=? AND component=? ORDER BY position').all(r.id, c.component);
        return {
          key: c.component,
          employeePercent: c.employee_rate,
          employerPercent: c.employer_rate,
          ...(overrides.length ? {
            bands: overrides.map(b => ({
              upperKhr: b.upper_khr,
              baseKhr: b.base_khr
            }))
          } : {})
        };
      })
    },
    tax: t ? {
      brackets: brackets.map(b => ({
        upperKhr: b.upper_khr,
        ratePercent: b.rate
      })),
      spouseAllowanceKhr: t.spouse_allowance_khr,
      dependentAllowanceKhr: t.dependent_allowance_khr,
      maxDependents: t.max_dependents,
      nonResidentPercent: t.non_resident_rate,
      fringeBenefitPercent: t.fringe_benefit_rate,
      pensionDeductible: !!t.pension_deductible
    } : null
  };
}
function listRateSets(companyId) {
  company(companyId);
  return getDb().prepare('SELECT * FROM statutory_rate_sets WHERE company_id=? ORDER BY effective_from,id').all(companyId).map(rateSet);
}
function validateTables(nssf, tax, required = false) {
  if (!nssf?.components?.length || !tax?.brackets?.length || !(nssf.components || []).every(x => x.bands?.length || nssf.bands?.length)) {
    if (required) fail('Complete NSSF/tax tables are required');
    if (!nssf && !tax) return;
  }
  for (const [rows, label] of [[nssf?.bands || [], 'NSSF bands'], ...(nssf?.components || []).filter(x => x.bands).map(x => [x.bands, `NSSF ${x.key} bands`]), [tax?.brackets || [], 'Tax brackets']]) {
    let prev = -1,
      previousBase = -1,
      previousRate = -1;
    for (let i = 0; i < rows.length; i++) {
      const u = rows[i].upperKhr;
      if (u === null) {
        if (i !== rows.length - 1) fail(`${label} open upper bound must be last`);
      } else {
        money(u, label);
        if (u <= prev) fail(`${label} must be ordered`);
        prev = u;
      }
      if ('baseKhr' in rows[i]) {
        money(rows[i].baseKhr);
        if (rows[i].baseKhr < previousBase) fail(`${label} bases must be ordered`);
        previousBase = rows[i].baseKhr;
      }
      if ('ratePercent' in rows[i]) {
        percent(rows[i].ratePercent);
        if (rows[i].ratePercent < previousRate) fail(`${label} rates must be ordered`);
        previousRate = rows[i].ratePercent;
      }
    }
    if (required && rows.length && rows.at(-1)?.upperKhr !== null) fail(`${label} must cover all wages`);
  }
  const keys = new Set();
  for (const c of nssf?.components || []) {
    text(c.key, 'NSSF key');
    if (keys.has(c.key)) fail('Duplicate NSSF component');
    keys.add(c.key);
    percent(c.employeePercent);
    percent(c.employerPercent);
  }
  if (tax) {
    for (const k of ['spouseAllowanceKhr', 'dependentAllowanceKhr']) money(tax[k], k);
    if (tax.maxDependents !== null) money(tax.maxDependents, 'maxDependents');
    percent(tax.nonResidentPercent);
    percent(tax.fringeBenefitPercent);
    bool(tax.pensionDeductible, 'Pension deductible');
  }
}
function saveRateSet(companyId, input) {
  company(companyId);
  const old = input.id ? rateSet(scoped('statutory_rate_sets', companyId, input.id, 'Rate set')) : null;
  const p = {
    ...old,
    ...input
  };
  text(p.name, 'Rate set name');
  date(p.effectiveFrom);
  if (p.effectiveTo) {
    date(p.effectiveTo);
    if (p.effectiveTo < p.effectiveFrom) fail('Rate set end precedes start');
  }
  validateTables(p.nssf, p.tax);
  // Every edit is a new draft; no monetary rows (even draft ones) are removed.
  const id = uuid();
  const db = getDb();
  db.transaction(() => {
    db.prepare('INSERT INTO statutory_rate_sets VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, companyId, p.name, p.effectiveFrom, p.effectiveTo || null, 'draft', p.sourceNote || null, null, null, Date.now());
    (p.nssf?.bands || []).forEach((b, i) => db.prepare('INSERT INTO nssf_wage_bands VALUES (?,?,?,?)').run(id, i, b.upperKhr, b.baseKhr));
    (p.nssf?.components || []).forEach(c => {
      db.prepare('INSERT INTO nssf_rates VALUES (?,?,?,?)').run(id, c.key, c.employeePercent, c.employerPercent);
      (c.bands || []).forEach((b, i) => db.prepare('INSERT INTO nssf_component_bands VALUES (?,?,?,?,?)').run(id, c.key, i, b.upperKhr, b.baseKhr));
    });
    (p.tax?.brackets || []).forEach((b, i) => db.prepare('INSERT INTO salary_tax_brackets VALUES (?,?,?,?)').run(id, i, b.upperKhr, b.ratePercent));
    if (p.tax) db.prepare('INSERT INTO salary_tax_params VALUES (?,?,?,?,?,?,?)').run(id, p.tax.spouseAllowanceKhr, p.tax.dependentAllowanceKhr, p.tax.maxDependents, p.tax.nonResidentPercent, p.tax.fringeBenefitPercent, +p.tax.pensionDeductible);
    audit('statutory_rate_set', id, 'draft', {
      name: p.name,
      effectiveFrom: p.effectiveFrom
    });
  })();
  return rateSet(scoped('statutory_rate_sets', companyId, id));
}
function confirmRateSet(companyId, p) {
  const r = rateSet(scoped('statutory_rate_sets', companyId, p.id, 'Rate set'));
  text(p.sourceNote, 'Confirmation source');
  if (r.status === 'confirmed') {
    if (r.sourceNote !== p.sourceNote) fail('Confirmed rate set is immutable');
    return r;
  }
  validateTables(r.nssf, r.tax, true);
  if (listRateSets(companyId).some(s => s.status === 'confirmed' && s.effectiveFrom <= (r.effectiveTo || '9999-12-31') && (s.effectiveTo || '9999-12-31') >= r.effectiveFrom)) fail('Overlapping confirmed statutory coverage');
  const actor = getCallerUserId() || 'local-admin';
  getDb().transaction(() => {
    getDb().prepare("UPDATE statutory_rate_sets SET status='confirmed',source_note=?,confirmed_by_user_id=?,confirmed_at=? WHERE id=?").run(p.sourceNote, actor, Date.now(), r.id);
    audit('statutory_rate_set', r.id, 'confirm', {
      sourceNote: p.sourceNote,
      actor
    });
  })();
  return rateSet(scoped('statutory_rate_sets', companyId, r.id));
}
function signature(companyId) {
  company(companyId);
  const tables = ['payroll_settings', 'employee_payroll_policies', 'employee_pay_rates', 'pay_components', 'employee_components', 'statutory_rate_sets'];
  return hash(tables.map(t => getDb().prepare(`SELECT * FROM ${t} WHERE company_id=? ORDER BY rowid`).all(companyId)));
}
module.exports = {
  getSettings,
  updateSettings,
  getEmployeePolicy,
  setEmployeePolicy,
  listPayRates,
  setPayRate,
  listComponents,
  saveComponent,
  listEmployeeComponents,
  setEmployeeComponent,
  listRateSets,
  saveRateSet,
  confirmRateSet,
  signature,
  // Shared service-boundary primitives; SQL table names are internal constants only.
  company,
  employee,
  scoped,
  money,
  percent,
  date,
  text,
  choice,
  bool,
  hash,
  audit,
  operation,
  fail
};
