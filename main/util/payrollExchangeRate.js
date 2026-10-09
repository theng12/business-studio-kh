'use strict';

const XLSX = require('xlsx');
const { isCalendarDate } = require('../db/_fuelUtil');

const SOURCE_URL = 'https://www.tax.gov.kh/en/exchange-rate/export';
const SOURCE = 'gdt-nbc';
const PUBLISHER = 'National Bank of Cambodia';
const SHEET = 'Exchange Rate';
const HEADERS = ['Release Date', 'Currency', 'Rate', 'Published By'];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BYTES = 1024 * 1024;
const MAX_DATA_ROWS = 100;
const TIMEOUT_MS = 15_000;
const MAX_RATE = 100_000;

function isXlsxZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function todayPhnomPenh() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function monthInput(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error('A payroll month is required in YYYY-MM format');
  }
  if (!isCalendarDate(`${value}-15`)) throw new Error('A payroll month must be a real calendar month');
  return value;
}

function releaseDate(value, month) {
  if (typeof value !== 'string') throw new Error('XLSX release date must be a real date');
  const match = /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid XLSX release date: ${value}`);
  const monthNumber = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(match[1]) + 1;
  const date = `${match[3]}-${String(monthNumber).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
  if (!isCalendarDate(date)) throw new Error(`Invalid XLSX release date: ${value}`);
  if (date.slice(0, 7) !== month) throw new Error(`XLSX release date ${date} is outside requested month ${month}`);
  return date;
}

function parseSalaryTaxRateWorkbook(bytes, { month } = {}) {
  month = monthInput(month);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length > MAX_BYTES) throw new Error('Official exchange-rate XLSX exceeds the 1 MiB response limit');
  if (!isXlsxZip(buffer)) throw new Error('Official exchange-rate response is not an XLSX ZIP file');
  const workbook = XLSX.read(buffer, {
    type: 'buffer', cellDates: false, cellStyles: true, dense: true, sheets: SHEET, sheetRows: MAX_DATA_ROWS + 2,
  });
  const sheet = workbook.Sheets[SHEET];
  if (!sheet) throw new Error(`XLSX is missing the expected “${SHEET}” sheet`);
  const fullRange = sheet['!fullref'] || sheet['!ref'];
  const full = fullRange ? XLSX.utils.decode_range(fullRange) : null;
  if (!full || full.e.r + 1 > MAX_DATA_ROWS + 2) throw new Error(`XLSX has more than ${MAX_DATA_ROWS} data rows`);
  if (full.e.c !== HEADERS.length - 1 || sheet['!cols']?.some((column, index) => index >= HEADERS.length && column?.hidden)) {
    throw new Error('XLSX must contain exactly four columns');
  }
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  if (!range || range.e.r + 1 > MAX_DATA_ROWS + 2 || range.e.c !== HEADERS.length - 1) {
    throw new Error(`XLSX must contain at most ${MAX_DATA_ROWS} data rows and exactly four columns`);
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false });
  const headers = (rows[1] || []).slice(0, HEADERS.length).map((value) => String(value).trim());
  if (HEADERS.some((name, index) => headers[index] !== name) || (rows[1] || []).length !== HEADERS.length) {
    throw new Error(`XLSX headers must be exactly: ${HEADERS.join(', ')}`);
  }

  const seen = new Set();
  const rates = [];
  let dataRows = 0;
  for (const row of rows.slice(2)) {
    if (!row.some((value) => String(value).trim() !== '')) continue;
    if (++dataRows > MAX_DATA_ROWS) throw new Error(`XLSX has more than ${MAX_DATA_ROWS} data rows`);
    if (row.length !== HEADERS.length) throw new Error('XLSX data row must contain exactly four columns');
    const date = releaseDate(row[0], month);
    const currency = String(row[1]).trim();
    const key = `${date}:${currency}`;
    if (seen.has(key)) throw new Error(`Duplicate XLSX publication for ${currency} on ${date}`);
    seen.add(key);
    if (!/^[A-Z]{3}\/KHR$/.test(currency)) throw new Error(`Unexpected exchange-rate currency: ${currency}`);
    if (currency !== 'USD/KHR') continue;
    if (String(row[3]).trim() !== PUBLISHER) throw new Error(`USD/KHR publisher must be ${PUBLISHER}`);
    const rawRate = row[2];
    const rate = typeof rawRate === 'number'
      ? rawRate
      : typeof rawRate === 'string' && /^(?:\d+)(?:\.\d+)?$/.test(rawRate.trim())
        ? Number(rawRate.trim())
        : NaN;
    if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE) throw new Error(`USD/KHR rate on ${date} must be positive and no greater than ${MAX_RATE}`);
    rates.push({ date, rate });
  }
  if (!rates.length) throw new Error(`XLSX contains no USD/KHR publication for ${month}`);
  return rates;
}

