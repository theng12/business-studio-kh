'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

let payrollExchangeRate;
try { payrollExchangeRate = require('../main/util/payrollExchangeRate'); } catch (_) { /* RED until the helper exists */ }

test('exports the payroll official-rate fetcher and XLSX parser', () => {
  assert.equal(typeof payrollExchangeRate?.fetchSalaryTaxRate, 'function');
  assert.equal(typeof payrollExchangeRate?.parseSalaryTaxRateWorkbook, 'function');
});

const hasHelper = !!payrollExchangeRate;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;charset=UTF-8';
const URL_SEP_2026 = 'https://www.tax.gov.kh/en/exchange-rate/export?for_year=2026&for_month=9';

function workbookBytes(rows, headers = ['Release Date', 'Currency', 'Rate', 'Published By'], sheet = 'Exchange Rate') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Exchange Rate'], headers, ...rows]), sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function formattedNegativeRateWorkbook() {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Exchange Rate'], ['Release Date', 'Currency', 'Rate', 'Published By'],
    ['September 15, 2026', 'USD/KHR', -4053, 'National Bank of Cambodia'],
  ]);
  sheet.C3.z = '0;0';
  XLSX.utils.book_append_sheet(wb, sheet, 'Exchange Rate');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

function hiddenExtraColumnWorkbook() {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Exchange Rate'], ['Release Date', 'Currency', 'Rate', 'Published By'],
    ['September 15, 2026', 'USD/KHR', '4053', 'National Bank of Cambodia'],
  ]);
  sheet['!cols'] = [{}, {}, {}, {}, { hidden: true }];
  XLSX.utils.book_append_sheet(wb, sheet, 'Exchange Rate');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

function streamResponse({ status = 200, mime = XLSX_MIME, contentLength = '100', cancel = () => {} } = {}) {
  let cancelCount = 0;
  const body = new ReadableStream({
    start() {},
    cancel(reason) { cancelCount++; return cancel(reason); },
  });
  const result = new Response(body, { status, headers: { 'content-type': mime, 'content-length': contentLength } });
  return { response: result, cancelCount: () => cancelCount };
}

function response(bytes, { status = 200, mime = XLSX_MIME, contentLength = bytes.length } = {}) {
  return new Response(bytes, { status, headers: { 'content-type': mime, 'content-length': String(contentLength) } });
}

function fetchFor(bytes, options) {
  return async (url, init) => {
    assert.equal(url, URL_SEP_2026);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.equal(init.headers, undefined);
    return response(bytes, options);
  };
}

function validRows() {
  return [
    ['September 14, 2026', 'USD/KHR', '4050', 'National Bank of Cambodia'],
    ['September 15, 2026', 'USD/KHR', '4053', 'National Bank of Cambodia'],
    ['September 15, 2026', 'THB/KHR', '124', 'National Bank of Cambodia'],
  ];
}

test('selects the explicit month 15th from a real XLSX response', { skip: !hasHelper }, async () => {
  const bytes = workbookBytes(validRows());
  const result = await payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-09', asOfDate: '2026-09-20' }, { fetchImpl: fetchFor(bytes) });
  assert.deepEqual(result, {
    month: '2026-09', referenceDate: '2026-09-15', rateDate: '2026-09-15', khrPerUsd: 4053,
    source: 'gdt-nbc', sourceUrl: URL_SEP_2026, retrievedAt: result.retrievedAt,
    selection: 'exact', requiresConfirmation: true,
  });
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)));
});

test('requires an explicit real month and date', { skip: !hasHelper }, async () => {
  const fetchImpl = async () => { throw new Error('should not fetch'); };
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate({}, { fetchImpl }), /month.*YYYY-MM/i);
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-13', asOfDate: '2026-09-20' }, { fetchImpl }), /month/i);
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-09', asOfDate: '2026-02-30' }, { fetchImpl }), /asOfDate/i);
  let requests = 0;
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate({ month: '0000-01', asOfDate: '2026-09-20' }, {
    fetchImpl: async () => { requests++; return response(workbookBytes(validRows())); },
  }), /month/i);
  assert.equal(requests, 0);
});

test('refuses to fetch a month whose statutory 15th is still in the future', { skip: !hasHelper }, async () => {
  let requests = 0;
  await assert.rejects(
    payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-10', asOfDate: '2026-10-09' }, { fetchImpl: async () => { requests++; } }),
    /15th.*not.*issued|future/i,
  );
  assert.equal(requests, 0);
});

