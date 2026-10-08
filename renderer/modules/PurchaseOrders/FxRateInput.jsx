import { useEffect, useRef, useState } from 'react';
import { Input } from '../../components/ui.jsx';
import { quotesPerUsd, fxPlaceholder, perUsdText, parseRateInput } from './fxRate.js';

/**
 * A rate input that asks in the natural direction for the currency and
 * always reports `exchangeRateToUsd` through `onChange` (a number, or ''
 * while the box does not hold a positive number). For per-USD currencies the
 * typed text is kept as a local draft so "4100" does not turn into
 * "4099.9999" on the round trip.
 */
export function FxRateInput({ currency, value, onChange, ...rest }) {
  const perUsd = quotesPerUsd(currency);
  const [draft, setDraft] = useState(() => (perUsd ? perUsdText(value) : ''));
  const sent = useRef(value);
  const lastPerUsd = useRef(perUsd);

  useEffect(() => {
    // Re-seed the draft when the currency direction flips, or when the value
    // changed from outside (another Mac, a refresh) rather than from typing.
    const flipped = lastPerUsd.current !== perUsd;
    lastPerUsd.current = perUsd;
    if (!perUsd) return;
    if (flipped || Number(value) !== Number(sent.current)) {
      sent.current = value;
      setDraft(perUsdText(value));
    }
  }, [perUsd, value]);

  if (!perUsd) {
    return (
      <Input
        type="number"
        min="0"
        step="any"
        placeholder={fxPlaceholder(currency)}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    );
  }
  return (
    <Input
      type="number"
      min="0"
      step="any"
      placeholder={fxPlaceholder(currency)}
      value={draft}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const rate = parseRateInput(currency, text);
        sent.current = rate;
        onChange(rate);
      }}
      {...rest}
    />
  );
}
