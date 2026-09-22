import { useCallback, useState } from 'react';
import { Button, Input, Select } from '../../components/ui.jsx';
import { fallbackFamilies, listSystemFonts } from '../../lib/systemFonts.js';

const CUSTOM = '__custom__';

/**
 * v0.1.57: font family picker backed by the fonts installed on this Mac.
 *
 * Before this the field was a free-text input with a placeholder, so the user
 * had to know a font's exact name and spelling — and a typo silently fell back
 * to the browser default. The system list is read lazily: the API needs a user
 * gesture, so it loads when the dropdown is first opened. A font stack that is
 * not a single installed family (legacy templates carry e.g.
 * "Inter, Helvetica Neue, Arial, sans-serif") is kept as-is and can still be
 * edited through "Custom stack…".
 */
export function FontFamilyPicker({ id, value, onChange, disabled = false }) {
  const [families, setFamilies] = useState(null); // null = not read yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [custom, setCustom] = useState(false);

  const current = String(value ?? '').trim();
  const list = families ?? [];
  const known = list.some((f) => f.toLowerCase() === current.toLowerCase());
  const isStack = current.includes(','); // legacy multi-family value
  const showCustom = custom || isStack;

  const load = useCallback(async () => {
    if (families || loading) return;
    setLoading(true);
    setError(null);
    try {
      const installed = await listSystemFonts();
      if (installed && installed.length) {
        setFamilies(installed);
      } else {
        setFamilies(fallbackFamilies());
        setError('System font list unavailable — showing common fonts.');
      }
    } catch (err) {
      setFamilies(fallbackFamilies());
      setError(err?.message || 'Could not read the system font list.');
    } finally {
      setLoading(false);
    }
  }, [families, loading]);

  if (showCustom) {
    return (
      <div className="font-family-field">
        <Input
          id={id}
          value={value ?? ''}
          disabled={disabled}
          placeholder="Inter, Helvetica Neue, Arial, sans-serif"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          variant="ghost"
          disabled={disabled}
          onMouseDown={() => { void load(); }}
          onClick={() => { setCustom(false); if (!isStack) onChange(current); }}
          title="Pick from the fonts installed on this Mac"
        >
          Pick from list
        </Button>
      </div>
    );
  }

  return (
    <div className="font-family-field">
      <Select
        id={id}
        value={known ? current : (current ? CUSTOM : '')}
        disabled={disabled}
        onMouseDown={() => { void load(); }}
        onFocus={() => { void load(); }}
        onChange={(e) => {
          if (e.target.value === CUSTOM) { setCustom(true); return; }
          onChange(e.target.value);
        }}
      >
        {!current ? <option value="">{loading ? 'Loading fonts…' : 'Choose a font…'}</option> : null}
        {current && !known ? <option value={CUSTOM}>{`${current} (custom)`}</option> : null}
        {list.map((f) => <option key={f} value={f}>{f}</option>)}
        <option value={CUSTOM}>Custom stack…</option>
      </Select>
      {error ? <span className="field__hint">{error}</span> : null}
    </div>
  );
}
