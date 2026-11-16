/**
 * Trade Finance — the context and live-update hooks shared by the screens.
 *
 * A company switch clears the old context immediately, and an answer that
 * arrives for a company the user has left is dropped — the same rule the
 * Finance screens follow, so the previous company's credit lines can never
 * show under the new one.
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/index.js';

const EMPTY = {
  companyId: null,
  permissions: { canView: false, canManage: false },
  today: '',
  banks: [],
  facilities: [],
  loaded: false,
  error: '',
};

/** Bumps when this company's Trade Finance data changes (debounced 250 ms). */
export function useTradeTick() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = window.api?.trade?.onChanged;
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

export function useTradeContext() {
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const tick = useTradeTick();
  const [state, setState] = useState(EMPTY);
  const req = useRef(0);
  const companyRef = useRef(activeCompanyId);

  useEffect(() => {
    if (companyRef.current !== activeCompanyId) {
      companyRef.current = activeCompanyId;
      setState(EMPTY);
    }
    const r = ++req.current;
    if (!activeCompanyId || !window.api?.trade?.context) {
      setState((s) => ({ ...s, loaded: true }));
      return undefined;
    }
    window.api.trade.context()
      .then((ctx) => {
        if (r !== req.current || companyRef.current !== activeCompanyId) return;
        setState({
          companyId: ctx?.companyId ?? activeCompanyId,
          permissions: ctx?.permissions || EMPTY.permissions,
          today: ctx?.today || '',
          banks: ctx?.banks || [],
          facilities: ctx?.facilities || [],
          loaded: true,
          error: '',
        });
      })
      .catch((err) => {
        if (r !== req.current) return;
        setState((s) => ({ ...s, loaded: true, error: err?.message || 'Could not load Trade Finance.' }));
      });
    return undefined;
  }, [activeCompanyId, tick]);

  return state;
}
