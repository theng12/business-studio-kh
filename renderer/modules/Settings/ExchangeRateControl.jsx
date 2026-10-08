import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/index.js';
import { Input } from '../../components/ui.jsx';
import { formatRate, validRate } from '../../lib/exchangeRate.js';

/**
 * 0.1.95: Settings → General "Exchange rate: 1 USD = [4,100] KHR".
 * The typed text is a local draft; it is saved on blur or Enter, and only when
 * it is a number above 0 (the main process checks the same rule).
 */
export function ExchangeRateControl() {
  const rate = useAppStore((s) => s.houseKhrPerUsd);
  const setHouseExchangeRate = useAppStore((s) => s.setHouseExchangeRate);
  const addToast = useAppStore((s) => s.addToast);
  const [draft, setDraft] = useState(() => formatRate(rate));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(formatRate(rate)); setError(''); }, [rate]);

  async function commit() {
    const next = validRate(draft);
    if (next == null) { setError('Enter a number above 0, e.g. 4100.'); return; }
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
    <div>
      <div className="setting-control-row exchange-rate-control">
        <span>1 USD =</span>
        <Input
          inputMode="decimal"
          value={draft}
          invalid={!!error}
          aria-label="Riel per US dollar"
          aria-invalid={error ? 'true' : undefined}
          onChange={(e) => { setDraft(e.target.value); setError(''); }}
          onBlur={() => { void commit(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) { e.preventDefault(); void commit(); } }}
        />
        <span>KHR</span>
      </div>
      {error ? <div className="field__error" role="alert">{error}</div> : null}
    </div>
  );
}
