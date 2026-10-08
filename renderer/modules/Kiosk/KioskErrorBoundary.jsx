import { Component, useEffect, useState } from 'react';
import { t, errorText, crashPlan, formatRecoveryInput } from './kioskLogic.js';

const CRASH_KEY = 'Kiosk.crashes';

function readCrashes() {
  try { return JSON.parse(sessionStorage.getItem(CRASH_KEY) || '[]'); } catch (_) { return []; }
}
function writeCrashes(list) {
  try { sessionStorage.setItem(CRASH_KEY, JSON.stringify(list)); } catch (_) { /* private mode — the plan still stops at 3 per run */ }
}

/**
 * The kiosk screen must never be left blank or crashed on a shop Mac nobody
 * watches. A render error is written to this Mac's crash.log
 * (kioskMode:logError), a plain bilingual "Restarting…" screen is shown and the
 * page reloads after 5 s, then 10 s. After 3 crashes within 2 minutes it stops
 * reloading and stays here: a manager can still leave kiosk mode or close the
 * app with their PIN, or use the recovery code (kioskLogic crashPlan).
 */
export class KioskErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, plan: null };
    this.timer = null;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    try {
      window.api?.kioskMode?.logError(String(error?.message || error), String(error?.stack || info?.componentStack || '')).catch(() => {});
    } catch (_) { /* logging must not throw again */ }
    const plan = crashPlan(readCrashes());
    writeCrashes(plan.recent);
    this.setState({ plan });
    if (plan.reload) this.timer = setTimeout(() => window.location.reload(), plan.delayMs);
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <KioskCrashScreen reloading={!!this.state.plan?.reload} />;
  }
}

/** Self-contained (no shared kiosk components — one of them may be what failed). */
function KioskCrashScreen({ reloading }) {
  const [tiles, setTiles] = useState([]);
  const [status, setStatus] = useState(null);
  const [who, setWho] = useState('');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    window.api.kiosk.tiles().then((list) => setTiles(Array.isArray(list) ? list : [])).catch(() => setTiles([]));
    window.api.kioskMode.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function run(fn) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err); setPin(''); } finally { setBusy(false); }
  }
  const both = (key) => `${t('km', key)} / ${t('en', key)}`;
  const pinOk = /^\d{4,8}$/.test(pin) && !!who;

  return (
    <div className="kiosk kiosk-crash" role="alert">
      <main className="kiosk-main">
        <div className="kiosk-panel">
          <h1 className="kiosk-h1">{t('km', reloading ? 'crash_title' : 'crash_stuck')}</h1>
          <p className="kiosk-h2">{t('en', reloading ? 'crash_title' : 'crash_stuck')}</p>
          <div className="kiosk-actions">
            <button type="button" className="kiosk-btn kiosk-btn--primary" onClick={() => window.location.reload()} disabled={busy}>{both('crash_restart')}</button>
          </div>

          <section className="kiosk-card kiosk-crash__manager">
            <h2 className="kiosk-h3">{both('manager_title')}</h2>
            <div className="kiosk-form__row">
              <label className="kiosk-field">
                <span>{both('crash_who')}</span>
                <select className="kiosk-input" value={who} onChange={(e) => setWho(e.target.value)} disabled={busy}>
                  <option value="">—</option>
                  {tiles.filter((p) => p.hasPin).map((p) => <option key={p.id} value={p.id}>{[p.nameKm, p.nameEn].filter(Boolean).join(' · ')}</option>)}
                </select>
              </label>
              <label className="kiosk-field">
                <span>{both('pin_label')}</span>
                <input className="kiosk-input" type="password" inputMode="numeric" autoComplete="off" value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} disabled={busy} />
              </label>
            </div>
            <div className="kiosk-actions">
              <button type="button" className="kiosk-btn" disabled={busy || !pinOk} onClick={() => run(() => window.api.kioskMode.leave(who, pin))}>{both('manager_leave')}</button>
              <button type="button" className="kiosk-btn" disabled={busy || !pinOk} onClick={() => run(() => window.api.kioskMode.quit(who, pin))}>{both('manager_quit')}</button>
            </div>
            {status?.hasRecoveryCode ? (
              <div className="kiosk-form__row">
                <label className="kiosk-field">
                  <span>{both('recovery_title')}</span>
                  <input className="kiosk-input kiosk-recovery__input" value={code} placeholder="XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false}
                    onChange={(e) => setCode(formatRecoveryInput(e.target.value))} disabled={busy} />
                </label>
                <div className="kiosk-actions">
                  <button type="button" className="kiosk-btn" disabled={busy || code.replace(/-/g, '').length !== 12}
                    onClick={() => run(() => window.api.kioskMode.recover(code))}>{both('recovery_submit')}</button>
                </div>
              </div>
            ) : null}
            {error ? <p className="kiosk-message kiosk-message--error">{errorText(error, 'km')} / {errorText(error, 'en')}</p> : null}
          </section>
        </div>
      </main>
    </div>
  );
}
