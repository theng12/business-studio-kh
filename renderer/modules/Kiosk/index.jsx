import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  t, otherLang, kioskReduce, INITIAL_STATE, inSession, offerRecovery, formatRecoveryInput,
  keypadReduce, canSubmitPin, keyToKeypadAction, PIN_MAX,
  createIdleTimer, needsKeepAlive, SESSION_IDLE_MS, PIN_IDLE_MS, DONE_SECONDS, OFFLINE_RETRY_MS, SEARCH_THRESHOLD,
  classifyError, messageText, confirmationLine, displayName, sortTiles, tileLetters, filterTiles, initials, ppTime,
} from './kioskLogic.js';
import { KioskCamera, makeNoPhotoImage } from './KioskCamera.jsx';
import { KioskMe, KioskLeaveForm, KioskCorrectionForm } from './KioskMe.jsx';

/**
 * HR1: the attendance kiosk screen (docs/PEOPLE_AND_FUEL_PLAN.md §5.2).
 *
 * tiles → PIN → camera → the server decides in / out → full-screen
 * confirmation → back to the tiles after 5 s. After the PIN a person may also
 * see their own records and send a leave or "I forgot to clock out" request.
 *
 * Talks ONLY to kiosk:* (the server — the shop Mac's account has nothing else)
 * and kioskMode:* (this Mac's own window / camera). test/kioskMode.test.js pins
 * that. Times always come from the server; when it cannot be reached the
 * screen says so and nothing is kept on this Mac to send later.
 *
 * `KioskApp` is the locked-down full-screen window (renderer/main.jsx, route
 * #kiosk). `Kiosk` with `preview` is the same screen inside the normal app, for
 * a manager to try it: nothing is locked and "leave" just closes the preview.
 */

export function KioskApp() {
  return <Kiosk preview={false} />;
}

const TILE_PHOTO_CONCURRENCY = 3;

