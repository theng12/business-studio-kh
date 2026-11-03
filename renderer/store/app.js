// App-level slice — process metadata (version, platform), theme, mode,
// the mirrored config subset, and the multi-user awareness state
// (attributionUsers, presence, clientConnection, progressOps).

import { applyTheme } from '../lib/theme.js';
import { validRate } from '../lib/exchangeRate.js';

let _houseRateSeq = 0;

export function createAppSlice(set, _get) {
  return {
    // — App context
    appVersion: '',
    platform: '',
    theme: 'light',
    // v0.13.0: mirror the main-process `dataDirIsCloud` flag so the
    // sidebar's footer can show an ☁ iCloud badge. Set in `refreshAppConfig`.
    dataDirIsCloud: false,
    // v0.14.0: app mode (standalone/server/client). Mirrored from config
    // so the sidebar chip + any mode-conditional UI can react.
    appMode: 'standalone',
    /** v0.1.31: the configured server address, '' when client mode has none yet. */
    clientServerUrl: '',
    // v0.14.3: client-mode connection state. Pushed by main via the
    // `client:connectionState` IPC event whenever the ping loop or an
    // RPC call updates it. Only meaningful when appMode === 'client'.
    clientConnection: {
      status: 'unknown',         // 'unknown' | 'connecting' | 'connected' | 'disconnected'
      lastOkAt: 0,
      lastError: null,
      serverVersion: null,
    },
    // v0.15.3: attribution lookup. Keyed by users.id → display name.
    // Loaded once at boot (server + client modes only), refreshed when
    // a user is added / renamed via the same IPC. Standalone mode has
    // no users so this stays empty and the Attribution chip falls back
    // to "Edited 2 min ago" without a name.
    attributionUsers: {},
    // v0.15.3: presence (currently-connected WebSocket users). Updated
    // by the `users:presence` push event from main. Empty array in
    // standalone mode. The Settings page renders this.
    presence: [],
    // v0.17.1: in-flight progress for long-running bulk operations.
    // Keyed by operation id; payload `{ id, kind, done, total, phase,
    // label }`. The renderer shows a small persistent overlay; when
    // an event with `complete: true` arrives, the entry is removed.
    progressOps: {},
    // Subset of the user's config.json that the renderer needs to read on hot
    // paths (Workspace processing, etc.). Kept in the store so components can
    // react to changes without each one hitting the settings IPC. Updated by
    // bootstrap and by `refreshAppConfig()` after Settings writes.
    // v0.49.33: dropped `bgRemovalEngine` + `removeBgApiKey` — the paid
    // remove.bg engine was removed in this release. The local @imgly
    // engine is the only path now, and it doesn't need a knob in store
    // state (the renderer just calls `removeBackground(filepath)`).
    // The appConfig object stays so other config mirrors can be added
    // here later without re-introducing the field.
    appConfig: {},
    // 0.1.95: the house exchange rate, riel per US dollar. Since Finance it is
    // the ACTIVE COMPANY's shared rate (fx:getShared), not this Mac's config.
    // null while loading or after a failed load — never a made-up default.
    houseKhrPerUsd: null,
    houseRateLoading: false,
    houseRateError: '',

    /** Re-read the active company's shared rate. Call on boot, company switch,
     *  reconnect and an `assets:changed` kind `fx` event. A failed load clears
     *  the rate rather than leaving the previous company's value on screen. */
    async refreshHouseRate() {
      const seq = ++_houseRateSeq;
      if (!window.api?.fx?.getShared) return;
      const companyId = _get().activeCompanyId ?? null;
      set({ houseKhrPerUsd: null, houseRateLoading: true, houseRateError: '' });
      try {
        const r = await window.api.fx.getShared();
        // A newer call (or a company switch) has overtaken this one.
        if (seq !== _houseRateSeq) return;
        if ((_get().activeCompanyId ?? null) !== companyId) return;
        const n = r && Number.isFinite(r.khrPerUsd) ? r.khrPerUsd : null;
        set(n == null
          ? { houseKhrPerUsd: null, houseRateLoading: false, houseRateError: 'No exchange rate for this company yet.' }
          : { houseKhrPerUsd: n, houseRateLoading: false, houseRateError: '' });
      } catch (e) {
        if (seq !== _houseRateSeq) return;
        if ((_get().activeCompanyId ?? null) !== companyId) return;
        set({ houseKhrPerUsd: null, houseRateLoading: false, houseRateError: e?.message || 'Could not load the exchange rate.' });
      }
    },

    /** Validate, save the active company's shared rate, then mirror it.
     *  Throws on a bad value or a refused write so the caller can toast it. */
    async setHouseExchangeRate(value) {
      const rate = validRate(value);
      if (rate == null) throw new Error('Exchange rate must be a number above 0 (riel per US dollar, e.g. 4100)');
      if (rate < 100 || rate > 100000) throw new Error('Riel per dollar must be between 100 and 100000');
      const seq = ++_houseRateSeq;
      const companyId = _get().activeCompanyId ?? null;
      let r;
      try { r = await window.api.fx.setShared(rate); }
      catch (error) {
        if (seq === _houseRateSeq && (_get().activeCompanyId ?? null) === companyId) {
          set({ houseRateLoading: false, houseRateError: error.message });
        }
        throw error;
      }
      // The company changed while the write was in flight: its answer belongs
      // to another company, so refetch instead of mirroring it.
      if (seq !== _houseRateSeq || (_get().activeCompanyId ?? null) !== companyId) {
        void _get().refreshHouseRate();
        return rate;
      }
      const n = r && Number.isFinite(r.khrPerUsd) ? r.khrPerUsd : rate;
      set({ houseKhrPerUsd: n, houseRateLoading: false, houseRateError: '' });
      return n;
    },

    /* ─── Theme ─── */

    async setTheme(theme) {
      const next = ['light', 'dark', 'system'].includes(theme) ? theme : 'light';
      applyTheme(next);
      set({ theme: next });
      try { await window.api.settings.setOne('theme', next); }
      catch (err) { /* persistence is best-effort */ }
    },

    /**
     * Re-read the small subset of config.json we mirror in store state. Call
     * this from any module that writes to settings (e.g. when the user picks
     * a different bg-removal engine in the Workspace panel or Settings page)
     * so other consumers see the new value without a full app restart.
     */
    async refreshAppConfig() {
      if (!window.api) return;
      const cfg = await window.api.settings.getAll();
      set({
        appConfig: {},
        dataDirIsCloud: !!cfg?.dataDirIsCloud,
        appMode: cfg?.mode ?? 'standalone',
        // v0.1.31: mirrored so the app can tell "client mode, not yet pointed
        // at a server" apart from "client mode, server unreachable". The first
        // is a setup step, the second is a fault, and they need different words.
        clientServerUrl: cfg?.clientServerUrl ?? '',
      });
    },
  };
}
