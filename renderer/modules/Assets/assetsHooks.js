/**
 * Fixed Assets — React hooks shared by the asset screens.
 *
 *   useAssetCaps()        what this account may do: view / manage / admin /
 *                         branches (system.manage) / rates / fuel / suppliers.
 *                         The host Mac (standalone, server) may do everything.
 *   useAssetsTick(kinds)  a number that goes up when `assets:changed` reports
 *                         one of `kinds` for the active company (debounced) —
 *                         put it in a load effect's deps and the screen
 *                         refreshes live (another Mac, the background run).
 *   useAssetLookups()     categories, branches, staff tiles, settings, the
 *                         chart of accounts and today's house rate, for the
 *                         active company; emptied at once on a company switch.
 *   useAssetFileUrl(id)   a blob: URL for a photo or document, read through the
 *                         permission-checked `assets:getFile` (never app-image://).
 *   openAssetPage(id)     open an asset's page from any Assets screen.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { hasCap } from '../../lib/capabilities.js';
import { createPhotoCache, toUint8 } from '../Fuel/fuelModel.js';
import { indexById, todayKey } from './assetsModel.js';

export function useAssetCaps() {
  const caps = useUserCaps();
  return useMemo(() => {
    const canManage = hasCap(caps, 'assets.manage');
    return {
      caps,
      canView: canManage || hasCap(caps, 'assets.view'),
      canManage,
      isAdmin: Array.isArray(caps) && caps.includes('*'),
      canBranches: hasCap(caps, 'system.manage'),
      canRates: canManage || hasCap(caps, 'system.manage'),
      canFuel: hasCap(caps, 'fuel.manage'),
      canSeeFuel: hasCap(caps, 'fuel.manage') || hasCap(caps, 'fuel.record'),
      canSuppliers: hasCap(caps, 'costing.view'),
    };
  }, [caps]);
}

/** Bumps when the active company's asset data of one of `kinds` changes (debounced 250 ms). */
export function useAssetsTick(kinds) {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const [tick, setTick] = useState(0);
  const key = Array.isArray(kinds) ? kinds.join(',') : '';
  useEffect(() => {
    const on = window.api?.assets?.onChanged;
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

const LOOKUP_KINDS = ['category', 'settings', 'branch', 'fx', 'account'];
const EMPTY = Object.freeze({ categories: [], branches: [], staff: [], suppliers: [], accounts: [], settings: null, houseRate: null, loaded: false, error: null });

/**
 * Names for ids, the settings and the display rate. Staff come back as tiles
 * (code, name) unless this account manages fuel — enough for a custodian.
 * Suppliers only for an account that may see them (costing.view).
 */
export function useAssetLookups() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const { canSuppliers } = useAssetCaps();
  const tick = useAssetsTick(LOOKUP_KINDS);
  const [state, setState] = useState(EMPTY);
  const [manual, setManual] = useState(0);
  const req = useRef(0);
  const companyRef = useRef(activeCompanyId);
  useEffect(() => {
    // Another company's names must never show while this one loads.
    if (companyRef.current !== activeCompanyId) { companyRef.current = activeCompanyId; setState(EMPTY); }
    const r = ++req.current;
    if (!activeCompanyId || !window.api?.assets) return;
    const a = window.api;
    const soft = (p, dflt) => Promise.resolve().then(() => p()).catch(() => dflt);
    Promise.all([
      a.assets.listCategories({ includeArchived: true }),
      a.branches.list({ status: 'all' }),
      soft(() => a.staff.list({}), []),
      a.assets.getSettings(),
      soft(() => a.ledger.listAccounts({ includeArchived: true }), []),
      soft(() => a.fx.rateOn(todayKey(), 'house'), null),
      canSuppliers ? soft(() => a.suppliers.list(activeCompanyId, {}), []) : Promise.resolve([]),
    ]).then(([categories, branches, staff, settings, accounts, rate, suppliers]) => {
      if (r !== req.current) return;
      const houseRate = rate?.rate?.khrPerUsd || rate?.settingsKhrPerUsd || null;
      setState({
        categories: categories || [], branches: branches || [], staff: Array.isArray(staff) ? staff : [], settings,
        accounts: accounts || [], houseRate, suppliers: Array.isArray(suppliers) ? suppliers : (suppliers?.items || []), loaded: true, error: null,
      });
    }).catch((err) => {
      if (r !== req.current) return;
      setState((s) => ({ ...s, loaded: true, error: err.message }));
    });
  }, [activeCompanyId, tick, manual, canSuppliers]);
  return useMemo(() => ({
    ...state,
    maps: {
      categories: indexById(state.categories),
      branches: indexById(state.branches),
      staff: indexById(state.staff),
      suppliers: indexById(state.suppliers),
    },
    reload: () => setManual((n) => n + 1),
  }), [state]);
}

/* ─── files ───────────────────────────────────────────────────────────── */

// One blob URL per file and size, shared by every thumbnail on screen. A
// file's bytes never change (a new upload is a new id). Byte-capped LRU, the
// same as the fuel photos.
const cache = createPhotoCache({ release: (v) => { if (v.url) URL.revokeObjectURL(v.url); } });

/**
 * A blob URL for an asset file (photo thumbnail by default; `thumb: false`
 * for the original or a PDF). `{ url, mime, intact, loading, error }`.
 */
export function useAssetFileUrl(fileId, { thumb = true } = {}) {
  const key = fileId ? `asset:${fileId}:${thumb ? 't' : 'f'}` : null;
  const [state, setState] = useState({ url: null, mime: null, intact: true, error: null, loading: !!key });
  useEffect(() => {
    if (!key) { setState({ url: null, mime: null, intact: true, error: null, loading: false }); return undefined; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    cache.load(key, () => window.api.assets.getFile(fileId, thumb).then((res) => {
      const bytes = toUint8(res?.bytes);
      if (!bytes) return null;
      const url = URL.createObjectURL(new Blob([bytes], { type: res.mime || 'application/octet-stream' }));
      return { url, mime: res.mime || null, intact: res.intact !== false, size: bytes.byteLength };
    })).then((v) => {
      if (alive) setState({ url: v?.url || null, mime: v?.mime || null, intact: v ? v.intact : true, error: null, loading: false });
    }).catch((err) => {
      if (alive) setState({ url: null, mime: null, intact: true, error: err.message, loading: false });
    });
    return () => { alive = false; };
    // The key fully identifies the file and size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/* ─── opening an asset from another Assets page ───────────────────────── */

let pending = null;
const listeners = new Set();

/**
 * Open an asset's page: remember which (and for which company), then go to
 * the Register, which shows it. A company switch in between drops it.
 */
export function openAssetPage(assetId, companyId) {
  pending = assetId ? { assetId, companyId } : null;
  for (const fn of listeners) fn();
  return useAppStore.getState().setActiveModule('assetregister');
}

/** The asset another page asked the Register to open — taken once. */
export function useAssetIntent() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const [taken, setTaken] = useState(null);
  useEffect(() => {
    const take = () => {
      if (!pending) return;
      const p = pending;
      pending = null;
      if (p.companyId === activeCompanyId) setTaken({ ...p, at: Date.now() });
    };
    take();
    listeners.add(take);
    return () => listeners.delete(take);
  }, [activeCompanyId]);
  return taken;
}
