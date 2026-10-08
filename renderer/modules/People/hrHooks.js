/**
 * HR1 — React hooks shared by the People screens.
 *
 *   useHrCaps()            what this account may do (hr.view / hr.manage, and
 *                          fuel.manage for the F1 staff list)
 *   useHrTick(kinds)       a number that goes up when `hr:changed` reports one
 *                          of `kinds` for the active company (debounced) — put
 *                          it in a load effect's deps and the list refreshes
 *                          live (kiosk and phone clock-ins appear by themselves)
 *   useHrLookups()         staff, positions, schedules and leave types of the
 *                          active company, kept fresh the same way
 *   useAttendancePhotoUrl  a blob: URL for a clock-in photo, read through the
 *                          permission-checked `attendance:getPhoto` (hr.manage),
 *                          never app-image://
 *   useDocumentUrl         the same for a staff document (`hr:readDocument`)
 *
 * Every loader guards against a company switch: an answer that arrives for
 * the company the user just left is dropped (`alive` / request counters).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { registerCompanySwitchFlusher } from '../../lib/companySwitch.js';
import { createPhotoCache, indexById, toUint8 } from '../Fuel/fuelModel.js';
import { hrCapsOf } from './hrModel.js';
import { LOOKUP_KINDS, createLookupCache } from './lookupCache.js';

export function useHrCaps() {
  const caps = useUserCaps();
  return useMemo(() => hrCapsOf(caps), [caps]);
}

/** Bumps when the active company's HR data of one of `kinds` changes (debounced 250 ms). Empty = any kind. */
export function useHrTick(kinds) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const [tick, setTick] = useState(0);
  const key = Array.isArray(kinds) ? kinds.join(',') : '';
  useEffect(() => {
    const on = window.api?.hr?.onChanged;
    if (typeof on !== 'function') return undefined;
    const wanted = new Set(key ? key.split(',') : []);
    let timer = null;
    const off = on((evt) => {
      if (evt?.companyId && activeCompanyId && evt.companyId !== activeCompanyId) return;
      if (wanted.size && !wanted.has(evt?.kind)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), 250);
    });
    return () => { clearTimeout(timer); if (typeof off === 'function') off(); };
  }, [key, activeCompanyId]);
  return tick;
}

/** Fuel's staff list changes (fuel:changed 'staff') also change ours. */
export function useStaffTick() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const hrTick = useHrTick(['staff']);
  const [fuelTick, setFuelTick] = useState(0);
  useEffect(() => {
    const on = window.api?.fuel?.onChanged;
    if (typeof on !== 'function') return undefined;
    let timer = null;
    const off = on((evt) => {
      if (evt?.companyId && activeCompanyId && evt.companyId !== activeCompanyId) return;
      if (evt?.kind !== 'staff') return;
      clearTimeout(timer);
      timer = setTimeout(() => setFuelTick((t) => t + 1), 250);
    });
    return () => { clearTimeout(timer); if (typeof off === 'function') off(); };
  }, [activeCompanyId]);
  return hrTick + fuelTick;
}

const EMPTY = Object.freeze({ staff: [], positions: [], schedules: [], leaveTypes: [], settings: null, loaded: false, error: null });

// One cache for every People page (verification 2026-10-08: each page switch
// fetched all five lists again). Keyed on company + what the account may see.
const lookups = createLookupCache(async (key) => {
  const [staff, positions, schedules, leaveTypes, settings] = await Promise.all([
    window.api.staff.list({}),
    window.api.hr.listPositions({ includeArchived: true }),
    window.api.hr.listSchedules({ includeArchived: true }),
    window.api.leave.listTypes({ includeArchived: true }),
    window.api.hr.getSettings(),
  ]);
  void key;
  return { staff: staff || [], positions: positions || [], schedules: schedules || [], leaveTypes: leaveTypes || [], settings, loaded: true, error: null };
});
let lookupsWired = false;
/** Drop the cache on a lookup change, whether or not a People page is open (wired once). */
function wireLookupInvalidation() {
  if (lookupsWired || typeof window === 'undefined' || !window.api) return;
  lookupsWired = true;
  window.api.hr?.onChanged?.((evt) => { if (LOOKUP_KINDS.has(evt?.kind)) lookups.invalidate(evt?.companyId || null); });
  window.api.fuel?.onChanged?.((evt) => { if (evt?.kind === 'staff') lookups.invalidate(evt?.companyId || null); });
}

