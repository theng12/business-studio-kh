/**
 * Fuel F1 — React hooks shared by the fuel screens and the Staff page.
 *
 *   useFuelCaps()          what this user may do (fuel.record / fuel.manage)
 *   useFuelTick(kinds)     a number that goes up when `fuel:changed` reports one
 *                          of `kinds` for the active company — put it in a
 *                          load effect's deps and the list refreshes live
 *                          (phone uploads appear without a reload)
 *   useFuelLookups()       vehicles, tanks, stations, staff and types for the
 *                          active company, kept fresh the same way
 *   useFuelPhotoUrl(id)    a blob: URL for a fuel photo, read through the
 *                          permission-checked `fuel:getPhoto` (never app-image://)
 *   useStaffPhotoUrl(e)    the same for a staff photo (`staff:getPhoto`)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { hasCap } from '../../lib/capabilities.js';
import { indexById, toUint8 } from './fuelModel.js';

const ALL_CAPS = ['*'];

export function useFuelCaps() {
  const appMode = useAppStore((s) => s.appMode);
  const clientCaps = useAppStore((s) => s.clientConnection?.user?.caps);
  const caps = appMode === 'client' ? (clientCaps || ALL_CAPS) : ALL_CAPS;
  const canManage = hasCap(caps, 'fuel.manage');
  return { canManage, canRecord: canManage || hasCap(caps, 'fuel.record') };
}

/** Bumps when the active company's fuel data of one of `kinds` changes (debounced 250 ms). */
export function useFuelTick(kinds) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const [tick, setTick] = useState(0);
  const key = Array.isArray(kinds) ? kinds.join(',') : '';
  useEffect(() => {
    const on = window.api?.fuel?.onChanged;
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

const LOOKUP_KINDS = ['asset', 'assetType', 'location', 'station', 'staff'];

/**
 * Everything a fuel screen needs to turn ids into names. Staff come back as
 * tiles for a fuel.record-only user; that is enough for names.
 */
export function useFuelLookups({ includeRetired = false } = {}) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const tick = useFuelTick(LOOKUP_KINDS);
  const [state, setState] = useState({ assets: [], types: [], locations: [], stations: [], staff: [], settings: null, loaded: false });
  const req = useRef(0);
  const [manual, setManual] = useState(0);
  useEffect(() => {
    if (!activeCompanyId || !window.api?.fuel) return;
    const r = ++req.current;
    const f = window.api.fuel;
    Promise.all([
      f.listAssets({ status: includeRetired ? 'all' : 'active' }),
      f.listAssetTypes({ includeArchived: true }),
      f.listLocations({ status: includeRetired ? 'all' : 'active' }),
      f.listStations({ includeArchived: true }),
      window.api.staff.list({}),
      f.getSettings(),
    ]).then(([assets, types, locations, stations, staff, settings]) => {
      if (r !== req.current) return;
      setState({ assets: assets || [], types: types || [], locations: locations || [], stations: stations || [], staff: staff || [], settings, loaded: true });
    }).catch((err) => {
      if (r !== req.current) return;
      setState((s) => ({ ...s, loaded: true, error: err.message }));
    });
  }, [activeCompanyId, includeRetired, tick, manual]);
  return useMemo(() => ({
    ...state,
    maps: {
      assets: indexById(state.assets),
      types: indexById(state.types),
      locations: indexById(state.locations),
      stations: indexById(state.stations),
      staff: indexById(state.staff),
    },
    reload: () => setManual((n) => n + 1),
  }), [state]);
}

/* ─── photos ──────────────────────────────────────────────────────────── */

// One blob URL per photo (and size), shared by every thumbnail on screen. A
// photo's bytes never change (a new photo is a new id), so the cache needs no
// invalidation; it is capped so a long session does not hold every image.
const CACHE_MAX = 400;
const cache = new Map(); // key → Promise<{ url, intact } | null>

function remember(key, promise) {
  cache.set(key, promise);
  while (cache.size > CACHE_MAX) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey);
    old.then((v) => { if (v?.url) URL.revokeObjectURL(v.url); }).catch(() => {});
  }
  return promise;
}

function toBlobResult(res) {
  const bytes = toUint8(res?.bytes);
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes], { type: res.mime || 'image/jpeg' }));
  return { url, intact: res.intact !== false };
}

function loadPhoto(key, fetcher) {
  if (cache.has(key)) return cache.get(key);
  const p = fetcher().then(toBlobResult);
  p.catch(() => cache.delete(key));
  return remember(key, p);
}

function usePhoto(key, fetcher) {
  const [state, setState] = useState({ url: null, intact: true, error: null, loading: !!key });
  useEffect(() => {
    if (!key) { setState({ url: null, intact: true, error: null, loading: false }); return undefined; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loadPhoto(key, fetcher).then((v) => {
      if (alive) setState({ url: v?.url || null, intact: v ? v.intact : true, error: null, loading: false });
    }).catch((err) => {
      if (alive) setState({ url: null, intact: true, error: err.message, loading: false });
    });
    return () => { alive = false; };
    // `fetcher` is rebuilt each render; the key fully identifies the photo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export function useFuelPhotoUrl(photoId, { thumb = true } = {}) {
  return usePhoto(photoId ? `fuel:${photoId}:${thumb ? 't' : 'f'}` : null, () => window.api.fuel.getPhoto(photoId, thumb));
}

export function useStaffPhotoUrl(employee, { thumb = true } = {}) {
  const key = employee?.id && employee.hasPhoto ? `staff:${employee.id}:${employee.photoSha256 || ''}:${thumb ? 't' : 'f'}` : null;
  return usePhoto(key, () => window.api.staff.getPhoto(employee.id, thumb));
}

/** A unique client reference so a double-click or a retry never saves twice. */
export function newClientRef() {
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `mac:${id}`;
}

/**
 * The navigation intent another screen left for `module` (see `openFuel` in
 * renderer/store/navigation.js), or null. Read once, then cleared, so coming
 * back later does not repeat it.
 */
export function useFuelIntent(module) {
  const intent = useAppStore((s) => s.fuelIntent);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const clear = useAppStore((s) => s.clearFuelIntent);
  const [taken, setTaken] = useState(null);
  useEffect(() => {
    if (!intent || intent.module !== module) return;
    if (intent.companyId === activeCompanyId) setTaken(intent);
    clear();
  }, [intent, module, activeCompanyId, clear]);
  return taken;
}
