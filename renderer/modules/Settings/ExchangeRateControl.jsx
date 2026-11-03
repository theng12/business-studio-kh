import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Input } from '../../components/ui.jsx';
import { useUserCaps } from '../../components/Sidebar.jsx';
import { formatRate, validRate } from '../../lib/exchangeRate.js';

const MIN_KHR_PER_USD = 100;
const MAX_KHR_PER_USD = 100000;

/**
 * Settings → General "Exchange rate: 1 USD = [4,100] KHR".
 *
 * The rate belongs to the ACTIVE COMPANY (fx:getShared / fx:setShared), not to
 * this Mac, so every screen and every connected Mac reads the same figure. The
 * typed text is a local draft; it is saved on blur or Enter, only when it is a
 * number inside the shared 100–100,000 band. Loading and load failures are
 * shown in place — a failed read never falls back to a made-up number.
 */
export function ExchangeRateControl() {
  const rate = useAppStore((s) => s.houseKhrPerUsd);
  const loading = useAppStore((s) => s.houseRateLoading);
  const loadError = useAppStore((s) => s.houseRateError);
  const activeCompanyId = useAppStore((s) => s.activeCompanyId);
  const companies = useAppStore((s) => s.companies);
  const setHouseExchangeRate = useAppStore((s) => s.setHouseExchangeRate);
  const addToast = useAppStore((s) => s.addToast);
  const caps = useUserCaps();

  const company = (companies || []).find((c) => c.id === activeCompanyId) || null;
  // The server allows the owner only ('*'), so the control offers the field to
  // the owner alone — a refusal is better than a rejected save.
  const canEdit = caps == null || (Array.isArray(caps) && caps.includes('*'));
  const [draft, setDraft] = useState(() => formatRate(rate));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(formatRate(rate)); setError(''); }, [rate]);

  async function commit() {
    const next = validRate(draft);
    if (next == null) { setError('Enter a number above 0, e.g. 4100.'); return; }
    if (next < MIN_KHR_PER_USD || next > MAX_KHR_PER_USD) {
      setError(`Enter a rate between ${formatRate(MIN_KHR_PER_USD)} and ${formatRate(MAX_KHR_PER_USD)} KHR per USD.`);
      return;
    }
    setError('');
    if (next === rate) { setDraft(formatRate(rate)); return; }
    try {
      await setHouseExchangeRate(next);
      addToast(`Exchange rate saved: 1 USD = ${formatRate(next)} KHR`, 'success');
    } catch (e) {
      addToast(e.message, 'error');
      setDraft(formatRate(rate));
    }
  }

  return (
    <>
      <div className="setting-control-row exchange-rate-control">
        <span>1 USD =</span>
        <Input
          inputMode="decimal"
          value={draft}
          invalid={!!error}
          disabled={!canEdit || !company || loading}
          placeholder={loading ? 'Loading…' : '4,100'}
          aria-label="Riel per US dollar"
          aria-invalid={error ? 'true' : undefined}
          onChange={(e) => { setDraft(e.target.value); setError(''); }}
          onBlur={() => { void commit(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) { e.preventDefault(); void commit(); } }}
        />
        <span>KHR</span>
      </div>
      {company
        ? <div className="setting-row__hint">Applies to {company.name}. Every Mac connected to this company reads it.</div>
        : <div className="setting-row__hint">Choose a company first.</div>}
      {loading ? <div className="setting-row__hint">Loading the company rate…</div> : null}
      {loadError ? <div className="field__error" role="alert">{loadError}</div> : null}
      {!canEdit && company ? <div className="setting-row__hint">Only the owner or an administrator can change it.</div> : null}
      {error ? <div className="field__error" role="alert">{error}</div> : null}
    </>
  );
}
