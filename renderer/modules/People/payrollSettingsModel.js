const SETTING_KEYS = Object.freeze([
  'payCycle', 'payday', 'monthlyDivisor', 'fixedDivisor',
  'approvalPolicy', 'loanApprovalPolicy', 'rateChangePolicy', 'postponementPolicy',
  'maxDeductionPercent', 'installmentMinor', 'installmentCurrency',
  'taxRateKhrPerUsd', 'nssfRateKhrPerUsd', 'nssfRateSource',
  'loanRateKhrPerUsd', 'loanRateSource', 'rateSource',
]);

const TAX_SOURCE = [
  'Draft figures only; professional confirmation required.',
  'MEF Prakas No. 575 (19 September 2024), arts. 7, 12–15, 17 and 23: https://www.tax.gov.kh/u6rhf7ogbi6/gdtstream/fb78dfde-8342-4e3c-80e0-84ef81919c70',
  'Sub-Decree No. 48 (11 March 2024), art. 3: https://www.tax.gov.kh/u6rhf7ogbi6/gdtstream/1f25fa42-ed6e-4757-a15f-94ec109aae35',
].join('\n');

export function buildSettingsPatch(value = {}) {
  const patch = {};
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const raw = value[key];
    if (['payday', 'fixedDivisor'].includes(key)) {
      if (key === 'fixedDivisor' && !hasValue(raw)) { patch[key] = null; continue; }
      if (!hasValue(raw)) return null;
      const number = Number(raw);
      if (!Number.isSafeInteger(number)) return null;
      patch[key] = number;
    } else if (key === 'maxDeductionPercent') {
      if (!hasValue(raw)) return null;
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0 || number > 100) return null;
      patch[key] = number;
    } else if (['rateSource', 'nssfRateSource', 'loanRateSource'].includes(key)) {
      patch[key] = hasValue(raw) ? String(raw).trim() : null;
    } else if (key === 'installmentMinor' || ['taxRateKhrPerUsd', 'nssfRateKhrPerUsd', 'loanRateKhrPerUsd'].includes(key)) {
      if (!hasValue(raw)) { patch[key] = null; continue; }
      const number = Number(raw);
      if (!Number.isFinite(number)) return null;
      patch[key] = number;
    } else patch[key] = raw;
  }
  return patch;
}

export function createCompanySaveQueue(write) {
  const tails = new Map();
  return (companyId, patch) => {
    const previous = tails.get(companyId) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => write(companyId, patch));
    tails.set(companyId, current);
    return current.finally(() => { if (tails.get(companyId) === current) tails.delete(companyId); });
  };
}

export function isUnknownMutationOutcome(error) {
  if (error?.code === 'RPC_OUTCOME_UNKNOWN') return true;
  const message = String(error?.message || error || '');
  return /stopped answering(?: before it confirmed)?|operation may still have completed|network error|failed to fetch|fetch failed|connection (?:to the server Mac )?dropped|connection (?:was )?reset/i.test(message);
}

export function rateSetMatchesPayload(rateSet, payload) {
  if (!rateSet || !payload) return false;
  const keys = ['name', 'effectiveFrom', 'effectiveTo', 'sourceNote', 'nssf', 'tax'];
  const canonical = (value, key) => {
    if (Array.isArray(value)) {
      const rows = key === 'components' ? [...value].sort((a, b) => a.key.localeCompare(b.key)) : value;
      return rows.map((row) => canonical(row));
    }
    return value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k], k)])) : value;
  };
  return keys.every((key) => JSON.stringify(canonical(rateSet[key] ?? null, key)) === JSON.stringify(canonical(payload[key] ?? null, key)));
}

export function policyConfirmationPatch(source) {
  const policySource = typeof source === 'string' ? source.trim() : '';
  return policySource ? { policySource, policyConfirmed: true } : null;
}

export function minorToAmount(value, currency) {
  if (value == null || value === '') return '';
  if (!Number.isFinite(Number(value))) return '';
  return currency === 'USD' ? (Number(value) / 100).toFixed(2) : String(value);
}