/**
 * Names for ids: every staff member (incl. left), positions, schedules,
 * leave types and the HR settings of the active company. hr.view or better.
 * Served from the shared cache; a change event or a company switch reloads.
 */
export function useHrLookups() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const { canView, canManage } = useHrCaps();
  const key = activeCompanyId && canView ? `${activeCompanyId}|${canManage ? 'm' : 'v'}` : null;
  const [state, setState] = useState(() => (key && lookups.peek(key)) || EMPTY);
  const [version, setVersion] = useState(0);
  const keyRef = useRef(key);
  useEffect(() => {
    wireLookupInvalidation();
    let timer = null;
    // Debounced: a burst of changes is one reload.
    const off = lookups.subscribe(() => { clearTimeout(timer); timer = setTimeout(() => setVersion((v) => v + 1), 250); });
    return () => { clearTimeout(timer); off(); };
  }, []);
  useEffect(() => {
    // Another company's names must never show while this one loads.
    if (keyRef.current !== key) { keyRef.current = key; setState((key && lookups.peek(key)) || EMPTY); }
    if (!key || !window.api?.hr) return undefined;
    let alive = true;
    lookups.get(key).then((value) => { if (alive && keyRef.current === key) setState(value); }).catch((err) => {
      if (alive && keyRef.current === key) setState((s) => ({ ...s, loaded: true, error: err?.message || String(err) }));
    });
    return () => { alive = false; };
  }, [key, version]);
  return useMemo(() => ({
    ...state,
    maps: {
      staff: indexById(state.staff),
      positions: indexById(state.positions),
      schedules: indexById(state.schedules),
      leaveTypes: indexById(state.leaveTypes),
    },
    reload: () => { lookups.invalidate(); setVersion((v) => v + 1); },
  }), [state]);
}

/* ─── photos and documents ────────────────────────────────────────────── */

// One blob URL per photo (and size), shared by every thumbnail on screen; a
// clock-in photo's bytes never change (a new photo is a new event). LRU capped
// by bytes like the fuel cache (L9). Lists ask for thumbnails.
const cache = createPhotoCache({ release: (v) => { if (v.url) URL.revokeObjectURL(v.url); } });

function toBlobResult(res) {
  const bytes = toUint8(res?.bytes);
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes], { type: res.mime || 'image/jpeg' }));
  return { url, intact: res.intact !== false, size: bytes.byteLength, mime: res.mime || 'image/jpeg' };
}

