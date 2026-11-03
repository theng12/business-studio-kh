/**
 * Finance — React hooks shared by the three Finance screens.
 *
 *   useFinanceContext()   the branches, categories, accounts, settings and
 *                          permissions for the active company. Reloaded on a
 *                          company switch, on a reconnect and on any
 *                          `finance:changed` event, and every answer that
 *                          belongs to a company the user has left is dropped.
 *   useFinanceTick()      a counter that goes up when Finance data changes.
 *   useReceiptUrl(id)     the receipt photo, read through the permission-
 *                          checked `finance:getReceipt` (never app-image://).
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';

const EMPTY_CONTEXT = {
  companyId: null,
  branches: [],
  categories: [],
  accounts: [],
  settings: null,
  permissions: { canRecord: false, canViewAll: false, canManage: false, canApprove: false },
  recordBranchIds: null,
  rate: null,
  loaded: false,
  error: '',
};

/** Bumps when the active company's Finance data changes (debounced 250 ms). */
export function useFinanceTick() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = window.api?.finance?.onChanged;
    if (typeof on !== 'function') return undefined;
    let timer = null;
    const off = on((evt) => {
      if (evt?.companyId && activeCompanyId && evt.companyId !== activeCompanyId) return;
      clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), 250);
    });
    return () => { clearTimeout(timer); if (typeof off === 'function') off(); };
  }, [activeCompanyId]);
  return tick;
}

/**
 * The Finance context for the active company.
 *
 * A company switch drops the old context immediately — the old company's
 * branches, accounts and balances must never show while the new one loads —
 * and an answer that arrives for a company the user has left is ignored.
 */
export function useFinanceContext() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const tick = useFinanceTick();
  const [state, setState] = useState(EMPTY_CONTEXT);
  const req = useRef(0);
  const companyRef = useRef(activeCompanyId);

  useEffect(() => {
    if (companyRef.current !== activeCompanyId) {
      companyRef.current = activeCompanyId;
      setState(EMPTY_CONTEXT);
    }
    const r = ++req.current;
    if (!activeCompanyId || !window.api?.finance?.context) {
      setState((s) => ({ ...s, loaded: true }));
      return undefined;
    }
    Promise.all([
      window.api.finance.context(),
      // The shared KHR rate, only to show hints (the server still decides).
      window.api.fx?.getShared ? window.api.fx.getShared().catch(() => null) : Promise.resolve(null),
    ])
      .then(([ctx, rate]) => {
        if (r !== req.current) return;
        if (companyRef.current !== activeCompanyId) return;
        setState({
          companyId: ctx?.companyId ?? activeCompanyId,
          branches: ctx?.branches || [],
          categories: ctx?.categories || [],
          accounts: ctx?.accounts || [],
          settings: ctx?.settings || null,
          permissions: ctx?.permissions || EMPTY_CONTEXT.permissions,
          recordBranchIds: ctx?.recordBranchIds ?? null,
          rate: rate && rate.khrPerUsd ? rate : null,
          loaded: true,
          error: '',
        });
      })
      .catch((err) => {
        if (r !== req.current) return;
        setState((s) => ({ ...s, loaded: true, error: err?.message || 'Could not load Finance.' }));
      });
    return undefined;
  }, [activeCompanyId, tick]);

  return state;
}

/**
 * The receipt photo as a data URL, read through the permission-checked
 * `finance:getReceipt`. `null` when the expense has no receipt.
 */
export function useReceiptUrl(expenseId, { enabled = true } = {}) {
  const [state, setState] = useState({ url: null, error: '', loading: false });
  useEffect(() => {
    if (!enabled || !expenseId) { setState({ url: null, error: '', loading: false }); return undefined; }
    let alive = true;
    setState({ url: null, error: '', loading: true });
    window.api.finance.getReceipt(expenseId)
      .then((res) => {
        if (!alive) return;
        setState({ url: res?.dataUrl || null, error: '', loading: false });
      })
      .catch((err) => {
        if (!alive) return;
        setState({ url: null, error: err?.message || 'Could not load the receipt photo.', loading: false });
      });
    return () => { alive = false; };
  }, [expenseId, enabled]);
  return state;
}
