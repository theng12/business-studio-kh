import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Button } from '../../components/ui.jsx';
import { confirm } from '../../components/ConfirmModal.jsx';

const CAMERA_WORDS = {
  granted: 'Allowed',
  denied: 'Blocked — allow it in System Settings → Privacy & Security → Camera → Business Studio KH',
  restricted: 'Blocked by this Mac\'s settings',
  'not-determined': 'Not asked yet',
  unknown: 'Unknown',
};

/** The recovery code, shown once in the confirmation dialog (Khmer + English). */
function RecoveryCodeNote({ code, isClient }) {
  return (
    <div className="kiosk-settings__recovery">
      <p className="settings-note" role="note">
        {isClient
          ? 'Recovery code — it works only while the office Mac is gone or cannot be reached, so no manager PIN can be checked. '
          : 'Recovery code — for when no manager PIN works (forgotten, or locked). '}
        It turns kiosk mode off on this Mac. It is shown only now.
      </p>
      <div className="kiosk-settings__code" aria-label="Recovery code">{code}</div>
      <p className="kiosk-settings__warn" lang="km">សរសេរលេខកូដនេះទុក ហើយរក្សាទុកឱ្យឆ្ងាយពីហាង។</p>
      <p className="kiosk-settings__warn">Write this down and keep it away from the shop.</p>
    </div>
  );
}

/**
 * Settings → Multi-Mac → Attendance kiosk (HR1, docs/PEOPLE_AND_FUEL_PLAN.md
 * §5.2). Machine-local: it turns THIS Mac into the shop's clock-in kiosk
 * (config.json `kioskMode`, via kioskMode:enable, which re-checks the account
 * and relaunches). Turning it off happens on the kiosk screen with a manager
 * PIN — never here — so this panel only ever switches it on.
 */
export function KioskModePanel({ config, addToast }) {
  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [openAtLogin, setOpenAtLogin] = useState(true);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const s = await window.api.kioskMode.status();
      setStatus(s);
      setOpenAtLogin(s.openAtLogin !== false);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }
  useEffect(() => { refresh(); }, []);

  async function askCamera() {
    try {
      const res = await window.api.kioskMode.askCamera();
      addToast?.(`Camera: ${CAMERA_WORDS[res?.status] || res?.status}`, res?.status === 'granted' ? 'success' : 'info');
      refresh();
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  }

  async function enable() {
    // Step 1: a fresh recovery code from main (only its hash is kept), shown ONCE, here.
    let code;
    try {
      ({ code } = await window.api.kioskMode.newRecoveryCode());
    } catch (err) {
      addToast?.(err.message, 'error');
      return;
    }
    const ok = await confirm({
      title: 'Use this Mac as the attendance kiosk?',
      message: 'The app restarts as one full-screen clock-in screen: staff photos, PIN, camera. The sidebar and every other screen are hidden, and the usual quit shortcuts stop working.',
      detail: config?.mode === 'client'
        ? 'To leave kiosk mode later, a manager taps "Manager" on the kiosk screen and enters their own PIN (checked by the office Mac). Make sure at least one manager has a staff record linked to their account and a PIN before you continue.'
        : 'To leave kiosk mode later, a manager taps "Manager" on the kiosk screen and enters their own PIN. (This Mac checked that at least one manager has a PIN.)',
      extra: <RecoveryCodeNote code={code} isClient={config?.mode === 'client'} />,
      confirmLabel: 'I wrote it down — restart as kiosk',
      cancelLabel: 'Not now',
    });
    if (!ok) return; // the code is dropped; the next try makes a new one
    setBusy(true);
    try {
      await window.api.kioskMode.enable(openAtLogin);
      addToast?.('Restarting as the attendance kiosk…', 'info');
    } catch (err) {
      setBusy(false);
      addToast?.(err.message, 'error');
    }
  }

  if (error) return <p className="settings-note" role="alert">{error}</p>;
  if (!status) return <p className="muted" role="status">Loading…</p>;

  const isClient = config?.mode === 'client';
  return (
    <div className="kiosk-settings">
      <p className="settings-note" role="note">
        The shop Mac can be the clock-in kiosk: staff tap their photo, enter their PIN, and the camera takes a
        photo at every clock-in and clock-out. Times always come from the office Mac.
      </p>
      {!isClient ? (
        <p className="settings-note" role="note">
          Recommended: set the shop Mac to <strong>Client</strong> mode, connected with an account whose role has only
          the <strong>Shop kiosk</strong> permission. Then the office Mac refuses everything except clocking, even if
          someone gets past the kiosk screen. On a Standalone or Server Mac the screen lock is the only barrier.
        </p>
      ) : null}
      <div className="kiosk-settings__rows">
        <div className="kiosk-settings__row">
          <span className="kiosk-settings__label">Camera</span>
          <span>{CAMERA_WORDS[status.camera] || status.camera}</span>
          {status.camera !== 'granted' ? <Button size="sm" onClick={askCamera}>Allow camera…</Button> : null}
        </div>
        <label className="kiosk-settings__row">
          <input type="checkbox" checked={openAtLogin} onChange={(e) => setOpenAtLogin(e.target.checked)} />
          <span>Open the kiosk when this Mac starts{status.packaged ? '' : ' (installed app only)'}</span>
        </label>
      </div>
      {!status.canEnable ? (
        <p className="settings-note" role="note">
          {isClient
            ? 'This Mac\'s account cannot run the kiosk. Connect it with the shop kiosk account (permission "Shop kiosk") or a manager account (permission "Manage staff & attendance").'
            : 'Could not confirm this Mac may run the kiosk.'}
        </p>
      ) : null}
      <div className="kiosk-settings__actions">
        <Button variant="primary" onClick={enable} disabled={busy || !status.canEnable}>Use this Mac as the attendance kiosk…</Button>
        <Button onClick={() => setActiveModule('kiosk')}>Preview the kiosk screen</Button>
      </div>
    </div>
  );
}
