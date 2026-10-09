import { useEffect, useRef, useState } from 'react';
import { KioskPayroll } from './KioskPayroll.jsx';
import { kioskContext } from './kioskPayrollModel.js';
import {
  t, displayName, monthRows, lateMinutesText, formatDays, daysText, ppTime, ppDate,
  leaveFormErrors, buildLeaveArgs, correctionFormErrors, buildCorrectionArgs, defaultCorrectionDate,
  errorText, classifyError, REASON_MAX, CORRECTION_REASON_MAX,
} from './kioskLogic.js';

/**
 * After the PIN: the person's OWN records only (kiosk:me → OwnView — the
 * server decides who that is from the session token): this and last month,
 * leave balances, requests waiting, and the two requests a person may make.
 */
export function KioskMe({ lang, view, status, error, notice, sessionToken, onSessionEnded, isSessionCurrent, onDone, onLeave, onCorrection, onRetry }) {
  if (status === 'loading' && !view) return <div className="kiosk-panel" role="status">{t(lang, 'loading')}</div>;
  if (!view) {
    return (
      <div className="kiosk-panel">
        <p className="kiosk-message kiosk-message--error" role="alert">{error || t(lang, 'err_offline')}</p>
        <div className="kiosk-actions">
          <button type="button" className="kiosk-btn kiosk-btn--primary" onClick={onRetry}>{t(lang, 'try_again')}</button>
          <button type="button" className="kiosk-btn" onClick={onDone}>{t(lang, 'done')}</button>
        </div>
      </div>
    );
  }
  const last = view.lastEvent;
  const pendingLeave = view.requests?.leave || [];
  const pendingFix = view.requests?.corrections || [];
  const typeName = (id) => {
    const b = (view.leave || []).find((x) => x.leaveTypeId === id);
    return b ? displayName(b, lang) || b.code : '';
  };

  return (
    <div className="kiosk-me">
      <div className="kiosk-me__head">
        <div>
          <h2 className="kiosk-h2">{t(lang, 'me_title')} · {displayName(view.employee, lang)}</h2>
          {last ? <p className="kiosk-hint">{t(lang, last.kind === 'out' ? 'last_out' : 'last_in', { time: `${last.workDate || ppDate(last.at)} ${ppTime(last.at)}` })}</p> : null}
        </div>
        <div className="kiosk-actions kiosk-actions--end">
          <button type="button" className="kiosk-btn" onClick={onLeave}>{t(lang, 'req_leave')}</button>
          <button type="button" className="kiosk-btn" onClick={onCorrection}>{t(lang, 'req_forgot')}</button>
          <button type="button" className="kiosk-btn kiosk-btn--primary" onClick={onDone}>{t(lang, 'done')}</button>
        </div>
      </div>
      {notice ? <p className="kiosk-message kiosk-message--ok" role="status">{notice}</p> : null}
      {error ? <p className="kiosk-message kiosk-message--error" role="alert">{error}</p> : null}

      <div className="kiosk-me__grid">
        <KioskPayroll lang={lang} sessionToken={sessionToken} employee={view.employee}
          onSessionEnded={onSessionEnded} isSessionCurrent={isSessionCurrent} />
        {[['this_month', view.thisMonth], ['last_month', view.lastMonth]].map(([key, month]) => (
          <section key={key} className="kiosk-card">
            <h3 className="kiosk-h3">{t(lang, key)} <span className="kiosk-muted">{month?.month}</span></h3>
            {month?.totals ? (
              <dl className="kiosk-stats">
                {monthRows(month.totals, month.lateness).map((r) => (
                  <div key={r.key} className="kiosk-stats__row">
                    <dt>{t(lang, r.key)}</dt>
                    <dd>{r.key === 'late_minutes' ? lateMinutesText(lang, r) : formatDays(r.value)}</dd>
                  </div>
                ))}
              </dl>
            ) : <p className="kiosk-muted">{t(lang, 'no_records')}</p>}
          </section>
        ))}

        <section className="kiosk-card">
          <h3 className="kiosk-h3">{t(lang, 'leave_title')}</h3>
          {(view.leave || []).length ? (
            <dl className="kiosk-stats">
              {view.leave.map((b) => (
                <div key={b.leaveTypeId} className="kiosk-stats__row">
                  <dt>{displayName(b, lang) || b.code}</dt>
                  <dd>
                    <span>{b.tracksBalance ? `${t(lang, 'balance')} ${formatDays(b.balance)}` : t(lang, 'not_tracked')}</span>
                    <span className="kiosk-muted">{t(lang, 'taken')} {formatDays(b.takenThisYear)}{b.pendingDays ? ` · ${t(lang, 'pending')} ${formatDays(b.pendingDays)}` : ''}</span>
                  </dd>
                </div>
              ))}
            </dl>
          ) : <p className="kiosk-muted">{t(lang, 'no_records')}</p>}
        </section>

        <section className="kiosk-card">
          <h3 className="kiosk-h3">{t(lang, 'requests_title')}</h3>
          {pendingLeave.length + pendingFix.length === 0 ? <p className="kiosk-muted">{t(lang, 'no_requests')}</p> : (
            <ul className="kiosk-list">
              {pendingLeave.map((r) => (
                <li key={r.id}>{t(lang, 'request_leave_item', { type: typeName(r.leaveTypeId), from: r.fromDate, to: r.toDate || r.fromDate })} · {daysText(lang, r.days)}</li>
              ))}
              {pendingFix.map((c) => (
                <li key={c.id}>{t(lang, 'request_correction_item', { date: c.workDate })}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function FormErrors({ lang, keys }) {
  if (!keys.length) return null;
  return <p className="kiosk-message kiosk-message--error" role="alert">{keys.map((k) => t(lang, k)).join(' ')}</p>;
}

// A request belongs to the form instance AND the PIN session that submitted it.
function useRequestCurrent(sessionToken, employee, isSessionCurrent) {
  const context = kioskContext(sessionToken, employee);
  const current = useRef(context);
  current.current = context;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return () => mounted.current && !!context && current.current === context && isSessionCurrent(context);
}

/** Request leave: type, dates, half day, reason → kiosk:requestLeave. */
export function KioskLeaveForm({ lang, view, sessionToken, onSent, onCancel, onSessionEnded, isSessionCurrent }) {
  const today = ppDate(Date.now());
  const [form, setForm] = useState({ leaveTypeId: '', fromDate: today, toDate: '', halfDay: '', reason: '' });
  const [shown, setShown] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isCurrent = useRequestCurrent(sessionToken, view?.employee, isSessionCurrent);
  const set = (patch) => { setShown([]); setError(null); setForm((f) => ({ ...f, ...patch })); };
  const types = (view?.leave || []);

  async function submit(e) {
    e.preventDefault();
    if (!isCurrent()) return;
    const errs = leaveFormErrors(form);
    setShown(errs);
    if (errs.length || busy) return;
    setBusy(true); setError(null);
    try {
      await window.api.kiosk.requestLeave(buildLeaveArgs(form, sessionToken));
      if (!isCurrent()) return;
      onSent();
    } catch (err) {
      if (!isCurrent()) return;
      if (classifyError(err).kind === 'sessionEnded') { onSessionEnded(); return; }
      setError(err);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  return (
    <form className="kiosk-form" onSubmit={submit}>
      <h2 className="kiosk-h2">{t(lang, 'req_leave')}</h2>
      <fieldset className="kiosk-field">
        <legend>{t(lang, 'leave_type')}</legend>
        <div className="kiosk-choice">
          {types.map((b) => (
            <button key={b.leaveTypeId} type="button" aria-pressed={form.leaveTypeId === b.leaveTypeId}
              className={`kiosk-btn kiosk-choice__item${form.leaveTypeId === b.leaveTypeId ? ' is-on' : ''}`}
              onClick={() => set({ leaveTypeId: b.leaveTypeId })}>
              {displayName(b, lang) || b.code}
              {b.tracksBalance ? <span className="kiosk-muted"> · {t(lang, 'balance')} {formatDays(b.balance)}</span> : null}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="kiosk-form__row">
        <label className="kiosk-field">
          <span>{t(lang, 'from_date')}</span>
          <input type="date" className="kiosk-input" value={form.fromDate} onChange={(e) => set({ fromDate: e.target.value })} />
        </label>
        <label className="kiosk-field">
          <span>{t(lang, 'to_date')}</span>
          <input type="date" className="kiosk-input" value={form.toDate} min={form.fromDate || undefined} onChange={(e) => set({ toDate: e.target.value })} />
        </label>
      </div>
      <fieldset className="kiosk-field">
        <legend>{t(lang, 'day_part')}</legend>
        <div className="kiosk-choice">
          {[['', 'full_day'], ['am', 'morning'], ['pm', 'afternoon']].map(([v, key]) => (
            <button key={key} type="button" aria-pressed={form.halfDay === v}
              className={`kiosk-btn kiosk-choice__item${form.halfDay === v ? ' is-on' : ''}`}
              onClick={() => set({ halfDay: v })}>{t(lang, key)}</button>
          ))}
        </div>
      </fieldset>
      <label className="kiosk-field">
        <span>{t(lang, 'reason_optional')}</span>
        <textarea className="kiosk-input kiosk-input--area" rows={2} maxLength={REASON_MAX} value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
      </label>
      <FormErrors lang={lang} keys={shown} />
      {error ? <p className="kiosk-message kiosk-message--error" role="alert">{errorText(error, lang)}</p> : null}
      <div className="kiosk-actions">
        <button type="button" className="kiosk-btn" onClick={onCancel} disabled={busy}>{t(lang, 'cancel')}</button>
        <button type="submit" className="kiosk-btn kiosk-btn--primary" disabled={busy}>{busy ? t(lang, 'saving') : t(lang, 'send')}</button>
      </div>
    </form>
  );
}

/** "I forgot to clock out" → kiosk:requestCorrection — a REQUEST, never an event. */
export function KioskCorrectionForm({ lang, view, sessionToken, onSent, onCancel, onSessionEnded, isSessionCurrent }) {
  const [form, setForm] = useState({ workDate: defaultCorrectionDate(view), outTime: '', inTime: '', reason: '' });
  const [shown, setShown] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const isCurrent = useRequestCurrent(sessionToken, view?.employee, isSessionCurrent);
  const set = (patch) => { setShown([]); setError(null); setForm((f) => ({ ...f, ...patch })); };

  async function submit(e) {
    e.preventDefault();
    if (!isCurrent()) return;
    const errs = correctionFormErrors(form);
    setShown(errs);
    if (errs.length || busy) return;
    setBusy(true); setError(null);
    try {
      await window.api.kiosk.requestCorrection(buildCorrectionArgs(form, sessionToken));
      if (!isCurrent()) return;
      onSent();
    } catch (err) {
      if (!isCurrent()) return;
      if (classifyError(err).kind === 'sessionEnded') { onSessionEnded(); return; }
      setError(err);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  return (
    <form className="kiosk-form" onSubmit={submit}>
      <h2 className="kiosk-h2">{t(lang, 'req_forgot')}</h2>
      <p className="kiosk-hint">{t(lang, 'forgot_note')}</p>
      <div className="kiosk-form__row">
        <label className="kiosk-field">
          <span>{t(lang, 'forgot_date')}</span>
          <input type="date" className="kiosk-input" value={form.workDate} max={ppDate(Date.now())} onChange={(e) => set({ workDate: e.target.value })} />
        </label>
        <label className="kiosk-field">
          <span>{t(lang, 'forgot_out_time')}</span>
          <input type="time" className="kiosk-input" value={form.outTime} onChange={(e) => set({ outTime: e.target.value })} />
        </label>
        <label className="kiosk-field">
          <span>{t(lang, 'forgot_in_time')}</span>
          <input type="time" className="kiosk-input" value={form.inTime} onChange={(e) => set({ inTime: e.target.value })} />
        </label>
      </div>
      <label className="kiosk-field">
        <span>{t(lang, 'reason')}</span>
        <textarea className="kiosk-input kiosk-input--area" rows={2} maxLength={CORRECTION_REASON_MAX} value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
      </label>
      <FormErrors lang={lang} keys={shown} />
      {error ? <p className="kiosk-message kiosk-message--error" role="alert">{errorText(error, lang)}</p> : null}
      <div className="kiosk-actions">
        <button type="button" className="kiosk-btn" onClick={onCancel} disabled={busy}>{t(lang, 'cancel')}</button>
        <button type="submit" className="kiosk-btn kiosk-btn--primary" disabled={busy}>{busy ? t(lang, 'saving') : t(lang, 'send')}</button>
      </div>
    </form>
  );
}
