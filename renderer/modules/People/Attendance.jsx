/**
 * People → Attendance (HR1, docs/PEOPLE_AND_FUEL_PLAN.md §5.1, §10).
 *
 *   Day       everyone on one date: in / out, worked, late, overtime, status
 *   Month     person × day grid (present / late / absent / leave / holiday /
 *             suspended / not employed); a cell opens that day's detail —
 *             events, photos (hr.manage), add a manual entry, void
 *   Totals    the month per person: days worked, hours, late and early-leave
 *             minutes, absences, leave, missing clock-outs, overtime
 *
 * Everything is computed by the server at read time; nothing here changes a
 * figure except through Add manual entry / Void (reasons required). Export
 * month writes the same workbook as `hr:getMonthWorkbook` (no ID / bank data).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Badge, Button, EmptyState, Input, Pagination, cx, paginate } from '../../components/ui.jsx';
import { PageHeader } from '../../components/PageHeader.jsx';
import { NoCompanyState } from '../Companies/NoCompanyState.jsx';
import { LoadError } from '../Fuel/FuelShared.jsx';
import { useHrCaps, useHrLookups, useHrTick } from './hrHooks.js';
import { DayDetailModal, DayStatusBadge, HrPermissionNote, ManualEntryModal, MonthSelect, PersonCell } from './HrShared.jsx';
import {
  GRID_LEGEND, WEEKDAYS, dayStatusOf, errText, fmtHmOn, fmtHours, fmtMinutes, fmtWorkDate, gridCell, monthDates,
  monthLabel, otTotal, ppDateKey, ppMonthKey, weekdayMon0,
} from './hrModel.js';

const VIEWS = [{ value: 'day', label: 'Day' }, { value: 'month', label: 'Month' }, { value: 'totals', label: 'Month totals' }];
const TICK_KINDS = ['attendance', 'correction', 'leave', 'holiday', 'schedule', 'staff', 'overtime', 'lateness', 'settings'];

export function Attendance() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const addToast = useAppStore((s) => s.addToast);
  const { canView, canManage } = useHrCaps();
  const lookups = useHrLookups();
  const tick = useHrTick(TICK_KINDS);
  const [view, setView] = useState('day');
  const [date, setDate] = useState(ppDateKey());
  const [month, setMonth] = useState(ppMonthKey());
  const [q, setQ] = useState('');
  const [dayData, setDayData] = useState(null);
  const [monthData, setMonthData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(null); // { employee, date, day }
  const [manual, setManual] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // A company switch: nothing of the last company stays on screen.
  useEffect(() => { setDayData(null); setMonthData(null); setOpen(null); setError(null); }, [activeCompanyId]);
  useEffect(() => { setPage(0); }, [view, date, month, q, pageSize, activeCompanyId]);

  useEffect(() => {
    if (!activeCompanyId || !canView) return undefined;
    let alive = true;
    setLoading(true);
    setError(null);
    const call = view === 'day'
      ? window.api.attendance.day(date).then((d) => { if (alive) setDayData(d); })
      : window.api.attendance.monthSummary({ month, withDays: view === 'month' }).then((d) => { if (alive) setMonthData(d); });
    call.catch((err) => { if (alive) setError(errText(err)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeCompanyId, canView, view, date, month, tick, retry]);

  const staffById = lookups.maps.staff;
  const needle = q.trim().toLowerCase();
  const match = (r) => !needle || [r.nameEn, r.nameKm, r.staffCode].some((v) => String(v || '').toLowerCase().includes(needle));
  const dayRows = useMemo(() => (dayData?.date === date ? dayData.rows : []).filter(match), [dayData, date, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const monthRows = useMemo(() => (monthData?.month === month ? monthData.rows : []).filter(match), [monthData, month, needle]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = view === 'day' ? dayRows : monthRows;
  const { currentPage, maxPage, pageStart, pageEnd } = paginate(rows.length, page, pageSize);

  const exportKey = view === 'day' ? date.slice(0, 7) : month;
  async function exportMonth() {
    setExporting(true);
    try {
      const saved = await window.api.hr.saveMonthWorkbook(exportKey);
      if (saved) addToast(`Exported to ${saved}`, 'success');
    } catch (err) { addToast(errText(err), 'error'); }
    finally { setExporting(false); }
  }

  if (!activeCompanyId) return <div className="page"><PageHeader title="Attendance" /><NoCompanyState purpose="see its attendance" /></div>;
  if (!canView) return <div className="page"><PageHeader title="Attendance" /><HrPermissionNote /></div>;

  const person = (r) => staffById.get(r.employeeId) || { id: r.employeeId, nameEn: r.nameEn, nameKm: r.nameKm, staffCode: r.staffCode };
  const openDay = (r, d, day = null) => setOpen({ employee: person(r), date: d, day });

  return (
    <div className="page page--attendance">
      <PageHeader
        title="Attendance"
        subtitle="Worked out from the clock entries, the schedules, holidays and leave — times in Phnom Penh."
        actions={(
          <>
            <Button onClick={exportMonth} disabled={exporting}>{exporting ? 'Exporting…' : `Export ${monthLabel(exportKey)}…`}</Button>
            {canManage ? <Button variant="primary" onClick={() => setManual(true)}>+ Manual entry…</Button> : null}
          </>
        )}
      />
      <div className="toolbar">
        <div className="search-wrap">
          <svg className="search-wrap__icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 9l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input type="search" className="search-input" placeholder="Search name or code…" aria-label="Search staff" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {view === 'day' ? (
          <>
            <Button size="sm" variant="ghost" aria-label="Previous day" onClick={() => setDate((d) => shift(d, -1))}>←</Button>
            <Input type="date" aria-label="Day" className="hr-date-input" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <Button size="sm" variant="ghost" aria-label="Next day" onClick={() => setDate((d) => shift(d, 1))}>→</Button>
            {date !== ppDateKey() ? <Button size="sm" variant="ghost" onClick={() => setDate(ppDateKey())}>Today</Button> : null}
          </>
        ) : <MonthSelect value={month} onChange={setMonth} />}
        <span className="toolbar__count">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>
        <div className="toolbar__spacer" />
        <div className="segments" role="tablist" aria-label="View">
          {VIEWS.map((v) => <button key={v.value} type="button" className={`segment${view === v.value ? ' is-active' : ''}`} onClick={() => setView(v.value)}>{v.label}</button>)}
        </div>
      </div>

      {error ? <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} /> : null}
      {loading && !rows.length ? <p className="muted">Loading…</p> : !error && rows.length === 0 ? (
        <EmptyState
          title={needle ? 'Nobody matches' : 'No staff to show'}
          body={needle ? 'Try a shorter search.' : 'Add staff on the Staff page; their attendance appears here once they clock in.'}
        />
      ) : null}

      {view === 'day' && rows.length ? (
        <div className="data-table-wrap">
          <table className="data-table data-table--sticky">
            <thead>
              <tr><th>Person</th><th>Status</th><th>In</th><th>Out</th><th className="is-num">Worked</th><th className="is-num">Late</th><th className="is-num">Left early</th><th className="is-num">Overtime</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {rows.slice(pageStart, pageEnd).map((r) => (
                <tr key={r.employeeId} className="is-clickable" onClick={() => openDay(r, date, r)}>
                  <td><PersonCell employee={person(r)} size={30} sub={r.staffCode} /></td>
                  <td><DayStatusBadge status={r.status} /></td>
                  <td>{fmtHmOn(r.firstIn, date)}</td>
                  <td>{fmtHmOn(r.lastOut, date)}</td>
                  <td className="is-num">{r.workedMin ? fmtHours(r.workedMin) : '—'}</td>
                  <td className="is-num">{r.lateMin ? `${r.lateMin} min` : '—'}</td>
                  <td className="is-num">{r.earlyLeaveMin ? `${r.earlyLeaveMin} min` : '—'}</td>
                  <td className="is-num">{otTotal(r.overtime) ? fmtMinutes(otTotal(r.overtime)) : '—'}</td>
                  <td>
                    <div className="hr-badges">
                      {r.holiday ? <Badge tone="slate">{r.holiday.nameEn || r.holiday.nameKm || 'Holiday'}</Badge> : null}
                      {r.leave ? <Badge tone="blue">Leave{r.leave.half ? ' ½' : ''}</Badge> : null}
                      {r.missingOut ? <Badge tone="amber">No clock-out</Badge> : null}
                      {r.oddEntries ? <Badge tone="amber">Odd entries</Badge> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {view === 'month' && rows.length ? (
        <MonthGrid month={month} rows={rows.slice(pageStart, pageEnd)} person={person} onOpen={openDay} />
      ) : null}

      {view === 'totals' && rows.length ? (
        <div className="data-table-wrap">
          <table className="data-table data-table--sticky">
            <thead>
              <tr>
                <th>Person</th><th className="is-num">Days worked</th><th className="is-num">Hours</th><th className="is-num">Late</th>
                <th className="is-num">Left early</th><th className="is-num">Absent</th><th className="is-num">Leave</th><th className="is-num">Holidays</th>
                <th className="is-num">No clock-out</th><th className="is-num">Overtime</th><th className="is-num">Overtime approved</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(pageStart, pageEnd).map((r) => {
                const t = r.totals || {};
                return (
                  <tr key={r.employeeId}>
                    <td><PersonCell employee={person(r)} size={30} sub={r.staffCode} /></td>
                    <td className="is-num">{t.daysWorked ?? '—'}</td>
                    <td className="is-num">{fmtHours(t.workedMin)}</td>
                    <td className="is-num hr-nowrap">{t.lateMin ? `${t.lateMin} min · ${t.lateDays} d` : '—'}</td>
                    <td className="is-num hr-nowrap">{t.earlyLeaveMin ? `${t.earlyLeaveMin} min · ${t.earlyLeaveDays} d` : '—'}</td>
                    <td className="is-num">{t.absentDays || '—'}</td>
                    <td className="is-num">{t.leaveDays || '—'}</td>
                    <td className="is-num">{t.holidays || '—'}</td>
                    <td className="is-num">{t.missingOutDays ? <Badge tone="amber">{t.missingOutDays}</Badge> : '—'}</td>
                    <td className="is-num">{otTotal(t.overtimeComputed) ? fmtHours(otTotal(t.overtimeComputed)) : '—'}</td>
                    <td className="is-num">{otTotal(t.overtimeComputed) ? fmtHours(otTotal(t.overtimeApproved)) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {rows.length ? (
        <Pagination total={rows.length} pageStart={pageStart} pageEnd={pageEnd} currentPage={currentPage} maxPage={maxPage} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={setPageSize} />
      ) : null}

      <DayDetailModal open={!!open} employee={open?.employee} date={open?.date} day={open?.day} canManage={canManage} onClose={() => setOpen(null)} />
      <ManualEntryModal open={manual} staff={lookups.staff} onClose={() => setManual(false)} />
    </div>
  );
}

function shift(date, n) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return new Date(ms + n * 86_400_000).toISOString().slice(0, 10);
}

/** Person × day. One letter per cell; colour and a tooltip say the rest. The month's totals are the next view. */
function MonthGrid({ month, rows, person, onOpen }) {
  const dates = monthDates(month);
  return (
    <>
      <div className="data-table-wrap hr-grid-wrap">
        <table className="data-table hr-grid">
          <thead>
            <tr>
              <th className="hr-grid__person">Person</th>
              {dates.map((d) => (
                <th key={d} className={cx('hr-grid__day', weekdayMon0(d) === 6 && 'is-sunday')} title={fmtWorkDate(d)}>
                  <span>{Number(d.slice(8))}</span>
                  <span className="hr-grid__wd">{WEEKDAYS[weekdayMon0(d)].slice(0, 2)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const byDate = new Map((r.days || []).map((d) => [d.date, d]));
              return (
                <tr key={r.employeeId}>
                  <td className="hr-grid__person"><PersonCell employee={person(r)} size={24} /></td>
                  {dates.map((d) => {
                    const day = byDate.get(d);
                    const c = gridCell(day || { date: d, status: 'not_employed' });
                    // A day still to come opens nothing (a holiday ahead still shows its H).
                    const clickable = day && day.status !== 'not_employed' && day.status !== 'future';
                    return (
                      <td key={d} className="hr-grid__cell">
                        {clickable ? (
                          <button type="button" className={`hr-cell hr-cell--${c.tone} hr-cell--${c.status}`} title={c.title} aria-label={c.title} onClick={() => onOpen(r, d, day)}>
                            {c.letter}
                          </button>
                        ) : <span className={`hr-cell ${day?.status === 'future' ? 'hr-cell--future' : 'hr-cell--none'}`} title={c.title} />}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="hr-legend" aria-label="Legend">
        {GRID_LEGEND.map((k) => {
          const s = dayStatusOf(k);
          return <span key={k} className="hr-legend__item"><span className={`hr-cell hr-cell--${s.tone} hr-cell--${k}`}>{s.letter}</span>{s.label}</span>;
        })}
      </div>
    </>
  );
}