test('labels a prior same-month publication as a candidate requiring confirmation', { skip: !hasHelper }, async () => {
  const rows = [['September 14, 2026', 'USD/KHR', '4050', 'National Bank of Cambodia']];
  const result = await payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-09', asOfDate: '2026-09-20' }, { fetchImpl: fetchFor(workbookBytes(rows)) });
  assert.equal(result.rateDate, '2026-09-14');
  assert.equal(result.selection, 'prior-published-candidate');
  assert.equal(result.requiresConfirmation, true);
  assert.match(result.selectionNote, /manual confirmation/i);
});

test('does not use a prior rate for a future 15th even if older rows exist', { skip: !hasHelper }, async () => {
  await assert.rejects(
    payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-10', asOfDate: '2026-10-09' }, { fetchImpl: fetchFor(workbookBytes([['October 9, 2026', 'USD/KHR', '4069', 'National Bank of Cambodia']])) }),
    /15th.*not.*issued|future/i,
  );
});

test('does not substitute a prior rate on the 15th while publication may still be pending', { skip: !hasHelper }, async () => {
  await assert.rejects(
    payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-09', asOfDate: '2026-09-15' }, {
      fetchImpl: fetchFor(workbookBytes([['September 14, 2026', 'USD/KHR', '4050', 'National Bank of Cambodia']])),
    }),
    /15th.*not been issued/i,
  );
});

test('rejects redirects, non-XLSX success responses, and malformed workbooks', { skip: !hasHelper }, async () => {
  const fetchImpl = async (_url, init) => {
    assert.equal(init.redirect, 'error');
    return response(Buffer.from('<html>login</html>'), { mime: 'text/html' });
  };
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-09', asOfDate: '2026-09-20' }, { fetchImpl }), /content type|XLSX/i);
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-09', asOfDate: '2026-09-20' }, {
    fetchImpl: async () => response(Buffer.from(''), { status: 302 }),
  }), /redirect/i);
  assert.throws(() => payrollExchangeRate.parseSalaryTaxRateWorkbook(Buffer.from('not a zip'), { month: '2026-09' }), /ZIP|XLSX/i);
});

test('enforces declared and streamed body size limits', { skip: !hasHelper }, async () => {
  const good = workbookBytes(validRows());
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate(
    { month: '2026-09', asOfDate: '2026-09-20' }, { fetchImpl: fetchFor(good, { contentLength: 1024 * 1024 + 1 }) },
  ), /1 MiB|size/i);
  const large = Buffer.alloc(1024 * 1024 + 1, 0x41);
  large[0] = 0x50; large[1] = 0x4b;
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate(
    { month: '2026-09', asOfDate: '2026-09-20' }, { fetchImpl: fetchFor(large, { contentLength: 10 }) },
  ), /1 MiB|size/i);
});

test('rejects invalid headers, dates, months, duplicate USD/KHR dates, publisher, and rates', { skip: !hasHelper }, async () => {
  const parse = (rows, headers) => payrollExchangeRate.parseSalaryTaxRateWorkbook(workbookBytes(rows, headers), { month: '2026-09' });
  assert.throws(() => parse(validRows(), ['Date', 'Currency', 'Rate', 'Published By']), /headers/i);
  assert.throws(() => parse([['September 31, 2026', 'USD/KHR', '4053', 'National Bank of Cambodia']]), /date/i);
  assert.throws(() => parse([['October 15, 2026', 'USD/KHR', '4053', 'National Bank of Cambodia']]), /requested month|month/i);
  assert.throws(() => parse([
    ['September 15, 2026', 'USD/KHR', '4053', 'National Bank of Cambodia'],
    ['September 15, 2026', 'USD/KHR', '4054', 'National Bank of Cambodia'],
  ]), /duplicate/i);
  assert.throws(() => parse([['September 15, 2026', 'USD/KHR', '4053', 'Unknown Publisher']]), /publisher/i);
  assert.throws(() => parse([['September 15, 2026', 'USD/KHR', '0', 'National Bank of Cambodia']]), /rate/i);
  assert.throws(() => parse([['September 15, 2026', 'USD/KHR', '100001', 'National Bank of Cambodia']]), /rate/i);
  assert.throws(() => payrollExchangeRate.parseSalaryTaxRateWorkbook(
    workbookBytes([['September 15, 2026', 'USD/KHR', '4053', 'National Bank of Cambodia', 'hidden extra']]),
    { month: '2026-09' },
  ), /four columns|headers/i);
});