export function amountToMinor(value, currency) {
  if (!hasValue(value)) return null;
  const amount = Number(value);
  const scaled = currency === 'USD' ? amount * 100 : amount;
  if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-7) return NaN;
  return Math.round(scaled);
}

export function salaryTaxDraft() {
  return {
    name: 'Cambodia salary tax (draft)',
    effectiveFrom: '2024-09-19',
    effectiveTo: '',
    sourceNote: TAX_SOURCE,
    nssfComponents: [],
    taxBrackets: [
      { upperKhr: '1500000', ratePercent: '0' },
      { upperKhr: '2000000', ratePercent: '5' },
      { upperKhr: '8500000', ratePercent: '10' },
      { upperKhr: '12500000', ratePercent: '15' },
      { upperKhr: '', ratePercent: '20' },
    ],
    tax: {
      spouseAllowanceKhr: '150000',
      dependentAllowanceKhr: '150000',
      maxDependents: '',
      nonResidentPercent: '20',
      fringeBenefitPercent: '20',
      pensionDeductible: true,
    },
  };
}

function hasValue(value) {
  return value != null && String(value).trim() !== '';
}

function integer(value, label, { nullable = false, min = 0 } = {}) {
  if (nullable && !hasValue(value)) return null;
  if (!hasValue(value)) throw new Error(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`${label} must be a whole number at least ${min}`);
  return parsed;
}

function percent(value, label) {
  if (!hasValue(value)) throw new Error(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error(`${label} must be between 0 and 100`);
  return parsed;
}

function realDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be a real date`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a real date`);
  return value;
}

function rowsPresent(rows, keys) {
  return rows.some((row) => keys.some((key) => hasValue(row[key])));
}

function serializeBands(rows, label) {
  const bands = [];
  for (const row of rows) {
    const any = hasValue(row.upperKhr) || hasValue(row.baseKhr);
    if (!any) continue;
    if (!hasValue(row.baseKhr)) throw new Error(`${label}: complete or remove each partial band`);
    bands.push({
      upperKhr: integer(row.upperKhr, `${label} upper limit`, { nullable: true, min: 1 }),
      baseKhr: integer(row.baseKhr, `${label} contribution base`, { min: 0 }),
    });
  }
  if (bands.some((row, index) => row.upperKhr === null && index !== bands.length - 1)) {
    throw new Error(`${label}: an open upper limit must be the last row`);
  }
  return bands;
}

function serializeNssf(rows) {
  const components = [];
  for (const row of rows) {
    const bands = serializeBands(row.bands || [], `NSSF ${row.key || 'component'}`);
    const any = hasValue(row.key) || hasValue(row.employeePercent) || hasValue(row.employerPercent) || bands.length;
    if (!any) continue;
    if (!hasValue(row.key) || !hasValue(row.employeePercent) || !hasValue(row.employerPercent)) {
      throw new Error('Complete or remove each partial NSSF component');
    }
    components.push({
      key: row.key.trim(),
      employeePercent: percent(row.employeePercent, `${row.key} employee rate`),
      employerPercent: percent(row.employerPercent, `${row.key} employer rate`),
      ...(bands.length ? { bands } : {}),
    });
  }
  return { components };
}

