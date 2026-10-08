/**
 * HR1: the monthly attendance workbook — one row per person (days worked,
 * late / early-leave minutes and whether they are confirmed, overtime by
 * category computed / approved / pending, leave days, absences) plus a day
 * sheet and the notes. SheetJS, like the fuel workbook (main/util/fuelWorkbook.js);
 * returns the bytes so the Mac (Save dialog), a client Mac (bytes over RPC)
 * and any other caller share one builder.
 *
 * No ID / bank / document data is ever in it — it is readable with hr.view.
 */

const XLSX = require('xlsx');

const h = (min) => Math.round((Number(min) || 0) / 6) / 10; // minutes → hours, 1 decimal

/**
 * @param {object} summary   attendance.monthSummary(…, { withDays: true })
 * @param {object} extra     { companyName, leaveTaken: Map<employeeId, { [code]: days }>, leaveCodes: string[] }
 */
function buildAttendanceWorkbook(summary, extra = {}) {
  const wb = XLSX.utils.book_new();
  const codes = extra.leaveCodes || [];
  const rates = summary.settings?.otRates || {};
  const head = [
    'Staff code', 'Name (English)', 'Name (Khmer)', 'Status', 'Days worked', 'Hours worked', 'Regular hours',
    'Late days', 'Late min', 'Late min confirmed', 'Early-leave min', 'Early-leave min confirmed', 'Absent days', 'Missing clock-outs',
    `OT normal ${rates.normal ?? 150}% (min) computed`, 'approved', 'pending',
    `OT night ${rates.night ?? 200}% (min) computed`, 'approved', 'pending',
    `OT day off ${rates.restDay ?? 200}% (min) computed`, 'approved', 'pending',
    `OT holiday ${rates.holiday ?? 200}% (min) computed`, 'approved', 'pending',
    'Leave days', ...codes.map((c) => `Leave: ${c}`), 'Public holidays',
  ];
  const rows = [head];
  for (const r of summary.rows) {
    const t = r.totals;
    const lt = extra.leaveTaken?.get(r.employeeId) || {};
    rows.push([
      r.staffCode, r.nameEn ?? '', r.nameKm ?? '', r.status, t.daysWorked, h(t.workedMin), h(t.regularMin),
      t.lateDays, t.lateMin, r.lateness ? r.lateness.confirmedLateMin : 'not confirmed', t.earlyLeaveMin,
      r.lateness ? r.lateness.confirmedEarlyLeaveMin : 'not confirmed', t.absentDays, t.missingOutDays,
      t.overtimeComputed.normal, t.overtimeApproved.normal, t.overtimePending.normal,
      t.overtimeComputed.night, t.overtimeApproved.night, t.overtimePending.night,
      t.overtimeComputed.restDay, t.overtimeApproved.restDay, t.overtimePending.restDay,
      t.overtimeComputed.holiday, t.overtimeApproved.holiday, t.overtimePending.holiday,
      t.leaveDays, ...codes.map((c) => lt[c] || 0), t.holidays,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = head.map((_, i) => ({ wch: i < 3 ? 22 : 12 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');

  const days = [['Staff code', 'Name', 'Date', 'Status', 'First in', 'Last out', 'Worked min', 'Late min', 'Early-leave min', 'OT normal', 'OT night', 'OT day off', 'OT holiday', 'Notes']];
  const time = (ms) => (ms == null ? '' : new Date(ms + 7 * 3600e3).toISOString().slice(11, 16));
  for (const r of summary.rows) {
    for (const d of r.days || []) {
      if (d.status === 'not_employed' || (d.status === 'off' && !d.workedMin)) continue;
      const notes = [d.holiday ? (d.holiday.nameEn || d.holiday.nameKm) : '', d.leave ? `leave ${d.leave.typeCode}${d.leave.half ? ` (${d.leave.half})` : ''}` : '', d.missingOut ? 'no clock-out' : '']
        .filter(Boolean).join('; ');
      days.push([r.staffCode, r.nameEn || r.nameKm || '', d.date, d.status, time(d.firstIn), time(d.lastOut), d.workedMin, d.lateMin, d.earlyLeaveMin,
        d.overtime.normal, d.overtime.night, d.overtime.restDay, d.overtime.holiday, notes]);
    }
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(days), 'Days');

  const notes = [
    ['Attendance workbook', `${extra.companyName || ''} — ${summary.month}`],
    ['Times', 'Phnom Penh time (UTC+7). Times come from the server Mac\'s clock.'],
    ['Late', summary.settings?.lateCountsFrom === 'start' ? 'Minutes after the scheduled start, once the grace period is passed.' : 'Minutes after the scheduled start plus the grace period.'],
    ['Overtime', 'Work days: minutes after the scheduled end (night window = night rate). Weekly day off and public holidays: every minute worked. Payroll pays APPROVED minutes only.'],
    ['Lateness', 'Payroll deducts only a confirmed month ("not confirmed" = not deducted yet).'],
    ['Rates', 'Labour Law defaults, editable in Settings — confirm with the accountant.'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes), 'Notes');
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const safe = String(extra.companyName || 'company').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
  return { filename: `attendance-${safe}-${summary.month}.xlsx`, bytes };
}

module.exports = { buildAttendanceWorkbook };
