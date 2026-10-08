import { useEffect, useRef, useState } from 'react';
import { Input } from '../../components/ui.jsx';

/** The text a number field shows for a value. */
export function numberDraft(value) {
  return value == null || Number.isNaN(Number(value)) ? '' : String(value);
}

/**
 * What a typed draft commits as, or null when it should be thrown away (the
 * field then snaps back to the current value). Empty and non-numbers are
 * thrown away; the rest is rounded (when `integer`) and clamped.
 */
export function parseNumberDraft(raw, { min, max, integer = false } = {}) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  let n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (integer) n = Math.round(n);
  if (min != null && n < Number(min)) n = Number(min);
  if (max != null && n > Number(max)) n = Number(max);
  return n;
}

/**
 * A number input that commits on blur or Enter — never on each keystroke.
 *
 * The label screens used `onChange={(e) => set(Number(e.target.value))}`, so
 * clearing a field to type "12" committed 0 first: the label shrank to 0 mm,
 * an element jumped to the corner, a margin printed as 0. The draft lives
 * here until the user is done; Esc puts the current value back. Same idea as
 * Overlay Studio's CanvasDimensionInput.
 */
export function NumberField({ value, onCommit, min, max, integer = false, onKeyDown, onBlur, onFocus, ...rest }) {
  const [draft, setDraft] = useState(numberDraft(value));
  const focused = useRef(false);
  // Follow outside changes (undo, a canvas drag, another Mac) unless the user
  // is typing in this field right now.
  useEffect(() => { if (!focused.current) setDraft(numberDraft(value)); }, [value]);

  function commit() {
    const next = parseNumberDraft(draft, { min, max, integer });
    if (next == null) { setDraft(numberDraft(value)); return; }
    setDraft(numberDraft(next));
    if (next !== Number(value)) onCommit(next);
  }

  return (
    <Input
      type="number"
      min={min}
      max={max}
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => { focused.current = true; onFocus?.(e); }}
      onBlur={(e) => { focused.current = false; commit(); onBlur?.(e); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); setDraft(numberDraft(value)); }
        onKeyDown?.(e);
      }}
    />
  );
}