function readBody(response, signal) {
  const declared = response.headers.get('content-length');
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    cancelBody(response, 'Official exchange-rate XLSX exceeds the 1 MiB response limit');
    throw new Error('Official exchange-rate XLSX exceeds the 1 MiB response limit');
  }
  if (!response.body?.getReader) throw new Error('Official exchange-rate response has no readable body');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const read = () => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error('timeout'));
    const onAbort = () => reject(signal.reason || new Error('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
  return (async () => {
    try {
      while (true) {
        const { done, value } = await read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) throw new Error('Official exchange-rate XLSX exceeds the 1 MiB response limit');
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      cancelReader(reader, error);
      if (signal.aborted) throw new Error('Official exchange-rate fetch timed out', { cause: error });
      throw error;
    }
  })();
}

function cancelBody(response, reason) {
  try { Promise.resolve(response.body?.cancel(reason)).catch(() => {}); } catch (_) { /* body may already be closed */ }
}

function cancelReader(reader, reason) {
  try { Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch (_) { /* stream may already be closed */ }
}

async function fetchSalaryTaxRate({ month: requestedMonth, asOfDate } = {}, { fetchImpl = globalThis.fetch } = {}) {
  const month = monthInput(requestedMonth);
  const today = asOfDate ?? todayPhnomPenh();
  if (!isCalendarDate(today)) throw new Error('asOfDate must be a real date in YYYY-MM-DD format');
  const referenceDate = `${month}-15`;
  if (referenceDate > today) throw new Error(`The statutory 15th (${referenceDate}) is in the future; use the manual-rate fallback until it is published`);

  const [year, monthNumber] = month.split('-');
  const url = new URL(SOURCE_URL);
  url.searchParams.set('for_year', year);
  url.searchParams.set('for_month', String(Number(monthNumber)));
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error', signal });
  } catch (error) {
    if (signal.aborted) throw new Error('Official exchange-rate fetch timed out', { cause: error });
    throw new Error(`Official exchange-rate request failed: ${error?.message || 'network error'}`, { cause: error });
  }
  if (response.status >= 300 && response.status < 400) {
    cancelBody(response, 'redirect refused');
    throw new Error('Official exchange-rate source redirected; redirects are refused');
  }
  if (!response.ok) {
    cancelBody(response, `HTTP ${response.status}`);
    throw new Error(`Official exchange-rate source returned HTTP ${response.status}`);
  }
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mime !== XLSX_MIME) {
    cancelBody(response, 'unexpected content type');
    throw new Error('Official exchange-rate source did not return the expected XLSX content type');
  }
  const bytes = await readBody(response, signal);
  if (!isXlsxZip(bytes)) throw new Error('Official exchange-rate response is not an XLSX ZIP file');

  const rates = parseSalaryTaxRateWorkbook(bytes, { month });
  const exact = rates.find((row) => row.date === referenceDate);
  const selected = exact || rates.filter((row) => row.date < referenceDate).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!selected) throw new Error(`XLSX has no USD/KHR rate on or before ${referenceDate}; enter an official rate manually`);
  if (!exact && today <= referenceDate) throw new Error(`The statutory 15th (${referenceDate}) has not been issued yet; use the manual-rate fallback or retry after publication`);

  const result = {
    month, referenceDate, rateDate: selected.date, khrPerUsd: selected.rate,
    source: SOURCE, sourceUrl: url.toString(), retrievedAt: new Date().toISOString(),
    selection: exact ? 'exact' : 'prior-published-candidate', requiresConfirmation: true,
  };
  if (!exact) result.selectionNote = `The 15th was missing; ${selected.date} is only a prior-published candidate and requires manual confirmation. No holiday is inferred.`;
  return result;
}

module.exports = { fetchSalaryTaxRate, parseSalaryTaxRateWorkbook };