test('validates the underlying numeric rate rather than its formatted display', { skip: !hasHelper }, () => {
  const bytes = formattedNegativeRateWorkbook();
  const workbook = XLSX.read(bytes, { type: 'buffer', cellStyles: true });
  assert.equal(workbook.Sheets['Exchange Rate'].C3.v, -4053);
  assert.throws(() => payrollExchangeRate.parseSalaryTaxRateWorkbook(bytes, { month: '2026-09' }), /rate/i);
});

test('rejects a hidden fifth column even when it has no cells', { skip: !hasHelper }, () => {
  const bytes = hiddenExtraColumnWorkbook();
  const workbook = XLSX.read(bytes, { type: 'buffer', cellStyles: true });
  assert.equal(workbook.Sheets['Exchange Rate']['!cols'][4].hidden, true);
  assert.throws(() => payrollExchangeRate.parseSalaryTaxRateWorkbook(bytes, { month: '2026-09' }), /four columns/i);
});

test('caps direct XLSX parsing and rejects a worksheet with more than 100 data rows', { skip: !hasHelper }, () => {
  const oversized = Buffer.alloc(1024 * 1024 + 1);
  oversized.set([0x50, 0x4b, 0x03, 0x04]);
  assert.throws(() => payrollExchangeRate.parseSalaryTaxRateWorkbook(oversized, { month: '2026-09' }), /1 MiB|size/i);

  const rows = Array.from({ length: 15_000 }, (_, index) => {
    let n = index;
    let code = '';
    for (let i = 0; i < 3; i++) { code = String.fromCharCode(65 + (n % 26)) + code; n = Math.floor(n / 26); }
    return ['September 15, 2026', `${index < 100 ? code : 'ZZZ'}/KHR`, '4053', 'National Bank of Cambodia'];
  });
  const bytes = workbookBytes(rows);
  assert.ok(bytes.length < 1024 * 1024);
  assert.throws(() => payrollExchangeRate.parseSalaryTaxRateWorkbook(bytes, { month: '2026-09' }), /more than 100/i);
});

test('cancels rejected response bodies without waiting for cancellation to settle', { skip: !hasHelper }, async () => {
  for (const [name, options, expected] of [
    ['redirect', { status: 302 }, /redirect/i],
    ['HTTP error', { status: 503 }, /HTTP 503/i],
    ['wrong MIME', { mime: 'text/html' }, /content type/i],
    ['declared oversize', { contentLength: String(1024 * 1024 + 1) }, /1 MiB|size/i],
  ]) {
    const controlled = streamResponse({ ...options, cancel: () => new Promise(() => {}) });
    const reject = payrollExchangeRate.fetchSalaryTaxRate(
      { month: '2026-09', asOfDate: '2026-09-20' },
      { fetchImpl: async () => controlled.response },
    ).then(() => { throw new Error(`${name} response unexpectedly resolved`); }, (error) => error);
    const error = await Promise.race([
      reject,
      new Promise((_, fail) => setTimeout(() => fail(new Error(`${name} rejection waited on body cancellation`)), 100)),
    ]);
    assert.match(error.message, expected);
    assert.equal(controlled.cancelCount(), 1, `${name} body was not cancelled`);
  }
});

test('rejects a response with no 15th or prior USD/KHR publication', { skip: !hasHelper }, async () => {
  await assert.rejects(payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-09', asOfDate: '2026-09-20' }, { fetchImpl: fetchFor(workbookBytes([['September 15, 2026', 'THB/KHR', '124', 'National Bank of Cambodia']])) }), /USD\/KHR/i);
});

test('aborts the response-body read on the operation deadline', { skip: !hasHelper }, async () => {
  const originalTimeout = AbortSignal.timeout;
  const timer = new AbortController();
  AbortSignal.timeout = () => timer.signal;
  try {
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = payrollExchangeRate.fetchSalaryTaxRate({ month: '2026-09', asOfDate: '2026-09-20' }, {
      fetchImpl: async () => {
        started();
        return new Response(new ReadableStream({ start() {}, cancel() { return new Promise(() => {}); } }), {
          headers: { 'content-type': XLSX_MIME, 'content-length': '100' },
        });
      },
    });
    await entered;
    timer.abort(new Error('deadline elapsed'));
    const rejection = assert.rejects(pending, /timed out/i);
    await Promise.race([rejection, new Promise((_, fail) => setTimeout(() => fail(new Error('deadline rejection waited on body cancellation')), 100))]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});
