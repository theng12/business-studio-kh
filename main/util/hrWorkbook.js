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
    'Late days', 'Late min', 'Late min after review', 'Early-leave min', 'Early-leave min after review', 'Absent days', 'Missing clock-outs',
    // Computed / pending minutes are shown with TODAY's rate (labelled); approved minutes carry
    // the rate stored on each approval — see "Approved OT at approval rates".
    `OT normal computed (min, current rate ${rates.normal ?? 150}%)`, 'approved', 'pending',
    `OT night computed (min, current rate ${rates.night ?? 200}%)`, 'approved', 'pending',
    `OT day off computed (min, current rate ${rates.restDay ?? 200}%)`, 'approved', 'pending',
    `OT holiday computed (min, current rate ${rates.holiday ?? 200}%)`, 'approved', 'pending',
    'Approved OT at approval rates', 'Approved OT, rate-weighted min',
    'Leave days', ...codes.map((c) => `Leave: ${c}`), 'Public holidays',
  ];
  const LABEL = { normal: 'normal', night: 'night', restDay: 'day off', holiday: 'holiday' };
  const byRate = (t) => Object.entries(t.overtimeApprovedByRate || {})
    .flatMap(([k, m]) => Object.entries(m).map(([rate, min]) => `${LABEL[k]} ${min} min @ ${rate}%`)).join('; ');
  const rows = [head];
  for (const r of summary.rows) {
    const t = r.totals;
    const lt = extra.leaveTaken?.get(r.employeeId) || {};
    rows.push([
      r.staffCode, r.nameEn ?? '', r.nameKm ?? '', r.status, t.daysWorked, h(t.workedMin), h(t.regularMin),
      t.lateDays, t.lateMin, r.lateness ? (r.lateness.deductibleLateMin ?? r.lateness.confirmedLateMin) : 'not confirmed', t.earlyLeaveMin,
      r.lateness ? (r.lateness.deductibleEarlyLeaveMin ?? r.lateness.confirmedEarlyLeaveMin) : 'not confirmed', t.absentDays, t.missingOutDays,
      t.overtimeComputed.normal, t.overtimeApproved.normal, t.overtimePending.normal,
      t.overtimeComputed.night, t.overtimeApproved.night, t.overtimePending.night,
      t.overtimeComputed.restDay, t.overtimeApproved.restDay, t.overtimePending.restDay,
      t.overtimeComputed.holiday, t.overtimeApproved.holiday, t.overtimePending.holiday,
      byRate(t), t.overtimeApprovedWeightedMin ?? '',
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
    ['Rates', 'Labour Law defaults, editable in Settings — confirm with the accountant. Approved overtime keeps the rate in force when it was approved; the computed / pending columns are labelled with today\'s rate.'],
    ['After review', 'Late / early-leave minutes payroll may deduct: the confirmed figure, never more than the attendance shows now.'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes), 'Notes');
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const safe = String(extra.companyName || 'company').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
  return { filename: `attendance-${safe}-${summary.month}.xlsx`, bytes };
}

module.exports = { buildAttendanceWorkbook };