function serializeTax(draft) {
  const bracketRows = draft.taxBrackets || [];
  const tax = draft.tax || {};
  const any = rowsPresent(bracketRows, ['upperKhr', 'ratePercent'])
    || Object.keys(tax).some((key) => key !== 'pensionDeductible' && hasValue(tax[key]))
    || tax.pensionDeductible === true;
  if (!any) return null;

  const brackets = [];
  for (const row of bracketRows) {
    const rowHasValue = hasValue(row.upperKhr) || hasValue(row.ratePercent);
    if (!rowHasValue) continue;
    if (!hasValue(row.ratePercent)) throw new Error('Complete or remove each partial salary-tax bracket');
    brackets.push({
      upperKhr: integer(row.upperKhr, 'Salary-tax upper limit', { nullable: true, min: 1 }),
      ratePercent: percent(row.ratePercent, 'Salary-tax rate'),
    });
  }
  if (!brackets.length || brackets.some((row, index) => row.upperKhr === null && index !== brackets.length - 1)) {
    throw new Error('Salary-tax brackets need an open upper limit in the final row');
  }

  return {
    brackets,
    spouseAllowanceKhr: integer(tax.spouseAllowanceKhr, 'Spouse allowance'),
    dependentAllowanceKhr: integer(tax.dependentAllowanceKhr, 'Dependent allowance'),
    maxDependents: integer(tax.maxDependents, 'Maximum dependents', { nullable: true }),
    nonResidentPercent: percent(tax.nonResidentPercent, 'Non-resident tax rate'),
    fringeBenefitPercent: percent(tax.fringeBenefitPercent, 'Fringe-benefit tax rate'),
    pensionDeductible: Boolean(tax.pensionDeductible),
  };
}

export function serializeRateSetDraft(draft) {
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (!name) throw new Error('Rate-set name is required');
  const effectiveFrom = realDate(draft.effectiveFrom, 'Effective from');
  const effectiveTo = hasValue(draft.effectiveTo) ? realDate(draft.effectiveTo, 'Effective to') : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw new Error('Effective-to date must be on or after effective-from date');
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name,
    effectiveFrom,
    effectiveTo,
    sourceNote: typeof draft.sourceNote === 'string' && draft.sourceNote.trim() ? draft.sourceNote.trim() : null,
    nssf: {
      ...serializeNssf(draft.nssfComponents || []),
      ...(draft.nssfBands?.length ? { bands: serializeBands(draft.nssfBands, 'Shared NSSF') } : {}),
    },
    tax: serializeTax(draft),
  };
}

export function rateSetToDraft(rateSet) {
  return {
    id: rateSet?.id || null,
    status: rateSet?.status || 'draft',
    name: rateSet?.name || '',
    effectiveFrom: rateSet?.effectiveFrom || '',
    effectiveTo: rateSet?.effectiveTo || '',
    sourceNote: rateSet?.sourceNote || '',
    nssfBands: (rateSet?.nssf?.bands || []).map((band) => ({
      upperKhr: band.upperKhr == null ? '' : String(band.upperKhr),
      baseKhr: String(band.baseKhr ?? ''),
    })),
    nssfComponents: (rateSet?.nssf?.components || []).map((component) => ({
      key: component.key || '',
      employeePercent: String(component.employeePercent ?? ''),
      employerPercent: String(component.employerPercent ?? ''),
      bands: (component.bands || []).map((band) => ({
        upperKhr: band.upperKhr == null ? '' : String(band.upperKhr),
        baseKhr: String(band.baseKhr ?? ''),
      })),
    })),
    taxBrackets: (rateSet?.tax?.brackets || []).map((row) => ({
      upperKhr: row.upperKhr == null ? '' : String(row.upperKhr),
      ratePercent: String(row.ratePercent ?? ''),
    })),
    tax: {
      spouseAllowanceKhr: rateSet?.tax?.spouseAllowanceKhr == null ? '' : String(rateSet.tax.spouseAllowanceKhr),
      dependentAllowanceKhr: rateSet?.tax?.dependentAllowanceKhr == null ? '' : String(rateSet.tax.dependentAllowanceKhr),
      maxDependents: rateSet?.tax?.maxDependents == null ? '' : String(rateSet.tax.maxDependents),
      nonResidentPercent: rateSet?.tax?.nonResidentPercent == null ? '' : String(rateSet.tax.nonResidentPercent),
      fringeBenefitPercent: rateSet?.tax?.fringeBenefitPercent == null ? '' : String(rateSet.tax.fringeBenefitPercent),
      pensionDeductible: rateSet?.tax?.pensionDeductible === true,
    },
  };
}
