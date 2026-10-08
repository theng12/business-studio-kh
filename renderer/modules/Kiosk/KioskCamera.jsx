import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from './kioskLogic.js';

/**
 * The clock-in camera (HR1 §7b: a photo at every clock-in and clock-out).
 *
 * Asks macOS first (kioskMode:askCamera → systemPreferences.askForMediaAccess
 * in main), then opens the webcam with getUserMedia. A photo is REQUIRED: when
 * the camera is blocked or broken the screen says so plainly and offers only
 * "Try again" and the manager path (clock without a photo, with a manager PIN,
 * marked as such) — it never clocks silently without one.
 */
export function KioskCamera({ lang, kind, busy, onCapture, onNoPhoto, onViewRecords, onCancel, message }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [state, setState] = useState('starting'); // starting | live | denied | unavailable
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setState('starting');
      try {
        const asked = await window.api.kioskMode.askCamera();
        if (cancelled) return;
        if (asked?.status === 'denied' || asked?.status === 'restricted') { setState('denied'); return; }
        if (!navigator.mediaDevices?.getUserMedia) { setState('unavailable'); return; }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setState('live');
      } catch (err) {
        if (cancelled) return;
        setState(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'unavailable');
      }
    }
    start();
    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
  }, [attempt]);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (busy || state !== 'live' || !video || !video.videoWidth) return;
    const scale = Math.min(1, 1280 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) { setState('unavailable'); return; }
    onCapture(await blob.arrayBuffer());
  }, [busy, state, onCapture]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter' && state === 'live' && !busy) { e.preventDefault(); capture(); }
      else if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capture, state, busy, onCancel]);

  const problem = state === 'denied' ? t(lang, 'camera_denied') : state === 'unavailable' ? t(lang, 'camera_unavailable') : null;

  return (
    <div className="kiosk-camera">
      <div className={`kiosk-camera__frame${state === 'live' ? ' is-live' : ''}`}>
        <video ref={videoRef} className="kiosk-camera__video" muted playsInline aria-label={t(lang, kind === 'out' ? 'camera_title_out' : 'camera_title_in')} />
        {state === 'starting' ? <div className="kiosk-camera__overlay" role="status">{t(lang, 'camera_starting')}</div> : null}
        {problem ? <div className="kiosk-camera__overlay kiosk-camera__overlay--problem" role="alert">{problem}</div> : null}
        {busy ? <div className="kiosk-camera__overlay" role="status">{t(lang, 'saving')}</div> : null}
      </div>
      {message ? <p className="kiosk-message kiosk-message--error" role="alert">{message}</p> : null}
      <div className="kiosk-actions">
        {problem ? (
          <>
            <button type="button" className="kiosk-btn kiosk-btn--primary" onClick={() => setAttempt((n) => n + 1)} disabled={busy}>{t(lang, 'try_again')}</button>
            <button type="button" className="kiosk-btn" onClick={onNoPhoto} disabled={busy}>{t(lang, 'manager_no_photo')}</button>
          </>
        ) : (
          <button type="button" className="kiosk-btn kiosk-btn--primary kiosk-btn--huge" onClick={capture} disabled={busy || state !== 'live'}>
            {t(lang, kind === 'out' ? 'take_photo_out' : 'take_photo_in')}
          </button>
        )}
      </div>
      {!problem ? <p className="kiosk-hint">{t(lang, 'camera_hint')}</p> : null}
      <div className="kiosk-actions kiosk-actions--quiet">
        <button type="button" className="kiosk-btn kiosk-btn--quiet" onClick={onViewRecords} disabled={busy}>{t(lang, 'view_records')}</button>
        <button type="button" className="kiosk-btn kiosk-btn--quiet" onClick={onCancel} disabled={busy}>{t(lang, 'cancel')}</button>
      </div>
    </div>
  );
}
