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
  /* v0.1.61: the value the user clicked "Pick from list" for.
   *
   * `custom` alone could not switch the field out of free-text mode, because a
   * legacy (or just-created) template carries a font STACK — "Inter, Helvetica
   * Neue, Arial, sans-serif" — and `isStack` forced the text input to stay, so
   * the button looked dead on every new template and the list of installed
   * fonts was unreachable. Tracking which value the user asked to browse also
   * means switching to another element falls back to the plain text view. */
  const [listFor, setListFor] = useState(null);

  const current = String(value ?? '').trim();
  const list = families ?? [];
  const known = list.some((f) => f.toLowerCase() === current.toLowerCase());
  const isStack = current.includes(','); // legacy multi-family value
  const showCustom = custom || (isStack && listFor !== current);

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
          /* load() here too: the button is reachable by keyboard, and Enter
           * fires click without any mousedown. */
          onClick={() => { void load(); setCustom(false); setListFor(current); if (!isStack) onChange(current); }}
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