function useBlob(key, fetcher) {
  const [state, setState] = useState({ url: null, intact: true, error: null, loading: !!key, mime: null });
  useEffect(() => {
    if (!key) { setState({ url: null, intact: true, error: null, loading: false, mime: null }); return undefined; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    cache.load(key, () => fetcher().then(toBlobResult)).then((v) => {
      if (alive) setState({ url: v?.url || null, intact: v ? v.intact : true, error: null, loading: false, mime: v?.mime || null });
    }).catch((err) => {
      if (alive) setState({ url: null, intact: true, error: err?.message || String(err), loading: false, mime: null });
    });
    return () => { alive = false; };
    // The key fully identifies the bytes; `fetcher` is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/**
 * Load a page of clock-in thumbnails in ONE call (`attendance:getPhotos`,
 * verification 2026-10-08) and put each into the shared cache under the key
 * the thumbnails ask for — call it before the list renders and no thumbnail
 * makes its own request. Photos already cached are skipped; if the batch call
 * fails, each photo falls back to its own `attendance:getPhoto`. hr.manage only.
 */
export function primeAttendanceThumbs(events) {
  const ids = (events || []).filter((e) => e?.id && e.hasPhoto && !cache.has(`att:${e.id}:t`)).map((e) => e.id);
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const batch = window.api.attendance.getPhotos(chunk, 'thumb')
      .then((list) => new Map((list || []).filter(Boolean).map((r) => [r.eventId, r])));
    for (const id of chunk) {
      cache.load(`att:${id}:t`, () => batch
        .then((byId) => { const r = byId.get(id); return r && r.bytes ? r : null; })
        .catch(() => window.api.attendance.getPhoto(id, true))
        .then(toBlobResult));
    }
  }
}

/** A clock-in photo (hr.manage only — pass `enabled: false` otherwise and nothing is asked). */
export function useAttendancePhotoUrl(event, { thumb = true, enabled = true } = {}) {
  const key = enabled && event?.id && event.hasPhoto ? `att:${event.id}:${thumb ? 't' : 'f'}` : null;
  return useBlob(key, () => window.api.attendance.getPhoto(event.id, thumb));
}

/** A staff document (hr.manage only). */
export function useDocumentUrl(doc, { thumb = false, enabled = true } = {}) {
  const key = enabled && doc?.id ? `doc:${doc.id}:${doc.sha256 || ''}:${thumb ? 't' : 'f'}` : null;
  return useBlob(key, () => window.api.hr.readDocument(doc.id, thumb));
}

/**
 * §6 auto-save: `queue(fields)` collects changes and writes them 500 ms after
 * the last one; `flush()` writes them now (the Save button, ⌘S, leaving the
 * screen, a company switch — while they still belong to the company they were
 * typed for). `write(patch)` may throw; the patch is kept for the retry and the
 * real message goes to a toast. Saves never overlap.
 */
export function useAutosave(write, { delay = 500, label = 'changes' } = {}) {
  const addToast = useAppStore((s) => s.addToast);
  const pending = useRef({});
  const timer = useRef(null);
  const inflight = useRef(null);
  const writeRef = useRef(write);
  writeRef.current = write;
  const [status, setStatus] = useState({ state: 'idle', savedAt: null, error: null });

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inflight.current) await inflight.current;
    const patch = pending.current;
    if (!Object.keys(patch).length) return true;
    pending.current = {};
    setStatus((s) => ({ ...s, state: 'saving' }));
    const run = (async () => {
      try {
        await writeRef.current(patch);
        setStatus({ state: Object.keys(pending.current).length ? 'dirty' : 'saved', savedAt: Date.now(), error: null });
        return true;
      } catch (err) {
        pending.current = { ...patch, ...pending.current };
        const msg = err?.message || String(err);
        setStatus((s) => ({ ...s, state: 'error', error: msg }));
        addToast(`Couldn't save ${label}: ${msg.replace(/^Bad request:\s*/, '')}`, 'error');
        return false;
      }
    })();
    inflight.current = run;
    const ok = await run;
    inflight.current = null;
    return ok;
  }, [addToast, label]);

  const queue = useCallback((fields) => {
    pending.current = { ...pending.current, ...fields };
    setStatus((s) => ({ ...s, state: 'dirty' }));
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
  }, [flush, delay]);

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = {};
    setStatus({ state: 'idle', savedAt: null, error: null });
  }, []);

  useEffect(() => registerCompanySwitchFlusher(flush), [flush]);
  // Leaving the screen with a change still waiting: write it now.
  useEffect(() => () => { clearTimeout(timer.current); if (Object.keys(pending.current).length) flush(); }, [flush]);

  return useMemo(() => ({ status, queue, flush, reset, hasPending: () => Object.keys(pending.current).length > 0 }), [status, queue, flush, reset]);
}

/**
 * Server-paged list state: `{ page, pageSize, offset }` that resets to page 1
 * when any of `resetKeys` changes (§10).
 */
export function usePager(resetKeys = []) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const key = JSON.stringify(resetKeys);
  useEffect(() => { setPage(0); }, [key, pageSize]);
  return { page, setPage, pageSize, setPageSize, offset: page * pageSize };
}
