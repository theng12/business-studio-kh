// Bootstrap slice — core app readiness, live subscriptions, and reconnect
// reconciliation. Subscriptions attach before the first awaited read so a
// startup event cannot fall into a blind spot.

import { applyTheme } from '../lib/theme.js';
import { applyCatalogEvent } from './catalogEvents.js';

let _aiUnsubs = [];
let _clientUnsub = null;
let _catalogUnsubs = [];
let _bootstrapReady = false;
let _reconcilePending = false;
let _reconcileTimer = null;
let _reconcilePromise = null;
let _bootstrapDoneAt = 0;
let _hellosThisBoot = 0;

/* Connectivity pass (0.1.94): the socket's greeting (`server:hello`) arrives
 * a moment after launch — usually while bootstrap is still loading, or just
 * after. Treating that greeting as a reconnect re-ran the whole company load
 * (companies, dashboard, products…) on top of the bootstrap that had just
 * fetched the same data: every boot paid for its catalog twice.
 *
 * Main publishes how many times the socket has opened (`wsOpenCount` in the
 * connection state). The greeting of the session's FIRST socket is skipped
 * when it is the first hello this boot and bootstrap is still running or
 * ended less than HELLO_RESYNC_GRACE_MS ago. Every other hello — a real
 * reconnect, after which events may have been missed — still reconciles. */
export const HELLO_RESYNC_GRACE_MS = 5_000;

export function shouldSkipHelloResync({ wsOpenCount, helloIndex, bootstrapReady, bootstrapDoneAt, now }) {
  if (wsOpenCount !== 1 || helloIndex !== 1) return false;
  if (!bootstrapReady) return true;
  return now - bootstrapDoneAt < HELLO_RESYNC_GRACE_MS;
}

function disposeAll() {
  for (const fn of [..._aiUnsubs, ..._catalogUnsubs, _clientUnsub]) {
    if (typeof fn === 'function') {
      try { fn(); } catch (_) { /* listener already gone */ }
    }
  }
  _aiUnsubs = [];
  _catalogUnsubs = [];
  _clientUnsub = null;
}

// Main pushes the connection state on EVERY successful RPC, almost always
// with only `lastOkAt` moved. Storing each one gave every subscriber a new
// object per call, so the whole shell re-rendered per request. A push that
// changes anything else is stored at once; a lastOkAt-only push is stored at
// most once per LAST_OK_REFRESH_MS — the only reader of the timestamp is the
// connection legend's "Last OK … ago", which this keeps within that window.
const LAST_OK_REFRESH_MS = 15_000;

export function isConnectionPushWorthStoring(prev, next) {
  if (!prev || !next) return true;
  if (prev.status !== next.status) return true;
  if ((prev.lastError ?? null) !== (next.lastError ?? null)) return true;
  if ((prev.serverVersion ?? null) !== (next.serverVersion ?? null)) return true;
  if ((prev.serverName ?? null) !== (next.serverName ?? null)) return true;
  if ((prev.reconnectCount ?? 0) !== (next.reconnectCount ?? 0)) return true;
  if ((prev.wsOpenCount ?? 0) !== (next.wsOpenCount ?? 0)) return true;
  if (JSON.stringify(prev.user ?? null) !== JSON.stringify(next.user ?? null)) return true;
  if (prev.lastOkAt === next.lastOkAt) return false;
  return Math.abs((next.lastOkAt || 0) - (prev.lastOkAt || 0)) >= LAST_OK_REFRESH_MS;
}

function logSoft(what, err) {
  console.warn(`[soft-failure] ${what}:`, err?.message || err);
}

async function refreshIdentity(set) {
  try {
    const users = await window.api?.users?.listForAttribution?.();
    if (Array.isArray(users)) {
      const attributionUsers = {};
      for (const user of users) if (user?.id && user?.name) attributionUsers[user.id] = user.name;
      set({ attributionUsers });
    }
  } catch (_) { /* attribution is optional */ }
  try {
    const presence = await window.api?.users?.presence?.();
    if (Array.isArray(presence)) set({ presence });
  } catch (_) { /* presence is optional */ }
}

async function reconcile(set, get) {
  await get().reconcileActiveCompany();
  await Promise.allSettled([get().refreshAiModels(), refreshIdentity(set)]);
}

function requestReconciliation(set, get) {
  _reconcilePending = true;
  if (!_bootstrapReady || _reconcileTimer || _reconcilePromise) return;
  _reconcileTimer = setTimeout(() => {
    _reconcileTimer = null;
    if (!_bootstrapReady || !_reconcilePending) return;
    _reconcilePending = false;
    _reconcilePromise = reconcile(set, get)
      .catch((err) => logSoft('server reconnect reconciliation', err))
      .finally(() => {
        _reconcilePromise = null;
        if (_reconcilePending) requestReconciliation(set, get);
      });
  }, 0);
}