export function Kiosk({ preview = true, onExitPreview }) {
  const [lang, setLang] = useState('km');
  const [state, dispatch] = useReducer(kioskReduce, INITIAL_STATE);
  const [tiles, setTiles] = useState({ status: 'loading', list: [], error: '' });
  // This Mac's kiosk status (has a recovery code?) and whether the office Mac
  // just failed to answer — together they decide if the recovery code is offered.
  const [kioskStatus, setKioskStatus] = useState(null);
  const [unreachable, setUnreachable] = useState(false);
  const [photos, setPhotos] = useState({});
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { err } | { key, vars } — rendered in the current language
  const [me, setMe] = useState({ status: 'idle', view: null, error: null, notice: null });
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState('');
  const [letter, setLetter] = useState(null);
  const [doneLeft, setDoneLeft] = useState(DONE_SECONDS);

  const stateRef = useRef(state);
  stateRef.current = state;
  const idle = useRef(createIdleTimer(SESSION_IDLE_MS));
  const lastServerUse = useRef(0);
  const photoKeys = useRef(new Set());

  /* ── tiles ── */
  const loadTiles = useCallback(async () => {
    try {
      const list = await window.api.kiosk.tiles();
      setTiles({ status: 'ready', list: sortTiles(list || []), error: '' });
      setUnreachable(false);
    } catch (err) {
      const c = classifyError(err);
      setTiles((prev) => ({ status: c.kind === 'offline' ? 'offline' : 'error', list: prev.list, error: err }));
      if (c.kind === 'offline') setUnreachable(true);
    }
  }, []);

  useEffect(() => { loadTiles(); }, [loadTiles]);
  useEffect(() => {
    if (preview) return;
    window.api.kioskMode.status().then(setKioskStatus).catch(() => setKioskStatus(null));
  }, [preview]);

  // Offline or failed: keep trying on its own; otherwise refresh every 5 min for new staff.
  useEffect(() => {
    const ms = tiles.status === 'ready' ? 5 * 60 * 1000 : OFFLINE_RETRY_MS;
    const id = setInterval(() => { if (stateRef.current.screen === 'tiles') loadTiles(); }, ms);
    return () => clearInterval(id);
  }, [tiles.status, loadTiles]);

  // Tile photos, a few at a time; cached by id + photo hash.
  useEffect(() => {
    let cancelled = false;
    const todo = tiles.list.filter((p) => p.hasPhoto && !photoKeys.current.has(`${p.id}:${p.photoSha256}`));
    if (!todo.length) return undefined;
    todo.forEach((p) => photoKeys.current.add(`${p.id}:${p.photoSha256}`));
    let i = 0;
    async function worker() {
      while (!cancelled && i < todo.length) {
        const p = todo[i++];
        try {
          const res = await window.api.kiosk.tilePhoto(p.id);
          if (cancelled || !res?.bytes) continue;
          const url = URL.createObjectURL(new Blob([res.bytes], { type: res.mime || 'image/jpeg' }));
          setPhotos((prev) => {
            if (prev[p.id]) URL.revokeObjectURL(prev[p.id]);
            return { ...prev, [p.id]: url };
          });
        } catch (_) {
          photoKeys.current.delete(`${p.id}:${p.photoSha256}`); // try again on the next refresh
        }
      }
    }
    for (let k = 0; k < TILE_PHOTO_CONCURRENCY; k++) worker();
    return () => { cancelled = true; };
  }, [tiles.list]);

  /* ── session end ── */
  const endSession = useCallback((notice = null) => { // notice: { err } | { key } | null
    const token = stateRef.current.session?.token;
    if (token) window.api.kiosk.signOut(token).catch(() => {});
    setPin(''); setBusy(false); setQuery(''); setLetter(null);
    setMe({ status: 'idle', view: null, error: null, notice: null });
    setMessage(notice);
    dispatch({ type: 'RESET' });
  }, []);

  const sessionEnded = useCallback(() => {
    endSession({ key: 'err_session' });
  }, [endSession]);

  /* ── activity, idle, keep-alive, clock ── */
  useEffect(() => {
    const touch = () => idle.current.touch(Date.now());
    window.addEventListener('pointerdown', touch, true);
    window.addEventListener('keydown', touch, true);
    window.addEventListener('input', touch, true);
    return () => {
      window.removeEventListener('pointerdown', touch, true);
      window.removeEventListener('keydown', touch, true);
      window.removeEventListener('input', touch, true);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      const s = stateRef.current;
      const quietFor = at - idle.current.lastActivity();
      if (inSession(s)) {
        if (quietFor >= SESSION_IDLE_MS && s.screen !== 'saving') { endSession(); return; }
        if (s.session?.token && needsKeepAlive({ lastServerUseAt: lastServerUse.current, lastActivityAt: idle.current.lastActivity(), now: at })) {
          lastServerUse.current = at;
          window.api.kiosk.me(s.session.token).then((view) => {
            if (stateRef.current.session?.token === s.session.token) setMe((m) => ({ ...m, view }));
          }).catch((err) => { if (classifyError(err).kind === 'sessionEnded') endSession({ key: 'err_session' }); });
        }
      } else if (['pin', 'managerMenu', 'managerPick', 'managerPin', 'recovery'].includes(s.screen) && quietFor >= PIN_IDLE_MS) {
        endSession();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [endSession]);

  // A quit was refused by main (Dock, AppleScript…): ask for a manager PIN.
  useEffect(() => {
    if (preview || !window.api.kioskMode?.onQuitRequested) return undefined;
    return window.api.kioskMode.onQuitRequested(() => {
      const token = stateRef.current.session?.token;
      if (token) window.api.kiosk.signOut(token).catch(() => {});
      setPin(''); setBusy(false); setMessage(null);
      idle.current.touch(Date.now());
      dispatch({ type: 'QUIT_REQUESTED' });
    });
  }, [preview]);

  // A fresh tile grid every time it is shown (the manager's pick included).
  useEffect(() => {
    if (state.screen === 'tiles' || state.screen === 'managerPick') { setQuery(''); setLetter(null); }
  }, [state.screen]);

  /* ── the 5-second confirmation ── */
  useEffect(() => {
    if (state.screen !== 'done') return undefined;
    setDoneLeft(DONE_SECONDS);
    const started = Date.now();
    const id = setInterval(() => {
      const left = DONE_SECONDS - Math.floor((Date.now() - started) / 1000);
      setDoneLeft(Math.max(0, left));
      if (left <= 0) { clearInterval(id); endSession(); }
    }, 250);
    return () => clearInterval(id);
  }, [state.screen, endSession]);

  /* ── clocking ── */
  const clockWith = useCallback(async (bytes, noPhotoBy = null) => {
    const s = stateRef.current;
    if (!s.session) return;
    dispatch({ type: 'SAVING' });
    setBusy(true); setMessage(null);
    try {
      const res = await window.api.kiosk.clock(s.session.token, bytes);
      lastServerUse.current = Date.now();
      dispatch({ type: 'CLOCKED', event: res?.event, duplicate: !!res?.duplicate, noPhotoBy: noPhotoBy ? displayName(noPhotoBy, lang) : null });
    } catch (err) {
      if (classifyError(err).kind === 'sessionEnded') { sessionEnded(); return; }
      dispatch({ type: 'CLOCK_FAILED' });
      setMessage({ err });
    } finally {
      setBusy(false);
    }
  }, [lang, sessionEnded]);

  /* ── PIN ── */
  const submitPin = useCallback(async () => {
    const s = stateRef.current;
    if (busy || !canSubmitPin(pin)) return;
    setBusy(true); setMessage(null);
    const typed = pin;
    setPin('');
    try {
      if (s.screen === 'pin') {
        const res = await window.api.kiosk.signIn(s.person.id, typed);
        lastServerUse.current = Date.now();
        idle.current.touch(Date.now());
        dispatch({ type: 'SIGNED_IN', ...res });
      } else if (s.screen === 'managerPin') {
        if (s.managerAction === 'no-photo') {
          await window.api.kiosk.verifyManagerPin(s.manager.id, typed, 'no-photo');
          dispatch({ type: 'MANAGER_OK' });
          await clockWith(await makeNoPhotoImage({ personName: displayName(s.session?.employee || s.person, 'en'), managerName: displayName(s.manager, 'en') }), s.manager);
        } else if (preview) {
          // Preview inside the normal app: nothing is locked, so nothing to unlock.
          await window.api.kiosk.verifyManagerPin(s.manager.id, typed, s.managerAction);
          if (onExitPreview) onExitPreview();
        } else if (s.managerAction === 'leave') {
          await window.api.kioskMode.leave(s.manager.id, typed);
          dispatch({ type: 'MANAGER_OK' }); // the app restarts as a normal window
        } else if (s.managerAction === 'quit') {
          await window.api.kioskMode.quit(s.manager.id, typed);
          dispatch({ type: 'MANAGER_OK' });
        }
      }
    } catch (err) {
      const kind = classifyError(err).kind;
      if (kind === 'offline') setUnreachable(true);
      if (kind === 'sessionEnded') { sessionEnded(); return; }
      // The stand-in picture could not be made: back to the camera screen, still signed in.
      if (stateRef.current.screen === 'saving') dispatch({ type: 'CLOCK_FAILED' });
      if (s.screen === 'pin' && ['locked', 'lockedManager', 'paused', 'noPin', 'cannotClock'].includes(kind)) {
        // Nothing more to try on this person right now: back to the tiles, with the reason.
        endSession({ err });
        return;
      }
      setMessage({ err });
    } finally {
      setBusy(false);
    }
  }, [busy, pin, preview, onExitPreview, endSession, sessionEnded, clockWith]);

  useEffect(() => {
    if (state.screen !== 'pin' && state.screen !== 'managerPin') return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = keyToKeypadAction(e.key);
      if (!action) return;
      e.preventDefault();
      if (action.type === 'submit') submitPin();
      else if (action.type === 'cancel') { setPin(''); setMessage(null); dispatch(state.screen === 'managerPin' ? { type: 'MANAGER_BACK' } : { type: 'RESET' }); }
      else if (!busy) setPin((p) => keypadReduce(p, action));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.screen, submitPin, busy]);

  /* ── own records ── */
  const loadMe = useCallback(async (notice = null) => {
    const token = stateRef.current.session?.token;
    if (!token) return;
    setMe((m) => ({ ...m, status: 'loading', error: null, notice }));
    try {
      const view = await window.api.kiosk.me(token);
      lastServerUse.current = Date.now();
      setMe({ status: 'ready', view, error: null, notice });
    } catch (err) {
      if (classifyError(err).kind === 'sessionEnded') { sessionEnded(); return; }
      setMe((m) => ({ ...m, status: 'error', error: { err } }));
    }
  }, [sessionEnded]);

  const openMe = useCallback((notice = null) => {
    setMessage(null);
    dispatch({ type: 'VIEW_ME' });
    loadMe(notice);
  }, [loadMe]);

  /* ── tile taps ── */
  function tapTile(person) {
    setMessage(null);
    if (state.screen === 'managerPick') { setPin(''); dispatch({ type: 'PICK_MANAGER', person }); return; }
    if (!person.hasPin) { setMessage({ key: 'err_no_pin' }); return; }
    setPin('');
    idle.current.touch(Date.now());
    dispatch({ type: 'PICK_TILE', person });
  }

  /* ── render ── */
  const screen = state.screen;
  const canRecover = offerRecovery({ preview, status: kioskStatus, unreachable });
  const openRecovery = canRecover ? () => { setMessage(null); dispatch({ type: 'OPEN_RECOVERY' }); } : null;
  const visibleTiles = filterTiles(tiles.list, { query, letter });
  const showSearch = tiles.list.length > SEARCH_THRESHOLD;
  const sessionLeft = inSession(state) ? Math.ceil(idle.current.remainingMs(now) / 1000) : null;

  return (
    <div className={`kiosk${preview ? ' kiosk--preview' : ''}`} lang={lang === 'km' ? 'km' : 'en'}>
      <header className="kiosk-bar">
        <div className="kiosk-bar__title">
          <span className="kiosk-bar__app">{t(lang, 'title')}</span>
          {preview ? <span className="kiosk-badge">{t(lang, 'preview_badge')}</span> : null}
        </div>
        <div className="kiosk-bar__clock" aria-label="time">{ppTime(now)}</div>
        <div className="kiosk-bar__right">
          {sessionLeft != null && sessionLeft <= 30 ? <span className="kiosk-muted">{t(lang, 'signing_out_in', { n: sessionLeft })}</span> : null}
          <button type="button" className="kiosk-btn kiosk-btn--small" onClick={() => { setLang(otherLang(lang)); setLetter(null); }}>{t(lang, 'lang_other')}</button>
          {preview && onExitPreview ? <button type="button" className="kiosk-btn kiosk-btn--small" onClick={() => { endSession(); onExitPreview(); }}>{t(lang, 'preview_exit')}</button> : null}
        </div>
      </header>

      <main className="kiosk-main">
        {(screen === 'tiles' || screen === 'managerPick') && (
          <TilesScreen
            lang={lang} tiles={tiles} visible={visibleTiles} photos={photos}
            showSearch={showSearch} query={query} setQuery={setQuery} letter={letter} setLetter={setLetter}
            title={screen === 'managerPick' ? t(lang, 'manager_pick') : t(lang, 'tiles_title')}
            managerMode={screen === 'managerPick'}
            notice={state.notice && screen === 'managerPick' ? t(lang, state.notice) : null}
            message={message}
            onTap={tapTile}
            onRetry={loadTiles}
            onManager={screen === 'tiles' ? () => { setMessage(null); dispatch({ type: 'MANAGER_MENU' }); } : null}
            onBack={screen === 'managerPick' ? () => { setMessage(null); dispatch({ type: 'MANAGER_BACK' }); } : null}
            onRecovery={openRecovery}
          />
        )}

        {(screen === 'pin' || screen === 'managerPin') && (
          <PinScreen
            lang={lang}
            person={screen === 'pin' ? state.person : state.manager}
            photo={photos[(screen === 'pin' ? state.person : state.manager)?.id]}
            title={screen === 'pin' ? t(lang, 'pin_title') : t(lang, 'manager_pin')}
            pin={pin} busy={busy} message={message}
            onKey={(action) => {
              if (action.type === 'submit') submitPin();
              else setPin((p) => keypadReduce(p, action));
            }}
            onBack={() => { setPin(''); setMessage(null); dispatch(screen === 'managerPin' ? { type: 'MANAGER_BACK' } : { type: 'RESET' }); }}
          />
        )}

        {screen === 'camera' && state.session && (
          <div className="kiosk-panel kiosk-panel--wide">
            <h1 className="kiosk-h1">{t(lang, 'hello', { name: displayName(state.session.employee, lang) })}</h1>
            <h2 className="kiosk-h2">{t(lang, state.session.nextKind === 'out' ? 'camera_title_out' : 'camera_title_in')}</h2>
            {state.session.needsCheck ? <p className="kiosk-message kiosk-message--warn" role="status">{t(lang, 'needs_check')}</p> : null}
            <KioskCamera
              lang={lang}
              kind={state.session.nextKind}
              busy={busy}
              message={messageText(message, lang) || null}
              onCapture={(bytes) => clockWith(bytes)}
              onNoPhoto={() => { setMessage(null); setPin(''); dispatch({ type: 'NO_PHOTO' }); }}
              onViewRecords={() => openMe()}
              onCancel={() => endSession()}
            />
          </div>
        )}

        {screen === 'saving' && (
          <div className="kiosk-panel" role="status"><p className="kiosk-h2">{t(lang, 'saving')}</p></div>
        )}

        {screen === 'done' && state.result && (
          <div className={`kiosk-done kiosk-done--${state.result.kind === 'out' ? 'out' : 'in'}`} role="status">
            <p className="kiosk-done__name">{state.session?.employee?.nameKm || ''}{state.session?.employee?.nameKm && state.session?.employee?.nameEn ? ' · ' : ''}{state.session?.employee?.nameEn || ''}</p>
            <p className="kiosk-done__line">{confirmationLine('km', state.result.kind, state.result.at)}</p>
            <p className="kiosk-done__line kiosk-done__line--en">{confirmationLine('en', state.result.kind, state.result.at)}</p>
            {state.result.duplicate ? <p className="kiosk-done__note">{t(lang, 'already_done')}</p> : null}
            {state.result.noPhotoBy ? <p className="kiosk-done__note">{t(lang, 'no_photo_marked', { name: state.result.noPhotoBy })}</p> : null}
            {state.session?.needsCheck ? <p className="kiosk-done__note">{t(lang, 'needs_check')}</p> : null}
            <div className="kiosk-actions">
              <button type="button" className="kiosk-btn" onClick={() => openMe()}>{t(lang, 'view_records')}</button>
              <button type="button" className="kiosk-btn kiosk-btn--primary" onClick={() => endSession()}>{t(lang, 'done')}</button>
            </div>
            <p className="kiosk-muted">{t(lang, 'back_in_n', { n: doneLeft })}</p>
          </div>
        )}

        {screen === 'me' && (
          <KioskMe
            lang={lang} view={me.view} status={me.status} error={messageText(me.error, lang)} notice={messageText(me.notice, lang)}
            onDone={() => endSession()}
            onLeave={() => dispatch({ type: 'OPEN_LEAVE' })}
            onCorrection={() => dispatch({ type: 'OPEN_CORRECTION' })}
            onRetry={() => loadMe()}
          />
        )}

        {screen === 'leave' && state.session && (
          <KioskLeaveForm
            lang={lang} view={me.view} sessionToken={state.session.token}
            onSent={() => { lastServerUse.current = Date.now(); openMe({ key: 'sent_leave' }); }}
            onCancel={() => dispatch({ type: 'VIEW_ME' })}
            onSessionEnded={sessionEnded}
          />
        )}

        {screen === 'correction' && state.session && (
          <KioskCorrectionForm
            lang={lang} view={me.view} sessionToken={state.session.token}
            onSent={() => { lastServerUse.current = Date.now(); openMe({ key: 'sent_correction' }); }}
            onCancel={() => dispatch({ type: 'VIEW_ME' })}
            onSessionEnded={sessionEnded}
          />
        )}

        {screen === 'managerMenu' && (
          <div className="kiosk-panel">
            <h1 className="kiosk-h1">{t(lang, 'manager_title')}</h1>
            <div className="kiosk-actions kiosk-actions--stack">
              <button type="button" className="kiosk-btn kiosk-btn--primary" onClick={() => dispatch({ type: 'MANAGER_ACTION', action: 'leave' })}>
                {preview ? t(lang, 'preview_exit') : t(lang, 'manager_leave')}
              </button>
              {!preview ? <button type="button" className="kiosk-btn" onClick={() => dispatch({ type: 'MANAGER_ACTION', action: 'quit' })}>{t(lang, 'manager_quit')}</button> : null}
              {openRecovery ? <button type="button" className="kiosk-btn" onClick={openRecovery}>{t(lang, 'recovery_offer')}</button> : null}
              <button type="button" className="kiosk-btn" onClick={() => dispatch({ type: 'RESET' })}>{t(lang, 'cancel')}</button>
            </div>
          </div>
        )}

        {screen === 'recovery' && (
          <RecoveryScreen
            lang={lang}
            onBack={() => { setMessage(null); dispatch({ type: 'MANAGER_BACK' }); }}
            onDone={() => dispatch({ type: 'RECOVERY_OK' })}
          />
        )}

        {screen === 'exiting' && (
          <div className="kiosk-panel" role="status"><p className="kiosk-h2">{t(lang, state.managerAction === 'quit' ? 'closing' : 'leaving')}</p></div>
        )}
      </main>
    </div>
  );
}

function Tile({ person, photo, lang, onTap, managerMode }) {
  const disabled = !person.hasPin;
  return (
    <button type="button" className={`kiosk-tile${disabled ? ' is-nopin' : ''}`} onClick={() => onTap(person)}
      aria-label={`${person.nameKm || ''} ${person.nameEn || ''}`.trim()}>
      <span className="kiosk-tile__photo">
        {photo ? <img src={photo} alt="" draggable={false} /> : <span className="kiosk-tile__initials" aria-hidden>{initials(person)}</span>}
      </span>
      <span className="kiosk-tile__name">{displayName(person, lang)}</span>
      <span className="kiosk-tile__sub">{lang === 'km' ? person.nameEn : person.nameKm}</span>
      {disabled && !managerMode ? <span className="kiosk-tile__flag">{t(lang, 'no_pin_yet')}</span> : null}
    </button>
  );
}

function TilesScreen({ lang, tiles, visible, photos, showSearch, query, setQuery, letter, setLetter, title, managerMode, notice, message, onTap, onRetry, onManager, onBack, onRecovery }) {
  const recoveryLink = onRecovery
    ? <div className="kiosk-actions kiosk-actions--quiet"><button type="button" className="kiosk-btn kiosk-btn--quiet" onClick={onRecovery}>{t(lang, 'recovery_offer')}</button></div>
    : null;
  if (tiles.status === 'loading' && !tiles.list.length) {
    return <div className="kiosk-panel" role="status"><p className="kiosk-h2">{t(lang, 'loading')}</p></div>;
  }
  if ((tiles.status === 'offline' || tiles.status === 'error') && !tiles.list.length) {
    return (
      <div className="kiosk-panel kiosk-offline" role="alert">
        <h1 className="kiosk-h1">{tiles.status === 'offline' ? t(lang, 'offline_title') : messageText({ err: tiles.error }, lang)}</h1>
        {tiles.status === 'offline' ? <p className="kiosk-hint">{t(lang, 'offline_body')}</p> : null}
        <div className="kiosk-actions"><button type="button" className="kiosk-btn kiosk-btn--primary" onClick={onRetry}>{t(lang, 'try_again')}</button></div>
        {notice ? <p className="kiosk-message kiosk-message--warn" role="status">{notice}</p> : null}
        {onManager ? <div className="kiosk-actions kiosk-actions--quiet"><button type="button" className="kiosk-btn kiosk-btn--quiet" onClick={onManager}>{t(lang, 'manager')}</button></div> : null}
        {recoveryLink}
      </div>
    );
  }
  const letters = showSearch ? tileLetters(tiles.list, lang) : [];
  return (
    <div className="kiosk-tiles-screen">
      <div className="kiosk-tiles-head">
        {onBack ? <button type="button" className="kiosk-btn kiosk-btn--small" onClick={onBack}>{t(lang, 'back')}</button> : null}
        <h1 className="kiosk-h1">{title}</h1>
      </div>
      {tiles.status === 'offline' ? <p className="kiosk-message kiosk-message--error" role="alert">{t(lang, 'offline_title')} — {t(lang, 'offline_body')}</p> : null}
      {managerMode ? recoveryLink : null}
      {notice ? <p className="kiosk-message kiosk-message--warn" role="status">{notice}</p> : null}
      {message ? <p className="kiosk-message kiosk-message--error" role="alert">{messageText(message, lang)}</p> : null}
      {showSearch ? (
        <div className="kiosk-search">
          <input className="kiosk-input" type="search" value={query} placeholder={t(lang, 'search_placeholder')}
            onChange={(e) => setQuery(e.target.value)} aria-label={t(lang, 'search_placeholder')} />
          <div className="kiosk-letters" role="group">
            <button type="button" className={`kiosk-letter${letter == null ? ' is-on' : ''}`} onClick={() => setLetter(null)}>{t(lang, 'all')}</button>
            {letters.map((l) => (
              <button key={l} type="button" className={`kiosk-letter${letter === l ? ' is-on' : ''}`} onClick={() => setLetter(letter === l ? null : l)}>{l}</button>
            ))}
          </div>
        </div>
      ) : null}
      {tiles.list.length === 0 ? <p className="kiosk-hint">{t(lang, 'no_staff')}</p> : null}
      {tiles.list.length > 0 && visible.length === 0 ? <p className="kiosk-hint">{t(lang, 'no_match')}</p> : null}
      <div className="kiosk-tiles">
        {visible.map((p) => <Tile key={p.id} person={p} photo={photos[p.id]} lang={lang} onTap={onTap} managerMode={managerMode} />)}
      </div>
      {onManager ? (
        <div className="kiosk-actions kiosk-actions--quiet kiosk-actions--end">
          <button type="button" className="kiosk-btn kiosk-btn--quiet" onClick={onManager}>{t(lang, 'manager')}</button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Office Mac unreachable: the recovery code written down when kiosk mode was
 * turned on. Main checks it (and that the office Mac really cannot answer),
 * then turns kiosk mode off and relaunches.
 */
function RecoveryScreen({ lang, onBack, onDone }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (busy || code.replace(/-/g, '').length !== 12) return;
    setBusy(true); setError(null);
    try {
      await window.api.kioskMode.recover(code);
      onDone();
    } catch (err) {
      setError({ err });
      setCode('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="kiosk-panel kiosk-recovery" onSubmit={submit}>
      <h1 className="kiosk-h1">{t(lang, 'recovery_title')}</h1>
      <p className="kiosk-hint">{t(lang, 'recovery_hint')}</p>
      <input
        className="kiosk-input kiosk-recovery__input"
        value={code}
        onChange={(e) => { setError(null); setCode(formatRecoveryInput(e.target.value)); }}
        placeholder="XXXX-XXXX-XXXX"
        aria-label={t(lang, 'recovery_title')}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
      {error ? <p className="kiosk-message kiosk-message--error" role="alert">{messageText(error, lang)}</p> : null}
      <div className="kiosk-actions">
        <button type="button" className="kiosk-btn" onClick={onBack} disabled={busy}>{t(lang, 'back')}</button>
        <button type="submit" className="kiosk-btn kiosk-btn--primary" disabled={busy || code.replace(/-/g, '').length !== 12}>
          {busy ? t(lang, 'checking') : t(lang, 'recovery_submit')}
        </button>
      </div>
    </form>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Person + PIN dots on the left, a 4×3 keypad with OK on the right (fits a 1280×800 screen). */
function PinScreen({ lang, person, photo, title, pin, busy, message, onKey, onBack }) {
  return (
    <div className="kiosk-pin">
      <div className="kiosk-pin__side">
        <div className="kiosk-pin__who">
          <span className="kiosk-tile__photo kiosk-tile__photo--small">
            {photo ? <img src={photo} alt="" draggable={false} /> : <span className="kiosk-tile__initials" aria-hidden>{initials(person)}</span>}
          </span>
          <div>
            <p className="kiosk-h2">{displayName(person, lang)}</p>
            <p className="kiosk-muted">{lang === 'km' ? person?.nameEn : person?.nameKm}</p>
          </div>
        </div>
        <h1 className="kiosk-h1">{title}</h1>
        <div className="kiosk-pin__dots" aria-label={`${pin.length} / ${PIN_MAX}`}>
          {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => <span key={i} className={`kiosk-pin__dot${i < pin.length ? ' is-on' : ''}`} />)}
        </div>
        {message
          ? <p className="kiosk-message kiosk-message--error" role="alert">{messageText(message, lang)}</p>
          : <p className="kiosk-hint">{busy ? t(lang, 'checking') : t(lang, 'pin_hint')}</p>}
        <div className="kiosk-actions kiosk-actions--start">
          <button type="button" className="kiosk-btn" onClick={onBack} disabled={busy}>{t(lang, 'back')}</button>
          <button type="button" className="kiosk-btn kiosk-btn--quiet" onClick={() => onKey({ type: 'clear' })} disabled={busy || !pin}>{t(lang, 'clear')}</button>
        </div>
      </div>
      <div className="kiosk-keypad">
        {KEYS.map((d) => <button key={d} type="button" className="kiosk-key" disabled={busy} onClick={() => onKey({ type: 'digit', digit: d })}>{d}</button>)}
        <button type="button" className="kiosk-key kiosk-key--fn" disabled={busy || !pin} onClick={() => onKey({ type: 'back' })} aria-label={t(lang, 'delete_digit')} title={t(lang, 'delete_digit')}>⌫</button>
        <button type="button" className="kiosk-key" disabled={busy} onClick={() => onKey({ type: 'digit', digit: '0' })}>0</button>
        <button type="button" className="kiosk-key kiosk-key--ok" disabled={busy || !canSubmitPin(pin)} onClick={() => onKey({ type: 'submit' })}>
          {busy ? '…' : t(lang, 'ok')}
        </button>
      </div>
    </div>
  );
}