function installSubscriptions(set, get) {
  disposeAll();

  if (window.api?.ai?.onTaskUpdate) {
    const off = window.api.ai.onTaskUpdate((task) => get().applyTaskUpdate(task));
    if (typeof off === 'function') _aiUnsubs.push(off);
  }
  if (window.api?.ai?.onGalleryAdded) {
    const off = window.api.ai.onGalleryAdded((entry) => get().applyGalleryAdded(entry));
    if (typeof off === 'function') _aiUnsubs.push(off);
  }
  if (window.api?.client?.onConnectionState) {
    _clientUnsub = window.api.client.onConnectionState((clientConnection) => {
      if (isConnectionPushWorthStoring(get().clientConnection, clientConnection)) set({ clientConnection });
    });
  }

  if (window.api?.events?.onCatalogChanged) {
    const off = window.api.events.onCatalogChanged((event) => {
      if (event?.kind) applyCatalogEvent(get, event);
    });
    if (typeof off === 'function') _catalogUnsubs.push(off);
  }
  if (window.api?.events?.onServerHello) {
    const off = window.api.events.onServerHello(() => {
      _hellosThisBoot += 1;
      if (shouldSkipHelloResync({
        wsOpenCount: get().clientConnection?.wsOpenCount,
        helloIndex: _hellosThisBoot,
        bootstrapReady: _bootstrapReady,
        bootstrapDoneAt: _bootstrapDoneAt,
        now: Date.now(),
      })) return;
      requestReconciliation(set, get);
    });
    if (typeof off === 'function') _catalogUnsubs.push(off);
  }
  if (window.api?.events?.onPresenceChanged) {
    const off = window.api.events.onPresenceChanged((presence) => {
      if (Array.isArray(presence)) set({ presence });
    });
    if (typeof off === 'function') _catalogUnsubs.push(off);
  }
  if (window.api?.events?.onProgress) {
    const off = window.api.events.onProgress((event) => {
      if (!event?.id) return;
      if (event.complete) {
        set((state) => {
          const progressOps = { ...state.progressOps };
          delete progressOps[event.id];
          return { progressOps };
        });
        if (event.error) get().addToast(event.error, 'error');
        return;
      }
      set((state) => ({ progressOps: { ...state.progressOps, [event.id]: event } }));
    });
    if (typeof off === 'function') _catalogUnsubs.push(off);
  }
}

function loaders(get) {
  return {
    brands: () => get().refreshBrands(),
    categories: () => get().refreshCategories(),
    products: () => get().refreshProducts(),
    dashboard: () => get().refreshDashboard(),
    exports: () => get().refreshExportProfiles(),
    aiModels: () => get().refreshAiModels(),
    aiPrompts: () => get().refreshAiPrompts(),
    aiTasks: () => get().refreshAiTasks(),
  };
}

function activeLoaderKeys(activeModule) {
  if (activeModule === 'dashboard') return ['dashboard'];
  if (activeModule === 'brands') return ['brands'];
  if (activeModule === 'aistudio') return ['brands', 'categories', 'products', 'aiModels', 'aiPrompts', 'aiTasks'];
  if (activeModule === 'export') return ['categories', 'products', 'exports'];
  if (activeModule === 'settings') return ['exports'];
  if (['library', 'workspace', 'overlay', 'labeltemplates', 'labelgenerate', 'barcodes',
    'labeljobs', 'catalogtemplates', 'catalogprojects', 'catalogstudio', 'socialgrid',
    'purchaseorders', 'history'].includes(activeModule)) {
    return ['brands', 'categories', 'products'];
  }
  return [];
}

export function createBootstrapSlice(set, get) {
  return {
    async bootstrap() {
      if (!window.api) return;
      _bootstrapReady = false;
      _bootstrapDoneAt = 0;
      _hellosThisBoot = 0;
      _reconcilePending = false;
      if (_reconcileTimer) clearTimeout(_reconcileTimer);
      _reconcileTimer = null;
      installSubscriptions(set, get);

      const [versionR, platformR, activeIdR, settingsR] = await Promise.allSettled([
        window.api.app.getVersion(),
        window.api.app.getPlatform(),
        window.api.companies.getActiveId(),
        window.api.settings.getAll(),
      ]);
      const version = versionR.status === 'fulfilled' ? versionR.value : null;
      const platform = platformR.status === 'fulfilled' ? platformR.value : null;
      const activeId = activeIdR.status === 'fulfilled' ? activeIdR.value : null;
      const settings = settingsR.status === 'fulfilled' ? settingsR.value : null;
      const theme = settings?.theme ?? 'light';
      applyTheme(theme);
      set({
        appVersion: version,
        platform,
        theme,
        appConfig: {},
        dataDirIsCloud: !!settings?.dataDirIsCloud,
        appMode: settings?.mode ?? 'standalone',
        clientServerUrl: settings?.clientServerUrl ?? '',
        ...(settings?.aiDefaultModel ? { aiSelectedModelKey: settings.aiDefaultModel } : {}),
      });
      get().applyActiveCompanyContext(activeId);

      if (settings?.mode === 'client' && window.api?.client?.connectionState) {
        try {
          const clientConnection = await window.api.client.connectionState();
          if (clientConnection) set({ clientConnection });
        } catch (_) { /* keep the pushed/unknown state */ }
      }

      await get().refreshCompanies();
      const allLoaders = loaders(get);
      const activeKeys = new Set(activeId ? activeLoaderKeys(get().activeModule) : []);
      await Promise.allSettled([...activeKeys].map((key) => allLoaders[key]()));

      _bootstrapReady = true;
      _bootstrapDoneAt = Date.now();
      if (_reconcilePending) {
        requestReconciliation(set, get);
      } else {
        const background = Object.entries(allLoaders)
          .filter(([key]) => !activeKeys.has(key))
          .map(([, load]) => load());
        void Promise.allSettled([...background, refreshIdentity(set)]);
      }
    },
  };
}
